// A simulated companion radio, for demo mode and tests. Replies use the same layouts as firmware
// v1.18.0, so the UI and parsers see what a real device would send.

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ByteReader, ByteWriter, fromHex, toHex } from '../bytes.ts'
import { AdvType, Cmd, ErrCode, PayloadType, Push, Resp, StatsType, TxtType } from '../codes.ts'
import { channelHash, encryptThenMac, hashtagSecret, PUBLIC_CHANNEL_SECRET } from '../crypto.ts'
import { encodeFrame, FrameDecoder, TO_RADIO } from '../framing.ts'
import type { Transport, TransportSink } from '../client.ts'

interface MockContact {
  key: string
  seed: Uint8Array // Ed25519 seed, so the contact's adverts carry real signatures
  name: string
  type: number
  pathLen: number
  lastAdvert: number
  lat: number
  lon: number
}

const DEMO_KEY = '3a7f1c9e5b2d8a4f6e0c1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a'
/** the radio's two slots; '#hiking' is only on the air, for the analyzer to find a key for */
const CHANNELS = [
  { name: 'Public', secret: fromHex(PUBLIC_CHANNEL_SECRET) },
  { name: '#austin', secret: hashtagSecret('#austin') },
]
const OFF_RADIO_CHANNEL = hashtagSecret('#hiking')
const CHATTER = ['anyone on 910.525 tonight?', 'testing from the hilltop', 'good copy, thanks', 'repeater looks healthy', 'heading out on the trail, will check in later']
const CHANNEL_POSTERS = ['KJ5GFX Bill', 'Driftwood', 'Maya', 'Tom 🚲']

function contact(name: string, type: number, pathLen: number, lat = 0, lon = 0): MockContact {
  const seed = sha256(new TextEncoder().encode(`meshcore-console demo: ${name}`))
  return { key: toHex(ed25519.getPublicKey(seed)), seed, name, type, pathLen, lastAdvert: 0, lat, lon }
}

function groupPayload(secret: Uint8Array, ts: number, text: string): Uint8Array {
  const plain = new ByteWriter().u32(ts).u8(TxtType.Plain << 2).string(text).toBytes()
  return new ByteWriter().u8(channelHash(secret)).bytes(encryptThenMac(secret, plain)).toBytes()
}

export interface MockOptions {
  /** emit a fake received-packet log every few seconds */
  rxLog?: boolean
  /** receive a DM or channel post now and then */
  chatter?: boolean
  /** how far behind real time the radio's clock starts, in seconds */
  clockBehindSecs?: number
  /** messages already waiting in the offline queue when the app connects */
  queuedMessages?: number
  /** share of DMs that get an ACK (default 0.85), and how long it takes in ms (default 900-3400) */
  ackRate?: number
  ackDelayMs?: [number, number]
  /** talk in whole frames with no serial framing, like the Bluetooth link */
  framed?: boolean
}

export class MockRadioTransport implements Transport {
  readonly label = 'demo radio'
  readonly framed: boolean
  private sink: TransportSink | null = null
  private readonly decoder = new FrameDecoder()
  private readonly started = Date.now()
  private readonly options: MockOptions
  private timers: ReturnType<typeof setTimeout>[] = []
  private received = 0
  private clockOffset: number // radio time - real time, secs
  private readonly queue: Uint8Array[] = []

  private name = 'Demo Node'
  private lat = 30.267153
  private lon = -97.743057
  private radio = { freq: 910.525, bw: 62.5, sf: 7, cr: 5 }
  private clientRepeat = false
  private tx = 22
  private pin = 0
  private tuning = { rx: 0, af: 1 }
  private other = { manualAdd: 0, telemetry: 0, advLoc: 0, multiAcks: 0 }
  private autoadd = { flags: 0, maxHops: 0 }
  /** the radio's 40 channel slots; an empty one has no name and an all-zero key */
  private readonly slots: { name: string; secret: Uint8Array }[] = Array.from({ length: 40 }, (_, i) => ({ name: CHANNELS[i]?.name ?? '', secret: CHANNELS[i]?.secret.slice() ?? new Uint8Array(16) }))
  private pathHashMode = 0
  private gps = '0'
  private cli: Record<string, string> = {
    rxdelay: '0.0',
    txdelay: '0.5',
    'direct.txdelay': '0.2',
    'agc.reset.interval': '0',
    'int.thresh': '0',
    cad: 'off',
    dutycycle: '100.0%',
    'radio.rxgain': 'on',
    'tz.offset': '0',
  }
  private readonly contacts: MockContact[] = [
    contact('Hilltop Repeater', AdvType.Repeater, 0xff, 30.2849, -97.7341),
    contact('Downtown Room', AdvType.Room, 2),
    contact('Alex 📡', AdvType.Chat, 1),
    contact('Sam', AdvType.Chat, 0xff),
  ]

  constructor(options: MockOptions = {}) {
    this.options = options
    this.framed = options.framed ?? false
    this.clockOffset = -(options.clockBehindSecs ?? 0)
  }

  async open(sink: TransportSink): Promise<void> {
    this.sink = sink
    const now = this.now()
    this.contacts.forEach((c, i) => (c.lastAdvert = now - 600 * (i + 1)))
    for (let i = 0; i < (this.options.queuedMessages ?? 0); i++) this.receiveChatter(false, 3600 - i * 600)
    if (this.options.rxLog) this.every(2500, 6500, () => this.receivePacket())
    if (this.options.chatter) this.every(20000, 40000, () => this.receiveChatter(true))
  }

  async close(): Promise<void> {
    this.timers.forEach(clearTimeout)
    this.timers = []
    this.sink = null
  }

  async write(data: Uint8Array): Promise<void> {
    // frames to the radio use '<', which FrameDecoder expects as '>': flip the marker byte
    const cmds = this.framed ? [data.slice()] : this.decoder.push(Uint8Array.from(data, (b, i) => (i === 0 && b === TO_RADIO ? 0x3e : b)))
    for (const cmd of cmds) {
      this.later(5, () => this.handle(cmd)) // reply asynchronously, like a real radio
    }
  }

  // ---- plumbing ----

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(() => this.sink && fn(), ms))
  }

  private every(minMs: number, maxMs: number, fn: () => void): void {
    this.later(minMs + Math.random() * (maxMs - minMs), () => {
      fn()
      this.every(minMs, maxMs, fn)
    })
  }

  private now(): number {
    return Math.floor(Date.now() / 1000) + this.clockOffset
  }

  private send(payload: Uint8Array): void {
    if (this.framed) {
      this.sink?.onData(payload)
      return
    }
    const frame = encodeFrame(payload)
    frame[0] = 0x3e // radio -> app marker
    this.sink?.onData(frame)
  }

  private ok(): void {
    this.send(Uint8Array.of(Resp.Ok))
  }

  private err(code: number): void {
    this.send(Uint8Array.of(Resp.Err, code))
  }

  // ---- incoming traffic ----

  private receiveChatter(notify: boolean, agoSecs = 0): void {
    const text = CHATTER[Math.floor(Math.random() * CHATTER.length)]
    const snr = Math.round((Math.random() * 16 - 4) * 4)
    const ts = this.now() - agoSecs
    if (Math.random() < 0.35) {
      const from = this.contacts[2]
      this.queueDirect(from, text, ts, snr)
    } else {
      const named = this.slots.filter((slot) => slot.name)
      if (!named.length) return
      const { secret } = named[Math.floor(Math.random() * named.length)]
      const post = `${CHANNEL_POSTERS[Math.floor(Math.random() * CHANNEL_POSTERS.length)]}: ${text}`
      const hops = Math.floor(Math.random() * 4)
      this.deliverGroup(secret, ts, post, hops, snr)
      if (notify && this.options.rxLog) this.hear(this.flood(PayloadType.GrpTxt, groupPayload(secret, ts, post), hops))
    }
    if (notify) this.send(Uint8Array.of(Push.MsgWaiting))
  }

  /** What the firmware does with a channel post it can open: queue it under the first named slot with that key. */
  private deliverGroup(secret: Uint8Array, ts: number, text: string, hops: number, snr: number): boolean {
    const idx = this.slots.findIndex((slot) => slot.name && toHex(slot.secret) === toHex(secret))
    if (idx < 0) return false
    this.queue.push(
      new ByteWriter().u8(Resp.ChannelMsgRecvV3).u8(snr).u16(0).u8(idx).u8(hops).u8(TxtType.Plain).u32(ts).string(text).toBytes(),
    )
    return true
  }

  private queueDirect(from: MockContact, text: string, ts: number, snr: number): void {
    this.queue.push(
      new ByteWriter().u8(Resp.ContactMsgRecvV3).u8(snr).u16(0).bytes(fromHex(from.key).slice(0, 6))
        .u8(from.pathLen === 0xff ? 2 : 0xff).u8(TxtType.Plain).u32(ts).string(text).toBytes(),
    )
  }

  /** Background traffic: what a radio hears on a busy mesh, encrypted and signed like the real thing. */
  private receivePacket(): void {
    const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]
    const roll = Math.random()
    const two = () => {
      const [a, b] = [...this.contacts].sort(() => Math.random() - 0.5)
      return [fromHex(a.key)[0], fromHex(b.key)[0]]
    }
    const sealed = (n: number) => Uint8Array.from({ length: 2 + 16 * n }, () => Math.floor(Math.random() * 256))
    let raw: Uint8Array
    if (roll < 0.3) {
      const off = Math.random() < 0.3
      const secret = off ? OFF_RADIO_CHANNEL : pick(CHANNELS).secret
      const text = off ? `${pick(['Tom 🚲', 'Rae'])}: ${pick(['trail is muddy past the creek', 'at the overlook, great signal up here'])}` : `${pick(CHANNEL_POSTERS)}: ${pick(CHATTER)}`
      const ts = this.now() - Math.floor(Math.random() * 30)
      const hops = Math.floor(Math.random() * 3)
      raw = this.flood(PayloadType.GrpTxt, groupPayload(secret, ts, text), hops)
      // posts on a channel the radio has a named slot for also reach the app
      if (this.options.chatter && this.deliverGroup(secret, ts, text, hops, Math.round((Math.random() * 16 - 4) * 4))) {
        this.later(50, () => this.send(Uint8Array.of(Push.MsgWaiting)))
      }
    } else if (roll < 0.5) {
      raw = this.flood(PayloadType.Advert, this.advert(pick(this.contacts)))
    } else if (roll < 0.62) {
      raw = this.flood(PayloadType.TxtMsg, new ByteWriter().bytes(two()).bytes(sealed(1 + Math.floor(Math.random() * 3))).toBytes())
    } else if (roll < 0.77) {
      raw = this.flood(PayloadType.Ack, new ByteWriter().u32((Math.random() * 0xffffffff) >>> 0).toBytes())
    } else if (roll < 0.84) {
      raw = this.flood(PayloadType.Path, new ByteWriter().bytes(two()).bytes(sealed(1)).toBytes())
    } else if (roll < 0.9) {
      const snrs = Array.from({ length: 1 + Math.floor(Math.random() * 2) }, () => Math.round((Math.random() * 16 - 4) * 4) & 0xff)
      const payload = new ByteWriter().u32((Math.random() * 0xffffffff) >>> 0).u32(0).u8(0).bytes(two()).toBytes()
      raw = new ByteWriter().u8((PayloadType.Trace << 2) | 2).u8(snrs.length).bytes(snrs).bytes(payload).toBytes()
    } else if (roll < 0.97) {
      const c = this.contacts[0]
      const payload = new ByteWriter().u8(0x90 | c.type).u8(Math.round(Math.random() * 40) & 0xff).u32((Math.random() * 0xffffffff) >>> 0)
        .bytes(fromHex(c.key).slice(0, 8)).toBytes()
      raw = new ByteWriter().u8((PayloadType.Control << 2) | 2).u8(0).bytes(payload).toBytes()
    } else {
      raw = new ByteWriter().u8((PayloadType.Advert << 2) | 1).u8(0).bytes(fromHex(pick(this.contacts).key)).toBytes() // cut short
    }
    this.hear(raw)
    // flood packets get repeated: hear the same packet again, one hop further along
    if (raw[0] === ((raw[0] & 0xfc) | 1) && raw[1] < 3 && Math.random() < 0.35) {
      const again = Uint8Array.from([raw[0], raw[1] + 1, ...raw.subarray(2, 2 + raw[1]), fromHex(this.contacts[0].key)[0], ...raw.subarray(2 + raw[1])])
      this.later(400 + Math.random() * 1400, () => this.hear(again))
    }
  }

  private hear(raw: Uint8Array): void {
    this.received++
    const snr = Math.round((Math.random() * 20 - 8) * 4)
    const rssi = -60 - Math.floor(Math.random() * 60)
    this.send(new ByteWriter().u8(Push.LogRxData).u8(snr).u8(rssi).bytes(raw).toBytes())
  }

  /** a flood packet that came through 0-2 repeaters */
  private flood(type: number, payload: Uint8Array, hops = Math.floor(Math.random() * 3)): Uint8Array {
    const path = Array.from({ length: hops }, (_, i) => (i === hops - 1 ? fromHex(this.contacts[0].key)[0] : Math.floor(Math.random() * 256)))
    return new ByteWriter().u8((type << 2) | 1).u8(hops).bytes(path).bytes(payload).toBytes()
  }

  private advert(c: MockContact): Uint8Array {
    const app = new ByteWriter().u8(c.type | (c.lat || c.lon ? 0x10 : 0) | 0x80)
    if (c.lat || c.lon) app.u32(Math.round(c.lat * 1e6)).u32(Math.round(c.lon * 1e6))
    const appData = app.string(c.name).toBytes().slice(0, 32)
    const signed = new ByteWriter().bytes(fromHex(c.key)).u32(this.now()).toBytes()
    const signature = ed25519.sign(new Uint8Array([...signed, ...appData]), c.seed)
    return new ByteWriter().bytes(signed).bytes(signature).bytes(appData).toBytes()
  }

  // ---- commands ----

  private handle(cmd: Uint8Array): void {
    const w = () => new ByteWriter()
    const r = new ByteReader(cmd, 1)
    switch (cmd[0]) {
      case Cmd.DeviceQuery:
        return this.send(
          w().u8(Resp.DeviceInfo).u8(14).u8(175).u8(40).u32(this.pin)
            .fixedString('21-Oct-2026', 12).fixedString('Demo Board', 40).fixedString('v1.18.0-demo', 20)
            .u8(this.clientRepeat ? 1 : 0).u8(this.pathHashMode).toBytes(),
        )
      case Cmd.AppStart:
        return this.send(
          w().u8(Resp.SelfInfo).u8(AdvType.Chat).u8(this.tx).u8(22).bytes(fromHex(DEMO_KEY))
            .u32(Math.round(this.lat * 1e6)).u32(Math.round(this.lon * 1e6))
            .u8(this.other.multiAcks).u8(this.other.advLoc).u8(this.other.telemetry).u8(this.other.manualAdd)
            .u32(Math.round(this.radio.freq * 1000)).u32(Math.round(this.radio.bw * 1000)).u8(this.radio.sf).u8(this.radio.cr)
            .string(this.name).toBytes(),
        )
      case Cmd.GetBattAndStorage:
        return this.send(w().u8(Resp.BattAndStorage).u16(3987).u32(6).u32(3169).toBytes())
      case Cmd.GetDeviceTime:
        return this.send(w().u8(Resp.CurrTime).u32(this.now()).toBytes())
      case Cmd.SetDeviceTime: {
        const secs = r.u32()
        if (secs < this.now()) return this.err(ErrCode.IllegalArg) // the firmware only moves forward
        this.clockOffset = secs - Math.floor(Date.now() / 1000)
        return this.ok()
      }
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
        return this.send(w().u8(Resp.ChannelInfo).u8(idx).fixedString(this.slots[idx].name, 32).bytes(this.slots[idx].secret).toBytes())
      }
      case Cmd.SetChannel: {
        if (cmd.length >= 2 + 32 + 32) return this.err(ErrCode.UnsupportedCmd) // 256-bit keys: not supported (yet)
        if (cmd.length < 2 + 32 + 16) return this.err(ErrCode.UnsupportedCmd)
        const idx = r.u8()
        if (idx >= this.slots.length) return this.err(ErrCode.NotFound)
        this.slots[idx] = { name: r.fixedString(32).slice(0, 31), secret: r.take(16) }
        return this.ok()
      }
      case Cmd.SyncNextMessage: {
        const next = this.queue.shift()
        return this.send(next ?? Uint8Array.of(Resp.NoMoreMessages))
      }
      case Cmd.SendTxtMsg:
        return this.sendTxt(r)
      case Cmd.SendChannelTxtMsg: {
        r.u8() // txt type
        const idx = r.u8()
        const ts = r.u32()
        const text = `${this.name}: ${r.restString()}`
        const slot = this.slots[idx]
        if (!slot?.name) return this.err(ErrCode.NotFound)
        // a repeater sends the post back out, so the radio hears its own packet
        if (this.options.rxLog) this.later(900, () => this.hear(this.flood(PayloadType.GrpTxt, groupPayload(slot.secret, ts, text), 1)))
        return this.ok()
      }
      case Cmd.GetCustomVars:
        return this.send(w().u8(Resp.CustomVars).string(`gps:${this.gps}`).toBytes())
      case Cmd.SetCustomVar: {
        const [name, value] = r.restString().split(':')
        if (name !== 'gps' || (value !== '0' && value !== '1')) return this.err(ErrCode.IllegalArg)
        this.gps = value
        return this.ok()
      }
      case Cmd.GetTuningParams:
        return this.send(w().u8(Resp.TuningParams).u32(Math.round(this.tuning.rx * 1000)).u32(Math.round(this.tuning.af * 1000)).toBytes())
      case Cmd.SetTuningParams:
        this.tuning = { rx: r.u32() / 1000, af: r.u32() / 1000 }
        return this.ok()
      case Cmd.GetAutoaddConfig:
        return this.send(w().u8(Resp.AutoaddConfig).u8(this.autoadd.flags).u8(this.autoadd.maxHops).toBytes())
      case Cmd.SetAutoaddConfig:
        this.autoadd = { flags: r.u8(), maxHops: Math.min(r.u8(), 64) }
        return this.ok()
      case Cmd.GetDefaultFloodScope:
        return this.send(Uint8Array.of(Resp.DefaultFloodScope))
      case Cmd.SetAdvertName:
        this.name = r.restString().slice(0, 31)
        return this.ok()
      case Cmd.SetAdvertLatLon: {
        const lat = r.i32()
        const lon = r.i32()
        if (Math.abs(lat) > 90e6 || Math.abs(lon) > 180e6) return this.err(ErrCode.IllegalArg)
        this.lat = lat / 1e6
        this.lon = lon / 1e6
        return this.ok()
      }
      case Cmd.SetRadioParams: {
        const freq = r.u32()
        const bw = r.u32()
        const sf = r.u8()
        const cr = r.u8()
        const repeat = r.remaining ? r.u8() : 0
        if (freq < 150000 || freq > 2500000 || sf < 5 || sf > 12 || cr < 5 || cr > 8 || bw < 7000 || bw > 500000) return this.err(ErrCode.IllegalArg)
        this.radio = { freq: freq / 1000, bw: bw / 1000, sf, cr }
        this.clientRepeat = repeat !== 0
        return this.ok()
      }
      case Cmd.SetRadioTxPower: {
        const dbm = r.i8()
        if (dbm < -9 || dbm > 22) return this.err(ErrCode.IllegalArg)
        this.tx = dbm
        return this.ok()
      }
      case Cmd.SetOtherParams:
        this.other.manualAdd = r.u8()
        if (r.remaining) this.other.telemetry = r.u8()
        if (r.remaining) this.other.advLoc = r.u8()
        if (r.remaining) this.other.multiAcks = r.u8()
        return this.ok()
      case Cmd.SetDevicePin: {
        const pin = r.u32()
        if (pin !== 0 && (pin < 100000 || pin > 999999)) return this.err(ErrCode.IllegalArg)
        this.pin = pin
        return this.ok()
      }
      case Cmd.SetPathHashMode: {
        r.u8()
        const mode = r.u8()
        if (mode >= 3) return this.err(ErrCode.IllegalArg)
        this.pathHashMode = mode
        return this.ok()
      }
      case Cmd.RunCliCommand: {
        const reply = this.runCli(r.restString())
        if (reply !== null) this.send(w().u8(Resp.CliReply).string(reply).toBytes())
        return
      }
      default:
        return this.err(ErrCode.UnsupportedCmd)
    }
  }

  private sendTxt(r: ByteReader): void {
    const txtType = r.u8()
    r.u8() // attempt
    r.u32() // timestamp
    const prefix = toHex(r.take(6))
    const text = r.restString()
    const to = this.contacts.find((c) => c.key.startsWith(prefix))
    if (!to) return this.err(ErrCode.NotFound)
    if (txtType !== TxtType.Plain) return this.err(ErrCode.UnsupportedCmd)
    const ack = (Math.random() * 0xffffffff) >>> 0
    const flood = to.pathLen === 0xff
    this.send(new ByteWriter().u8(Resp.Sent).u8(flood ? 1 : 0).u32(ack).u32(flood ? 8000 : 5000).toBytes())
    if (Math.random() < (this.options.ackRate ?? 0.85)) {
      const [lo, hi] = this.options.ackDelayMs ?? [900, 3400]
      const trip = lo + Math.floor(Math.random() * (hi - lo))
      this.later(trip, () => this.send(new ByteWriter().u8(Push.SendConfirmed).u32(ack).u32(trip).toBytes()))
    }
    if (to.name === 'Alex 📡') {
      this.later(4000, () => {
        this.queueDirect(to, text.endsWith('?') ? 'yes, all good here' : '👍 got it', this.now(), 30)
        this.send(Uint8Array.of(Push.MsgWaiting))
      })
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
    if (cmd === 'get af') return `> ${this.tuning.af}`
    if (cmd === 'get multi.acks') return `> ${this.other.multiAcks}`
    if (cmd === 'get path.hash.mode') return `> ${this.pathHashMode}`
    if (cmd === 'get radio.fem.rxgain' || cmd.startsWith('set radio.fem.rxgain ')) return 'Error: unsupported'
    if (cmd.startsWith('get ')) {
      const v = this.cli[cmd.slice(4)]
      return v === undefined ? 'Unknown command' : `> ${v}`
    }
    if (cmd.startsWith('set ')) {
      const [key, ...rest] = cmd.slice(4).split(' ')
      if (!(key in this.cli) || rest.length === 0) return 'Unknown command'
      this.cli[key] = key === 'dutycycle' ? `${Number(rest[0]).toFixed(1)}%` : rest.join(' ')
      return key === 'dutycycle' ? `OK - ${this.cli[key]}` : 'OK'
    }
    return 'Unknown command'
  }
}
