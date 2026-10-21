// A simulated companion radio, for demo mode and tests. Replies use the same layouts as firmware
// v1.18.0, so the UI and parsers see what a real device would send.

import { ByteReader, ByteWriter, fromHex } from '../bytes.ts'
import { AdvType, Cmd, ErrCode, Push, Resp, StatsType } from '../codes.ts'
import { encodeFrame, FrameDecoder, TO_RADIO } from '../framing.ts'
import type { Transport, TransportSink } from '../client.ts'

interface MockContact {
  key: string
  name: string
  type: number
  pathLen: number
  lastAdvert: number
  lat: number
  lon: number
}

const DEMO_KEY = '3a7f1c9e5b2d8a4f6e0c1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a'

export interface MockOptions {
  /** emit a fake received-packet log every few seconds */
  rxLog?: boolean
}

export class MockRadioTransport implements Transport {
  readonly label = 'demo radio'
  private sink: TransportSink | null = null
  private readonly decoder = new FrameDecoder()
  private readonly started = Date.now()
  private readonly options: MockOptions
  private rxTimer: ReturnType<typeof setTimeout> | null = null
  private received = 0

  private name = 'Demo Node'
  private radio = { freq: 910.525, bw: 62.5, sf: 7, cr: 5 }
  private tx = 22
  private cli: Record<string, string> = {
    af: '1.0',
    rxdelay: '0.0',
    txdelay: '0.5',
    'direct.txdelay': '0.2',
    'agc.reset.interval': '0',
    'int.thresh': '0',
    cad: 'off',
    dutycycle: '100.0%',
    'multi.acks': '0',
    'path.hash.mode': '0',
    'radio.rxgain': 'on',
    'tz.offset': '0',
  }
  private readonly contacts: MockContact[] = [
    { key: 'a1'.repeat(32), name: 'Hilltop Repeater', type: AdvType.Repeater, pathLen: 0xff, lastAdvert: 0, lat: 30.2849, lon: -97.7341 },
    { key: 'b2'.repeat(32), name: 'Downtown Room', type: AdvType.Room, pathLen: 2, lastAdvert: 0, lat: 0, lon: 0 },
    { key: 'c3'.repeat(32), name: 'Alex 📡', type: AdvType.Chat, pathLen: 1, lastAdvert: 0, lat: 0, lon: 0 },
  ]

  constructor(options: MockOptions = {}) {
    this.options = options
  }

  async open(sink: TransportSink): Promise<void> {
    this.sink = sink
    const now = this.now()
    this.contacts.forEach((c, i) => (c.lastAdvert = now - 600 * (i + 1)))
    if (this.options.rxLog) this.scheduleRx()
  }

  async close(): Promise<void> {
    if (this.rxTimer) clearTimeout(this.rxTimer)
    this.rxTimer = null
    this.sink = null
  }

  async write(data: Uint8Array): Promise<void> {
    // frames to the radio use '<', which FrameDecoder expects as '>': flip the marker byte
    const flipped = Uint8Array.from(data, (b, i) => (i === 0 && b === TO_RADIO ? 0x3e : b))
    for (const cmd of this.decoder.push(flipped)) {
      // reply asynchronously, like a real radio
      setTimeout(() => this.handle(cmd), 5)
    }
  }

  private now(): number {
    return Math.floor(Date.now() / 1000)
  }

  private send(payload: Uint8Array): void {
    const frame = encodeFrame(payload)
    frame[0] = 0x3e // radio -> app marker
    this.sink?.onData(frame)
  }

  private err(code: number): void {
    this.send(Uint8Array.of(Resp.Err, code))
  }

  private handle(cmd: Uint8Array): void {
    const w = () => new ByteWriter()
    switch (cmd[0]) {
      case Cmd.DeviceQuery:
        return this.send(
          w().u8(Resp.DeviceInfo).u8(14).u8(175).u8(40).u32(0)
            .fixedString('21-Oct-2026', 12).fixedString('Demo Board', 40).fixedString('v1.18.0-demo', 20)
            .u8(0).u8(0).toBytes(),
        )
      case Cmd.AppStart:
        return this.send(
          w().u8(Resp.SelfInfo).u8(AdvType.Chat).u8(this.tx).u8(22).bytes(fromHex(DEMO_KEY))
            .u32(30267153).u32(-97743057).u8(0).u8(0).u8(0).u8(0)
            .u32(Math.round(this.radio.freq * 1000)).u32(Math.round(this.radio.bw * 1000)).u8(this.radio.sf).u8(this.radio.cr)
            .string(this.name).toBytes(),
        )
      case Cmd.GetBattAndStorage:
        return this.send(w().u8(Resp.BattAndStorage).u16(3987).u32(6).u32(3169).toBytes())
      case Cmd.GetDeviceTime:
        return this.send(w().u8(Resp.CurrTime).u32(this.now()).toBytes())
      case Cmd.GetStats:
        return this.stats(cmd[1])
      case Cmd.GetContacts:
        this.send(w().u8(Resp.ContactsStart).u32(this.contacts.length).toBytes())
        for (const c of this.contacts) {
          this.send(
            w().u8(Resp.Contact).bytes(fromHex(c.key)).u8(c.type).u8(0).u8(c.pathLen)
              .bytes(new Uint8Array(64).fill(0x5a, 0, c.pathLen === 0xff ? 0 : c.pathLen))
              .fixedString(c.name, 32).u32(c.lastAdvert).u32(Math.round(c.lat * 1e6)).u32(Math.round(c.lon * 1e6))
              .u32(c.lastAdvert).toBytes(),
          )
        }
        return this.send(w().u8(Resp.EndOfContacts).u32(this.now()).toBytes())
      case Cmd.GetChannel: {
        const idx = cmd[1]
        if (idx >= 40) return this.err(ErrCode.NotFound)
        const ch = w().u8(Resp.ChannelInfo).u8(idx)
        if (idx === 0) ch.fixedString('Public', 32).bytes(fromHex('8b3387e9c5cdea6ac9e5edbaa115cd72'))
        else if (idx === 1) ch.fixedString('#austin', 32).bytes(fromHex('d1c4a3b2f0e9d8c7b6a5948372615041'))
        else ch.fixedString('', 32).bytes(new Uint8Array(16))
        return this.send(ch.toBytes())
      }
      case Cmd.GetCustomVars:
        return this.send(w().u8(Resp.CustomVars).string('gps:0').toBytes())
      case Cmd.GetTuningParams:
        return this.send(w().u8(Resp.TuningParams).u32(0).u32(1000).toBytes())
      case Cmd.GetAutoaddConfig:
        return this.send(w().u8(Resp.AutoaddConfig).u8(0).u8(0).toBytes())
      case Cmd.GetDefaultFloodScope:
        return this.send(Uint8Array.of(Resp.DefaultFloodScope))
      case Cmd.RunCliCommand: {
        const reply = this.runCli(new ByteReader(cmd, 1).restString())
        if (reply !== null) this.send(w().u8(Resp.CliReply).string(reply).toBytes())
        return
      }
      default:
        return this.err(ErrCode.UnsupportedCmd)
    }
  }

  private stats(type: number): void {
    const w = new ByteWriter().u8(Resp.Stats).u8(type)
    if (type === StatsType.Core) w.u16(3987).u32(Math.floor((Date.now() - this.started) / 1000) + 3600).u16(0).u8(0)
    else if (type === StatsType.Radio) w.u16(-108).u8(-71).u8(28).u32(12).u32(340)
    else if (type === StatsType.Packets) w.u32(this.received).u32(9).u32(6).u32(3).u32(Math.floor(this.received * 0.8)).u32(Math.floor(this.received * 0.2)).u32(1)
    else return this.err(ErrCode.IllegalArg)
    this.send(w.toBytes())
  }

  private runCli(text: string): string | null {
    const cmd = text.trim()
    if (cmd === 'ver') return 'v1.18.0-demo (Build: 21-Oct-2026)'
    if (cmd === 'board') return 'Demo Board'
    if (cmd === 'reboot' || cmd === 'poweroff' || cmd === 'shutdown') return null
    if (cmd === 'get name') return `> ${this.name}`
    if (cmd.startsWith('set name ')) {
      this.name = cmd.slice(9)
      return 'OK'
    }
    if (cmd === 'get radio') return `> ${this.radio.freq},${this.radio.bw},${this.radio.sf},${this.radio.cr}`
    if (cmd === 'get freq') return `> ${this.radio.freq}`
    if (cmd === 'get tx') return `> ${this.tx}`
    if (cmd.startsWith('set tx ')) {
      this.tx = Number(cmd.slice(7))
      return 'OK'
    }
    if (cmd === 'get radio.fem.rxgain') return 'Error: unsupported'
    if (cmd.startsWith('get ')) {
      const v = this.cli[cmd.slice(4)]
      return v === undefined ? 'Unknown command' : `> ${v}`
    }
    if (cmd.startsWith('set ')) {
      const [key, ...rest] = cmd.slice(4).split(' ')
      if (!(key in this.cli) || rest.length === 0) return 'Unknown command'
      this.cli[key] = rest.join(' ')
      return 'OK'
    }
    return 'Unknown command'
  }

  private scheduleRx(): void {
    this.rxTimer = setTimeout(() => {
      this.received++
      const types = [0x04, 0x05, 0x02, 0x03, 0x08] // advert, group text, text, ack, path
      const header = (types[Math.floor(Math.random() * types.length)] << 2) | (Math.random() < 0.7 ? 1 : 2)
      const hops = Math.floor(Math.random() * 4)
      const raw = new ByteWriter().u8(header).u8(hops).bytes(Array.from({ length: hops + 20 + Math.floor(Math.random() * 60) }, () => Math.floor(Math.random() * 256))).toBytes()
      const snr = Math.round((Math.random() * 20 - 8) * 4)
      const rssi = -60 - Math.floor(Math.random() * 60)
      this.send(new ByteWriter().u8(Push.LogRxData).u8(snr).u8(rssi).bytes(raw).toBytes())
      this.scheduleRx()
    }, 2500 + Math.random() * 4000)
  }
}
