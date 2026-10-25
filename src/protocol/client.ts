// Request/response client for the companion protocol.
//
// The protocol has no request ids: the radio answers commands in order with codes below 0x80, and
// sends pushes (0x80+) whenever it likes. So requests run one at a time, and each one names the reply
// codes it is waiting for. Anything else that arrives meanwhile is reported as unsolicited.

import { MAX_CHANNEL_NAME_BYTES, nameBytes } from './channels.ts'
import { ERR_CODE_NAMES, ErrCode, Push, Resp, StatsType } from './codes.ts'
import { encodeFrame, FrameDecoder } from './framing.ts'
import {
  commands,
  parseAutoaddConfig,
  parseBattAndStorage,
  parseChannelInfo,
  parseCliReply,
  parseContact,
  parseCoreStats,
  parseCurrTime,
  parseCustomVars,
  parseDefaultFloodScope,
  parseDeviceInfo,
  parseErrCode,
  parseIncomingMessage,
  parseSent,
  parsePacketStats,
  parseRadioStats,
  parseSelfInfo,
  parseTuningParams,
  type AutoaddConfig,
  type BattAndStorage,
  type ChannelInfo,
  type Contact,
  type CoreStats,
  type DeviceInfo,
  type FloodScope,
  type IncomingMessage,
  type OtherParams,
  type PacketStats,
  type RadioParams,
  type SentInfo,
  type RadioStats,
  type SelfInfo,
  type TuningParams,
} from './messages.ts'

export interface TransportSink {
  onData(chunk: Uint8Array): void
  onClose(error?: Error): void
}

/** A byte pipe to the radio: WebSerial in the browser, node-serialport in scripts, or a mock. */
export interface Transport {
  readonly label: string
  open(sink: TransportSink): Promise<void>
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

export class MeshCoreError extends Error {
  readonly code: number | undefined

  constructor(code: number | undefined) {
    super(code === undefined ? 'radio returned an error' : `radio error: ${ERR_CODE_NAMES[code] ?? `code ${code}`}`)
    this.name = 'MeshCoreError'
    this.code = code
  }
}

export class TimeoutError extends Error {
  constructor(what: string) {
    super(`no reply to ${what}`)
    this.name = 'TimeoutError'
  }
}

/** Decides what a reply frame means for the pending request. */
type Matcher = (frame: Uint8Array) => 'done' | 'more' | 'skip'

interface Job {
  what: string
  payload: Uint8Array
  match: Matcher
  timeoutMs: number
  resolve: (frames: Uint8Array[]) => void
  reject: (err: Error) => void
}

export interface ClientEvents {
  frameIn: (frame: Uint8Array) => void
  frameOut: (frame: Uint8Array) => void
  push: (frame: Uint8Array) => void
  unsolicited: (frame: Uint8Array) => void
  close: (error?: Error) => void
}

const codeIs =
  (...codes: number[]): Matcher =>
  (f) =>
    codes.includes(f[0]) ? 'done' : 'skip'

export const APP_PROTOCOL_VERSION = 3

const MESSAGE_CODES = [Resp.ContactMsgRecv, Resp.ChannelMsgRecv, Resp.ContactMsgRecvV3, Resp.ChannelMsgRecvV3, Resp.ChannelDataRecv]

const nowSecs = () => Math.floor(Date.now() / 1000)

export class MeshCoreClient {
  private readonly transport: Transport
  private readonly decoder = new FrameDecoder()
  private readonly listeners: { [K in keyof ClientEvents]: Set<ClientEvents[K]> } = {
    frameIn: new Set(),
    frameOut: new Set(),
    push: new Set(),
    unsolicited: new Set(),
    close: new Set(),
  }
  private queue: Job[] = []
  private current: { job: Job; frames: Uint8Array[]; timer: ReturnType<typeof setTimeout> } | null = null
  private open = false

  constructor(transport: Transport) {
    this.transport = transport
  }

  get label(): string {
    return this.transport.label
  }

  get isOpen(): boolean {
    return this.open
  }

  on<K extends keyof ClientEvents>(event: K, listener: ClientEvents[K]): () => void {
    this.listeners[event].add(listener)
    return () => this.listeners[event].delete(listener)
  }

  private emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
    for (const l of this.listeners[event]) (l as (...a: Parameters<ClientEvents[K]>) => void)(...args)
  }

  async connect(): Promise<void> {
    await this.transport.open({
      onData: (chunk) => this.onData(chunk),
      onClose: (err) => this.onTransportClose(err),
    })
    this.open = true
  }

  async disconnect(): Promise<void> {
    if (!this.open) return
    this.open = false
    await this.transport.close()
    this.failAll(new Error('disconnected'))
    this.emit('close')
  }

  private onTransportClose(err?: Error): void {
    if (!this.open) return
    this.open = false
    this.failAll(err ?? new Error('connection closed'))
    this.emit('close', err)
  }

  private failAll(err: Error): void {
    if (this.current) {
      clearTimeout(this.current.timer)
      this.current.job.reject(err)
      this.current = null
    }
    for (const job of this.queue) job.reject(err)
    this.queue = []
  }

  private onData(chunk: Uint8Array): void {
    for (const frame of this.decoder.push(chunk)) {
      this.emit('frameIn', frame)
      if (frame[0] >= 0x80) {
        this.emit('push', frame)
        continue
      }
      this.handleReply(frame)
    }
  }

  private handleReply(frame: Uint8Array): void {
    const cur = this.current
    if (!cur) {
      this.emit('unsolicited', frame)
      return
    }
    if (frame[0] === Resp.Err) {
      this.finish(new MeshCoreError(parseErrCode(frame)))
      return
    }
    const verdict = cur.job.match(frame)
    if (verdict === 'skip') {
      this.emit('unsolicited', frame)
      return
    }
    cur.frames.push(frame)
    if (verdict === 'done') {
      this.finish()
    } else {
      // multi-frame reply (eg. the contact list): the timeout runs from the latest frame
      clearTimeout(cur.timer)
      cur.timer = setTimeout(() => this.finish(new TimeoutError(cur.job.what)), cur.job.timeoutMs)
    }
  }

  private finish(err?: Error): void {
    const cur = this.current
    if (!cur) return
    clearTimeout(cur.timer)
    this.current = null
    if (err) cur.job.reject(err)
    else cur.job.resolve(cur.frames)
    this.pump()
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return
    const job = this.queue.shift()!
    const frames: Uint8Array[] = []
    const timer = setTimeout(() => this.finish(new TimeoutError(job.what)), job.timeoutMs)
    this.current = { job, frames, timer }
    this.emit('frameOut', job.payload)
    this.transport.write(encodeFrame(job.payload)).catch((err: Error) => this.finish(err))
  }

  /** Send a command and collect reply frames until the matcher says done. */
  request(what: string, payload: Uint8Array, match: Matcher, timeoutMs = 3000): Promise<Uint8Array[]> {
    if (!this.open) return Promise.reject(new Error('not connected'))
    return new Promise((resolve, reject) => {
      this.queue.push({ what, payload, match, timeoutMs, resolve, reject })
      this.pump()
    })
  }

  private async one(what: string, payload: Uint8Array, code: number, timeoutMs?: number): Promise<Uint8Array> {
    const [frame] = await this.request(what, payload, codeIs(code), timeoutMs)
    return frame
  }

  // ---- queries -----------------------------------------------------------------------------------

  async deviceQuery(appVersion = APP_PROTOCOL_VERSION): Promise<DeviceInfo> {
    return parseDeviceInfo(await this.one('device query', commands.deviceQuery(appVersion), Resp.DeviceInfo))
  }

  async appStart(appName = 'meshcore-console'): Promise<SelfInfo> {
    return parseSelfInfo(await this.one('app start', commands.appStart(appName), Resp.SelfInfo))
  }

  async getBattAndStorage(): Promise<BattAndStorage> {
    return parseBattAndStorage(await this.one('battery query', commands.getBattAndStorage(), Resp.BattAndStorage))
  }

  /** Unix seconds on the radio's clock. */
  async getDeviceTime(): Promise<number> {
    return parseCurrTime(await this.one('time query', commands.getDeviceTime(), Resp.CurrTime))
  }

  private async stats(type: number): Promise<Uint8Array> {
    const [frame] = await this.request('stats query', commands.getStats(type), (f) =>
      f[0] === Resp.Stats && f[1] === type ? 'done' : 'skip',
    )
    return frame
  }

  async getCoreStats(): Promise<CoreStats> {
    return parseCoreStats(await this.stats(StatsType.Core))
  }

  async getRadioStats(): Promise<RadioStats> {
    return parseRadioStats(await this.stats(StatsType.Radio))
  }

  async getPacketStats(): Promise<PacketStats> {
    return parsePacketStats(await this.stats(StatsType.Packets))
  }

  async getContacts(since?: number): Promise<{ total: number; contacts: Contact[] }> {
    const frames = await this.request(
      'contact list',
      commands.getContacts(since),
      (f) => {
        if (f[0] === Resp.ContactsStart || f[0] === Resp.Contact) return 'more'
        return f[0] === Resp.EndOfContacts ? 'done' : 'skip'
      },
      5000,
    )
    const start = frames.find((f) => f[0] === Resp.ContactsStart)
    const total = start ? new DataView(start.buffer, start.byteOffset).getUint32(1, true) : 0
    return { total, contacts: frames.filter((f) => f[0] === Resp.Contact).map(parseContact) }
  }

  /** null for an index past the last slot. */
  async getChannel(index: number): Promise<ChannelInfo | null> {
    try {
      return parseChannelInfo(await this.one('channel query', commands.getChannel(index), Resp.ChannelInfo))
    } catch (err) {
      if (err instanceof MeshCoreError && err.code === ErrCode.NotFound) return null
      throw err
    }
  }

  /** Configured channels only: slots with no name and an all-zero secret are skipped. */
  async getChannels(maxChannels: number): Promise<ChannelInfo[]> {
    const out: ChannelInfo[] = []
    for (let i = 0; i < maxChannels; i++) {
      const ch = await this.getChannel(i)
      if (!ch) break
      if (ch.name || /[^0]/.test(ch.secret)) out.push(ch)
    }
    return out
  }

  async getCustomVars(): Promise<Record<string, string>> {
    return parseCustomVars(await this.one('custom vars query', commands.getCustomVars(), Resp.CustomVars))
  }

  async getTuningParams(): Promise<TuningParams> {
    return parseTuningParams(await this.one('tuning query', commands.getTuningParams(), Resp.TuningParams))
  }

  async getAutoaddConfig(): Promise<AutoaddConfig> {
    return parseAutoaddConfig(await this.one('auto-add query', commands.getAutoaddConfig(), Resp.AutoaddConfig))
  }

  async getDefaultFloodScope(): Promise<FloodScope | null> {
    return parseDefaultFloodScope(
      await this.one('flood scope query', commands.getDefaultFloodScope(), Resp.DefaultFloodScope),
    )
  }

  // ---- messages ----------------------------------------------------------------------------------

  /** Pop the next message off the radio's offline queue; null when it's empty. The radio forgets it. */
  async syncNextMessage(): Promise<IncomingMessage | null> {
    const [frame] = await this.request('message sync', commands.syncNextMessage(), codeIs(...MESSAGE_CODES, Resp.NoMoreMessages))
    return frame[0] === Resp.NoMoreMessages ? null : parseIncomingMessage(frame)
  }

  /**
   * Send a direct text message. The radio answers once it has queued the packet; delivery is confirmed
   * later by a PUSH_CODE_SEND_CONFIRMED carrying SentInfo.expectedAck.
   */
  async sendText(publicKey: string, text: string, timestamp = nowSecs(), attempt = 0): Promise<SentInfo> {
    return parseSent(await this.one('message send', commands.sendTxtMsg(publicKey, text, timestamp, attempt), Resp.Sent))
  }

  /** Post to a channel. There's no delivery confirmation for channel posts. */
  async sendChannelText(channelIndex: number, text: string, timestamp = nowSecs()): Promise<void> {
    await this.ok('channel send', commands.sendChannelTxtMsg(channelIndex, text, timestamp))
  }

  // ---- settings ----------------------------------------------------------------------------------

  private async ok(what: string, payload: Uint8Array): Promise<void> {
    await this.one(what, payload, Resp.Ok)
  }

  /** The firmware only moves its clock forward; an earlier time fails with ErrCode.IllegalArg. */
  setDeviceTime(unixSecs = nowSecs()): Promise<void> {
    return this.ok('set time', commands.setDeviceTime(unixSecs))
  }

  setAdvertName(name: string): Promise<void> {
    return this.ok('set name', commands.setAdvertName(name))
  }

  setAdvertLatLon(lat: number, lon: number): Promise<void> {
    return this.ok('set location', commands.setAdvertLatLon(lat, lon))
  }

  /** Takes effect immediately. */
  setRadioParams(params: RadioParams, clientRepeat: boolean): Promise<void> {
    return this.ok('set radio', commands.setRadioParams(params, clientRepeat))
  }

  setTxPower(dbm: number): Promise<void> {
    return this.ok('set tx power', commands.setTxPower(dbm))
  }

  setTuningParams(t: TuningParams): Promise<void> {
    return this.ok('set tuning', commands.setTuningParams(t))
  }

  setOtherParams(o: OtherParams): Promise<void> {
    return this.ok('set other params', commands.setOtherParams(o))
  }

  /** 0 for a random PIN each boot, or six digits. */
  setDevicePin(pin: number): Promise<void> {
    return this.ok('set pin', commands.setDevicePin(pin))
  }

  setAutoaddConfig(c: AutoaddConfig): Promise<void> {
    return this.ok('set auto-add', commands.setAutoaddConfig(c))
  }

  /** 0, 1 or 2 for 1, 2 or 3 bytes per hop in paths. */
  setPathHashMode(mode: number): Promise<void> {
    return this.ok('set path hash mode', commands.setPathHashMode(mode))
  }

  setCustomVar(name: string, value: string): Promise<void> {
    return this.ok('set custom var', commands.setCustomVar(name, value))
  }

  /** Writes a channel slot, which the radio saves to flash. The name must fit 31 UTF-8 bytes; keys are 16 bytes. */
  setChannel(index: number, name: string, secret: Uint8Array): Promise<void> {
    if (nameBytes(name) > MAX_CHANNEL_NAME_BYTES) return Promise.reject(new Error(`channel names are at most ${MAX_CHANNEL_NAME_BYTES} bytes`))
    if (secret.length !== 16) return Promise.reject(new Error('channel keys are 16 bytes'))
    return this.ok('set channel', commands.setChannel(index, name, secret))
  }

  /** Empties a slot: no name and an all-zero key, which the radio treats as unused. */
  removeChannel(index: number): Promise<void> {
    return this.setChannel(index, '', new Uint8Array(16))
  }

  /** Run a CLI 'set' (or other) command that should answer "OK…"; throws with the radio's reply otherwise. */
  async runCliExpectOk(command: string): Promise<string> {
    const reply = await this.runCli(command)
    if (reply === null) throw new TimeoutError(`'${command}'`)
    if (!reply.startsWith('OK')) throw new Error(reply)
    return reply
  }

  /**
   * Run a companion CLI command (protocol v14+). Returns the reply text, or null when the radio
   * doesn't answer (eg. 'reboot').
   */
  async runCli(command: string, timeoutMs = 4000): Promise<string | null> {
    try {
      return parseCliReply(await this.one(`'${command}'`, commands.runCli(command), Resp.CliReply, timeoutMs))
    } catch (err) {
      if (err instanceof TimeoutError) return null
      throw err
    }
  }
}

export const PUSH_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Push).map(([name, code]) => [code, name]),
)
