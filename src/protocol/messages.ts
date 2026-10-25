// Typed views of companion protocol frames. Each parser follows the firmware's memcpy order for that
// reply (examples/companion_radio/MyMesh.cpp, v1.18.0); frame[0] is always the response or push code.

import { ByteReader, ByteWriter, fromHex, toHex } from './bytes.ts'
import { Cmd, OUT_PATH_UNKNOWN, PAYLOAD_TYPE_NAMES, Resp, ROUTE_TYPE_NAMES, TxtType } from './codes.ts'

export interface DeviceInfo {
  protocolVersion: number
  maxContacts: number
  maxChannels: number
  blePin: number // 0 = random PIN shown on the device's screen
  buildDate: string
  manufacturer: string
  firmwareVersion: string
  clientRepeat?: boolean // protocol v9+
  pathHashMode?: number // protocol v10+
}

export interface RadioParams {
  freqMHz: number
  bwKHz: number
  sf: number
  cr: number
}

export interface SelfInfo {
  advType: number
  txPowerDbm: number
  maxTxPowerDbm: number
  publicKey: string // hex
  lat: number // degrees
  lon: number
  multiAcks: number
  advertLocationPolicy: number // 0 = don't share, 1 = share
  telemetry: { base: number; location: number; environment: number } // 0 deny, 1 per contact flags, 2 allow all
  manualAddContacts: number
  radio: RadioParams
  name: string
}

export interface BattAndStorage {
  batteryMv: number
  storageUsedKb: number
  storageTotalKb: number
}

export interface CoreStats {
  batteryMv: number
  uptimeSecs: number
  errFlags: number
  queueLen: number
}

export interface RadioStats {
  noiseFloorDbm: number
  lastRssiDbm: number
  lastSnrDb: number
  txAirSecs: number
  rxAirSecs: number
}

export interface PacketStats {
  received: number
  sent: number
  sentFlood: number
  sentDirect: number
  receivedFlood: number
  receivedDirect: number
  receiveErrors: number
}

export interface OutPath {
  known: boolean
  hops: number
  hashSize: number // bytes per hop
  path: string // hex
}

export interface Contact {
  publicKey: string // hex
  type: number
  flags: number
  outPath: OutPath
  name: string
  lastAdvert: number // unix secs, sender's clock
  lat: number
  lon: number
  lastModified: number // unix secs, this device's clock
}

export interface ChannelInfo {
  index: number
  name: string
  secret: string // hex, 128-bit
}

export interface TuningParams {
  rxDelayBase: number
  airtimeFactor: number
}

export interface AutoaddConfig {
  flags: number // AutoAdd bits
  maxHops: number // 0 = no limit
}

export interface FloodScope {
  name: string
  key: string // hex
}

export interface DecodedPacket {
  routeType: number
  routeName: string
  payloadType: number
  payloadName: string
  version: number
  transportCodes?: [number, number]
  hops: number
  hashSize: number
  path: string // hex
  payloadLength: number
}

export interface RxLogEntry {
  snr: number
  rssi: number
  raw: Uint8Array
  packet?: DecodedPacket // undefined if the raw bytes don't parse
}

/** A message popped off the radio's offline queue with CMD_SYNC_NEXT_MESSAGE. */
export interface IncomingMessage {
  kind: 'direct' | 'channel' | 'channel-data'
  snr?: number // dB; only in the v3+ formats
  senderPrefix?: string // direct: first 6 bytes of the sender's public key, hex
  channelIndex?: number
  hops: number | null // null when it arrived by a direct route
  txtType: number
  senderTimestamp: number // unix secs, sender's clock
  authorPrefix?: string // signed posts (room servers): first 4 bytes of the original author's key
  text: string
  dataType?: number // channel-data only
  data?: Uint8Array
}

export interface SentInfo {
  flood: boolean
  expectedAck: number // matches PUSH_CODE_SEND_CONFIRMED; 0 = none expected
  timeoutMs: number // radio's estimate of how long the ACK may take
}

export interface SendConfirmed {
  ack: number
  tripMs: number
}

export interface OtherParams {
  manualAddContacts: number
  telemetry: { base: number; location: number; environment: number }
  advertLocationPolicy: number
  multiAcks: number
}

// ---- parsers -------------------------------------------------------------------------------------

export function parseDeviceInfo(f: Uint8Array): DeviceInfo {
  const r = new ByteReader(f, 1)
  const info: DeviceInfo = {
    protocolVersion: r.u8(),
    maxContacts: r.u8() * 2,
    maxChannels: r.u8(),
    blePin: r.u32(),
    buildDate: r.fixedString(12),
    manufacturer: r.fixedString(40),
    firmwareVersion: r.fixedString(20),
  }
  if (r.remaining >= 1) info.clientRepeat = r.u8() !== 0
  if (r.remaining >= 1) info.pathHashMode = r.u8()
  return info
}

export function parseSelfInfo(f: Uint8Array): SelfInfo {
  const r = new ByteReader(f, 1)
  const advType = r.u8()
  const txPowerDbm = r.i8()
  const maxTxPowerDbm = r.i8()
  const publicKey = toHex(r.take(32))
  const lat = r.i32() / 1e6
  const lon = r.i32() / 1e6
  const multiAcks = r.u8()
  const advertLocationPolicy = r.u8()
  const tm = r.u8()
  const manualAddContacts = r.u8()
  const radio: RadioParams = { freqMHz: r.u32() / 1000, bwKHz: r.u32() / 1000, sf: r.u8(), cr: r.u8() }
  return {
    advType,
    txPowerDbm,
    maxTxPowerDbm,
    publicKey,
    lat,
    lon,
    multiAcks,
    advertLocationPolicy,
    telemetry: { base: tm & 3, location: (tm >> 2) & 3, environment: (tm >> 4) & 3 },
    manualAddContacts,
    radio,
    name: r.restString(),
  }
}

export function parseBattAndStorage(f: Uint8Array): BattAndStorage {
  const r = new ByteReader(f, 1)
  return { batteryMv: r.u16(), storageUsedKb: r.u32(), storageTotalKb: r.u32() }
}

export function parseCurrTime(f: Uint8Array): number {
  return new ByteReader(f, 1).u32()
}

export function parseCoreStats(f: Uint8Array): CoreStats {
  const r = new ByteReader(f, 2)
  return { batteryMv: r.u16(), uptimeSecs: r.u32(), errFlags: r.u16(), queueLen: r.u8() }
}

export function parseRadioStats(f: Uint8Array): RadioStats {
  const r = new ByteReader(f, 2)
  return {
    noiseFloorDbm: r.i16(),
    lastRssiDbm: r.i8(),
    lastSnrDb: r.i8() / 4,
    txAirSecs: r.u32(),
    rxAirSecs: r.u32(),
  }
}

export function parsePacketStats(f: Uint8Array): PacketStats {
  const r = new ByteReader(f, 2)
  return {
    received: r.u32(),
    sent: r.u32(),
    sentFlood: r.u32(),
    sentDirect: r.u32(),
    receivedFlood: r.u32(),
    receivedDirect: r.u32(),
    receiveErrors: r.u32(),
  }
}

export function decodeOutPath(len: number, path: Uint8Array): OutPath {
  if (len === OUT_PATH_UNKNOWN) return { known: false, hops: 0, hashSize: 1, path: '' }
  const hashSize = (len >> 6) + 1
  const hops = len & 63
  return { known: true, hops, hashSize, path: toHex(path.subarray(0, hops * hashSize)) }
}

/** RESP_CODE_CONTACT and PUSH_CODE_NEW_ADVERT share this layout. */
export function parseContact(f: Uint8Array): Contact {
  const r = new ByteReader(f, 1)
  const publicKey = toHex(r.take(32))
  const type = r.u8()
  const flags = r.u8()
  const outPathLen = r.u8()
  const outPath = decodeOutPath(outPathLen, r.take(64))
  return {
    publicKey,
    type,
    flags,
    outPath,
    name: r.fixedString(32),
    lastAdvert: r.u32(),
    lat: r.i32() / 1e6,
    lon: r.i32() / 1e6,
    lastModified: r.u32(),
  }
}

export function parseChannelInfo(f: Uint8Array): ChannelInfo {
  const r = new ByteReader(f, 1)
  return { index: r.u8(), name: r.fixedString(32), secret: toHex(r.take(16)) }
}

/** "gps:1,gps_interval:0" -> { gps: '1', gps_interval: '0' } */
export function parseCustomVars(f: Uint8Array): Record<string, string> {
  const text = new ByteReader(f, 1).restString()
  const vars: Record<string, string> = {}
  for (const pair of text.split(',')) {
    const sep = pair.indexOf(':')
    if (sep > 0) vars[pair.slice(0, sep)] = pair.slice(sep + 1)
  }
  return vars
}

export function parseTuningParams(f: Uint8Array): TuningParams {
  const r = new ByteReader(f, 1)
  return { rxDelayBase: r.u32() / 1000, airtimeFactor: r.u32() / 1000 }
}

export function parseAutoaddConfig(f: Uint8Array): AutoaddConfig {
  const r = new ByteReader(f, 1)
  return { flags: r.u8(), maxHops: r.u8() }
}

export function parseDefaultFloodScope(f: Uint8Array): FloodScope | null {
  if (f.length < 1 + 31 + 16) return null
  const r = new ByteReader(f, 1)
  return { name: r.fixedString(31), key: toHex(r.take(16)) }
}

export function parseCliReply(f: Uint8Array): string {
  return new ByteReader(f, 1).restString()
}

export function parseErrCode(f: Uint8Array): number | undefined {
  return f.length > 1 ? f[1] : undefined
}

const hopsOf = (pathLen: number) => (pathLen === 0xff ? null : pathLen & 63)

/**
 * Offline queue entries (MyMesh::queueMessage / onChannelMessageRecv / onChannelDataRecv). The v3 formats,
 * sent when the app announces protocol 3+, add SNR and two reserved bytes after the code.
 */
export function parseIncomingMessage(f: Uint8Array): IncomingMessage {
  const code = f[0]
  const r = new ByteReader(f, 1)
  const v3 = code === Resp.ContactMsgRecvV3 || code === Resp.ChannelMsgRecvV3 || code === Resp.ChannelDataRecv
  let snr: number | undefined
  if (v3) {
    snr = r.i8() / 4
    r.u16() // reserved
  }
  if (code === Resp.ContactMsgRecv || code === Resp.ContactMsgRecvV3) {
    const senderPrefix = toHex(r.take(6))
    const hops = hopsOf(r.u8())
    const txtType = r.u8()
    const senderTimestamp = r.u32()
    const authorPrefix = txtType === TxtType.SignedPlain ? toHex(r.take(4)) : undefined
    return { kind: 'direct', snr, senderPrefix, hops, txtType, senderTimestamp, authorPrefix, text: r.restString() }
  }
  if (code === Resp.ChannelMsgRecv || code === Resp.ChannelMsgRecvV3) {
    const channelIndex = r.u8()
    const hops = hopsOf(r.u8())
    const txtType = r.u8()
    const senderTimestamp = r.u32()
    return { kind: 'channel', snr, channelIndex, hops, txtType, senderTimestamp, text: r.restString() }
  }
  if (code === Resp.ChannelDataRecv) {
    const channelIndex = r.u8()
    const hops = hopsOf(r.u8())
    const dataType = r.u16()
    const len = r.u8()
    const data = r.take(Math.min(len, r.remaining))
    return { kind: 'channel-data', snr, channelIndex, hops, txtType: -1, senderTimestamp: 0, text: '', dataType, data }
  }
  throw new Error(`not a message frame: code ${code}`)
}

/** "alice: hello there" -> { sender: 'alice', body: 'hello there' }. Channel posts carry the sender's name inline. */
export function splitChannelText(text: string): { sender?: string; body: string } {
  const i = text.indexOf(': ')
  return i > 0 ? { sender: text.slice(0, i), body: text.slice(i + 2) } : { body: text }
}

export function parseSent(f: Uint8Array): SentInfo {
  const r = new ByteReader(f, 1)
  return { flood: r.u8() === 1, expectedAck: r.u32(), timeoutMs: r.u32() }
}

export function parseSendConfirmed(f: Uint8Array): SendConfirmed {
  const r = new ByteReader(f, 1)
  return { ack: r.u32(), tripMs: r.u32() }
}

/** Raw over-the-air packet: header, optional transport codes, path_len, path, payload (Packet::writeTo). */
export function decodePacket(raw: Uint8Array): DecodedPacket | undefined {
  try {
    const r = new ByteReader(raw)
    const header = r.u8()
    const routeType = header & 0x03
    const payloadType = (header >> 2) & 0x0f
    const version = (header >> 6) & 0x03
    let transportCodes: [number, number] | undefined
    if (routeType === 0 || routeType === 3) transportCodes = [r.u16(), r.u16()]
    const pathLen = r.u8()
    const hashSize = (pathLen >> 6) + 1
    const hops = pathLen & 63
    const path = toHex(r.take(hops * hashSize))
    return {
      routeType,
      routeName: ROUTE_TYPE_NAMES[routeType],
      payloadType,
      payloadName: PAYLOAD_TYPE_NAMES[payloadType] ?? `type ${payloadType}`,
      version,
      transportCodes,
      hops,
      hashSize,
      path,
      payloadLength: r.remaining,
    }
  } catch {
    return undefined
  }
}

/** PUSH_CODE_LOG_RX_DATA: one per packet the radio receives, while an app is connected. */
export function parseRxLog(f: Uint8Array): RxLogEntry {
  const r = new ByteReader(f, 1)
  const snr = r.i8() / 4
  const rssi = r.i8()
  const raw = r.take(r.remaining)
  return { snr, rssi, raw, packet: decodePacket(raw) }
}

// ---- command builders ----------------------------------------------------------------------------

export const commands = {
  deviceQuery: (appVersion: number) => new ByteWriter().u8(Cmd.DeviceQuery).u8(appVersion).toBytes(),
  appStart: (appName: string) => new ByteWriter().u8(Cmd.AppStart).bytes(new Uint8Array(7)).string(appName).toBytes(),
  getContacts: (since?: number) => {
    const w = new ByteWriter().u8(Cmd.GetContacts)
    if (since !== undefined) w.u32(since)
    return w.toBytes()
  },
  getDeviceTime: () => Uint8Array.of(Cmd.GetDeviceTime),
  getBattAndStorage: () => Uint8Array.of(Cmd.GetBattAndStorage),
  getStats: (type: number) => Uint8Array.of(Cmd.GetStats, type),
  getChannel: (index: number) => Uint8Array.of(Cmd.GetChannel, index),
  getCustomVars: () => Uint8Array.of(Cmd.GetCustomVars),
  getTuningParams: () => Uint8Array.of(Cmd.GetTuningParams),
  getAutoaddConfig: () => Uint8Array.of(Cmd.GetAutoaddConfig),
  getDefaultFloodScope: () => Uint8Array.of(Cmd.GetDefaultFloodScope),
  runCli: (text: string) => new ByteWriter().u8(Cmd.RunCliCommand).string(text).toBytes(),

  syncNextMessage: () => Uint8Array.of(Cmd.SyncNextMessage),
  sendTxtMsg: (publicKey: string, text: string, timestamp: number, attempt = 0, txtType: number = TxtType.Plain) =>
    new ByteWriter().u8(Cmd.SendTxtMsg).u8(txtType).u8(attempt).u32(timestamp).bytes(fromHex(publicKey).slice(0, 6)).string(text).toBytes(),
  sendChannelTxtMsg: (channelIndex: number, text: string, timestamp: number) =>
    new ByteWriter().u8(Cmd.SendChannelTxtMsg).u8(TxtType.Plain).u8(channelIndex).u32(timestamp).string(text).toBytes(),

  setDeviceTime: (unixSecs: number) => new ByteWriter().u8(Cmd.SetDeviceTime).u32(unixSecs).toBytes(),
  setAdvertName: (name: string) => new ByteWriter().u8(Cmd.SetAdvertName).string(name).toBytes(),
  setAdvertLatLon: (lat: number, lon: number) =>
    new ByteWriter().u8(Cmd.SetAdvertLatLon).u32(Math.round(lat * 1e6)).u32(Math.round(lon * 1e6)).toBytes(),
  /** clientRepeat must be sent every time: the firmware turns repeating off when the byte is missing. */
  setRadioParams: (p: RadioParams, clientRepeat: boolean) =>
    new ByteWriter().u8(Cmd.SetRadioParams).u32(Math.round(p.freqMHz * 1000)).u32(Math.round(p.bwKHz * 1000))
      .u8(p.sf).u8(p.cr).u8(clientRepeat ? 1 : 0).toBytes(),
  setTxPower: (dbm: number) => Uint8Array.of(Cmd.SetRadioTxPower, dbm & 0xff),
  setTuningParams: (t: TuningParams) =>
    new ByteWriter().u8(Cmd.SetTuningParams).u32(Math.round(t.rxDelayBase * 1000)).u32(Math.round(t.airtimeFactor * 1000)).toBytes(),
  /** All four fields go in one frame, so pass the current values for the ones not being changed. */
  setOtherParams: (o: OtherParams) =>
    Uint8Array.of(
      Cmd.SetOtherParams,
      o.manualAddContacts,
      (o.telemetry.environment << 4) | (o.telemetry.location << 2) | o.telemetry.base,
      o.advertLocationPolicy,
      o.multiAcks,
    ),
  setDevicePin: (pin: number) => new ByteWriter().u8(Cmd.SetDevicePin).u32(pin).toBytes(),
  setAutoaddConfig: (c: AutoaddConfig) => Uint8Array.of(Cmd.SetAutoaddConfig, c.flags, c.maxHops),
  setPathHashMode: (mode: number) => Uint8Array.of(Cmd.SetPathHashMode, 0, mode),
  setCustomVar: (name: string, value: string) => new ByteWriter().u8(Cmd.SetCustomVar).string(`${name}:${value}`).toBytes(),
  /** The firmware only takes 16-byte keys here; a 32-byte one is refused as unsupported. */
  setChannel: (index: number, name: string, secret: Uint8Array) =>
    new ByteWriter().u8(Cmd.SetChannel).u8(index).fixedString(name, 32).bytes(secret).toBytes(),
}
