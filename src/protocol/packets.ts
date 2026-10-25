// Field-by-field decoding of over-the-air packets, for the packet analyzer. Layouts follow src/Packet.cpp,
// src/Mesh.cpp and src/helpers/AdvertDataHelpers.cpp in firmware v1.18.0. The radio pushes every packet it hears
// (PUSH_CODE_LOG_RX_DATA) before parsing or decrypting it, so this also sees packets the firmware will drop, and says
// why.

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { cString, toHex } from './bytes.ts'
import { ADV_TYPE_NAMES, MAX_PACKET_PAYLOAD, MAX_PATH_SIZE, PAYLOAD_TYPE_NAMES, PayloadType, ROUTE_TYPE_NAMES } from './codes.ts'
import { macThenDecrypt, type ChannelKey } from './crypto.ts'

export type FieldKind = 'header' | 'route' | 'address' | 'mac' | 'encrypted' | 'key' | 'signature' | 'value' | 'text' | 'padding'

export interface Field {
  label: string
  start: number // byte offset: into the raw packet, or into the plaintext for decrypted fields
  length: number
  value: string
  kind: FieldKind
}

/** A known node: a contact, or this radio. Payloads address nodes by the first byte(s) of their public key. */
export interface KnownNode {
  publicKey: string // hex
  name: string
}

export interface AnalyzeContext {
  keys: ChannelKey[]
  nodes: KnownNode[]
  selfKey?: string // this radio's public key, hex
}

export interface GroupText {
  timestamp: number // unix secs, sender's clock
  txtType: number
  attempt: number
  text: string // "<sender name>: <message>"
}

export interface GroupData {
  dataType: number
  data: Uint8Array
}

export type PacketDetail =
  | {
      kind: 'group'
      channelHash: number
      /** the key whose MAC matched; undefined when no key fits */
      channel?: ChannelKey
      /** keys whose hash byte matched, in the order tried */
      tried: ChannelKey[]
      text?: GroupText
      data?: GroupData
      /** the decrypted payload, zero padding included, and its fields */
      plain?: Uint8Array
      plainFields: Field[]
    }
  | { kind: 'datagram'; dest: string; src: string }
  | { kind: 'anon'; dest: string; senderKey: string }
  | {
      kind: 'advert'
      publicKey: string
      timestamp: number
      signatureOk: boolean
      self: boolean
      advType?: number
      name?: string
      lat?: number
      lon?: number
    }
  | { kind: 'ack'; crc: string }
  | { kind: 'trace'; tag: number; authCode: number; hashSize: number; route: string[]; snrs: number[] }
  | { kind: 'multipart'; remaining: number; innerType: number; ackCrc?: string }
  | { kind: 'discover-request'; prefixOnly: boolean; typeFilter: number; tag: number; since?: number }
  | { kind: 'discover-response'; nodeType: number; snr: number; tag: number; publicKey: string }
  | { kind: 'other' }

export interface PacketAnalysis {
  routeType?: number
  payloadType?: number
  /** hop hashes for flood and direct packets (hex, hashSize bytes each); SNR readings for traces live in detail */
  path: string[]
  /** what's wrong with the packet, if anything, and what the firmware does about it */
  problem?: string
  /** Packet::readFrom refuses it, so the radio drops it before looking at the payload */
  malformed: boolean
  /** Packet::calculatePacketHash, 8 bytes hex. Every copy of a packet shares it, whichever repeaters it came through. */
  hash?: string
  payloadLength?: number
  fields: Field[]
  detail: PacketDetail
  summary: string
}

const CTL_DISCOVER_REQ = 0x80
const CTL_DISCOVER_RESP = 0x90
const MAX_ADVERT_DATA = 32

class Truncated extends Error {
  readonly label: string
  constructor(label: string) {
    super(`ends inside ${label}`)
    this.label = label
  }
}

const hex8 = (v: number) => v.toString(16).padStart(2, '0')
const hex16 = (v: number) => `0x${v.toString(16).padStart(4, '0')}`
const hex32 = (v: number) => v.toString(16).padStart(8, '0')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function utcText(unixSecs: number): string {
  return `${new Date(unixSecs * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

/** Reads fields in order, recording each one's position for the hex view. */
class Fields {
  readonly list: Field[] = []
  pos: number
  private readonly b: Uint8Array
  private readonly view: DataView

  constructor(b: Uint8Array, start = 0) {
    this.b = b
    this.pos = start
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }

  get remaining(): number {
    return this.b.length - this.pos
  }

  bytes(n: number, label: string, kind: FieldKind, value?: (x: Uint8Array) => string): Uint8Array {
    if (n > this.remaining) throw new Truncated(label)
    const x = this.b.slice(this.pos, this.pos + n)
    if (n > 0) this.list.push({ label, start: this.pos, length: n, kind, value: value ? value(x) : toHex(x) })
    this.pos += n
    return x
  }

  private num(n: number, read: (at: number) => number, label: string, kind: FieldKind, value?: (v: number) => string): number {
    if (n > this.remaining) throw new Truncated(label)
    const v = read(this.pos)
    this.list.push({ label, start: this.pos, length: n, kind, value: value ? value(v) : String(v) })
    this.pos += n
    return v
  }

  u8(label: string, kind: FieldKind = 'value', value?: (v: number) => string): number {
    return this.num(1, (at) => this.view.getUint8(at), label, kind, value)
  }

  i8(label: string, kind: FieldKind = 'value', value?: (v: number) => string): number {
    return this.num(1, (at) => this.view.getInt8(at), label, kind, value)
  }

  u16(label: string, kind: FieldKind = 'value', value?: (v: number) => string): number {
    return this.num(2, (at) => this.view.getUint16(at, true), label, kind, value)
  }

  u32(label: string, kind: FieldKind = 'value', value?: (v: number) => string): number {
    return this.num(4, (at) => this.view.getUint32(at, true), label, kind, value)
  }

  i32(label: string, kind: FieldKind = 'value', value?: (v: number) => string): number {
    return this.num(4, (at) => this.view.getInt32(at, true), label, kind, value)
  }

  rest(label: string, kind: FieldKind, value?: (x: Uint8Array) => string): Uint8Array {
    return this.bytes(this.remaining, label, kind, value)
  }
}

/** Names of known nodes whose public key starts with this hash. */
export function nodeNames(nodes: KnownNode[], hashHex: string): string[] {
  return nodes.filter((n) => n.publicKey.startsWith(hashHex)).map((n) => n.name)
}

function nodeText(nodes: KnownNode[], hashHex: string): string {
  const names = nodeNames(nodes, hashHex)
  return names.length ? `${hashHex} (${names.join(' or ')})` : hashHex
}

/** Packet::calculatePacketHash: SHA-256 of the payload type, path_len for traces (as a uint16), and the payload. */
export function packetHash(payloadType: number, pathLen: number, payload: Uint8Array): string {
  const head = payloadType === PayloadType.Trace ? [payloadType, pathLen, 0] : [payloadType]
  const data = new Uint8Array(head.length + payload.length)
  data.set(head)
  data.set(payload, head.length)
  return toHex(sha256(data).subarray(0, 8))
}

const signatureCache = new WeakMap<Uint8Array, boolean>()

/** Adverts sign public key + timestamp + app data (capped at 32 bytes); the firmware drops forged ones. */
function advertSignatureOk(raw: Uint8Array, payload: Uint8Array): boolean {
  let ok = signatureCache.get(raw)
  if (ok === undefined) {
    const appData = payload.subarray(100, Math.min(payload.length, 100 + MAX_ADVERT_DATA))
    const message = new Uint8Array(36 + appData.length)
    message.set(payload.subarray(0, 36))
    message.set(appData, 36)
    try {
      ok = ed25519.verify(payload.subarray(36, 100), message, payload.subarray(0, 32), { zip215: false })
    } catch {
      ok = false
    }
    signatureCache.set(raw, ok)
  }
  return ok
}

export function analyzePacket(raw: Uint8Array, ctx: AnalyzeContext): PacketAnalysis {
  const f = new Fields(raw)
  const out: PacketAnalysis = { path: [], malformed: false, fields: f.list, detail: { kind: 'other' }, summary: '' }
  let inPayload = false
  try {
    const header = f.u8('header', 'header', (h) => {
      const route = ROUTE_TYPE_NAMES[h & 3]
      const type = PAYLOAD_TYPE_NAMES[(h >> 2) & 15] ?? `type ${(h >> 2) & 15}`
      return `${route} · ${type} · payload v${(h >> 6) + 1}`
    })
    const routeType = header & 3
    const payloadType = (header >> 2) & 15
    out.routeType = routeType
    out.payloadType = payloadType
    if (routeType === 0 || routeType === 3) {
      f.u16('transport code 1', 'route', hex16)
      f.u16('transport code 2', 'route', hex16)
    }
    const trace = payloadType === PayloadType.Trace
    const pathLen = f.u8('path length', 'route', (v) => {
      const n = v & 63
      if (trace) return plural(n, 'SNR reading')
      return `${plural(n, 'hop')} × ${(v >> 6) + 1} B`
    })
    const hashSize = (pathLen >> 6) + 1
    const hops = pathLen & 63
    if (hashSize === 4) {
      out.problem = 'path hash size 4 is reserved, so the radio drops it'
    } else if (hops * hashSize > MAX_PATH_SIZE) {
      out.problem = `a ${hops * hashSize}-byte path is over the ${MAX_PATH_SIZE}-byte limit, so the radio drops it`
    }
    if (out.problem) {
      f.rest('rest', 'value')
      out.malformed = true
      out.summary = out.problem
      return out
    }
    const pathBytes = f.bytes(hops * hashSize, trace ? 'SNR per hop' : 'path', 'route', (b) =>
      trace
        ? Array.from(b, (v) => `${((v << 24) >> 24) / 4}`).join(' ') + ' dB'
        : chunk(b, hashSize).map((h) => nodeText(ctx.nodes, h)).join(' → '),
    )
    if (!trace) out.path = chunk(pathBytes, hashSize)

    const payload = raw.subarray(f.pos)
    if (payload.length === 0) {
      out.problem = 'no payload, so the radio drops it'
      out.malformed = true
      out.summary = out.problem
      return out
    }
    if (payload.length > MAX_PACKET_PAYLOAD) {
      out.problem = `the payload is over ${MAX_PACKET_PAYLOAD} bytes, so the radio drops it`
      out.malformed = true
    }
    out.payloadLength = payload.length
    out.hash = packetHash(payloadType, pathLen, payload)
    inPayload = true
    out.detail = decodePayload(f, raw, payloadType, pathBytes, ctx)
    if (f.remaining > 0) f.rest('unparsed', 'value')
    out.problem ??= sealedProblem(payloadType, payload.length)
  } catch (err) {
    if (!(err instanceof Truncated)) throw err
    if (f.remaining) f.rest(`${err.label} (cut short)`, 'value')
    out.problem = inPayload ? `${err.message}, so the radio ignores it` : `${err.message}, so the radio drops it`
    out.malformed ||= !inPayload
  }
  out.summary = summarize(out, ctx)
  return out
}

/** Encrypted payloads end in MAC + ciphertext; Utils::MACThenDecrypt refuses ciphertext that isn't whole blocks. */
function sealedProblem(type: number, payloadLength: number): string | undefined {
  const prefix: Record<number, number> = {
    [PayloadType.Req]: 2,
    [PayloadType.Response]: 2,
    [PayloadType.TxtMsg]: 2,
    [PayloadType.Path]: 2,
    [PayloadType.AnonReq]: 33,
    [PayloadType.GrpTxt]: 1,
    [PayloadType.GrpData]: 1,
  }
  if (!(type in prefix)) return undefined
  const cipherLength = payloadLength - prefix[type] - 2
  if (cipherLength <= 0) return 'no ciphertext, so the radio ignores it'
  if (cipherLength % 16) return `the ciphertext isn't whole 16-byte blocks, so no key can open it`
  return undefined
}

function chunk(b: Uint8Array, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i + size <= b.length; i += size) out.push(toHex(b.subarray(i, i + size)))
  return out
}

function decodePayload(f: Fields, raw: Uint8Array, type: number, pathBytes: Uint8Array, ctx: AnalyzeContext): PacketDetail {
  switch (type) {
    case PayloadType.Req:
    case PayloadType.Response:
    case PayloadType.TxtMsg:
    case PayloadType.Path: {
      const dest = hex8(f.u8('destination', 'address', (v) => nodeText(ctx.nodes, hex8(v))))
      const src = hex8(f.u8('source', 'address', (v) => nodeText(ctx.nodes, hex8(v))))
      f.bytes(2, 'MAC', 'mac')
      f.rest('ciphertext', 'encrypted', (b) => `${b.length} B, needs the pair's shared secret`)
      return { kind: 'datagram', dest, src }
    }
    case PayloadType.AnonReq: {
      const dest = hex8(f.u8('destination', 'address', (v) => nodeText(ctx.nodes, hex8(v))))
      const senderKey = toHex(f.bytes(32, 'sender public key', 'key', (b) => {
        const k = toHex(b)
        return ctx.nodes.find((n) => n.publicKey === k)?.name ?? k
      }))
      f.bytes(2, 'MAC', 'mac')
      f.rest('ciphertext', 'encrypted', (b) => `${b.length} B`)
      return { kind: 'anon', dest, senderKey }
    }
    case PayloadType.GrpTxt:
    case PayloadType.GrpData:
      return decodeGroup(f, raw, type, ctx)
    case PayloadType.Advert:
      return decodeAdvert(f, raw, ctx)
    case PayloadType.Ack:
      return { kind: 'ack', crc: hex32(f.u32('ack checksum', 'value', hex32)) }
    case PayloadType.Trace: {
      const tag = f.u32('tag', 'value', hex32)
      const authCode = f.u32('auth code', 'value', hex32)
      const flags = f.u8('flags', 'value', (v) => `${1 << (v & 3)}-byte hashes`)
      const hashSize = 1 << (flags & 3)
      const route = chunk(f.rest('route', 'address', (b) => chunk(b, hashSize).map((h) => nodeText(ctx.nodes, h)).join(' → ')), hashSize)
      const snrs = Array.from(pathBytes, (v) => ((v << 24) >> 24) / 4)
      return { kind: 'trace', tag, authCode, hashSize, route, snrs }
    }
    case PayloadType.Multipart: {
      const b0 = f.u8('sequence', 'value', (v) => `${(v >> 4)} more to come · ${PAYLOAD_TYPE_NAMES[v & 15] ?? `type ${v & 15}`}`)
      const innerType = b0 & 15
      const ackCrc = innerType === PayloadType.Ack && f.remaining >= 4 ? hex32(f.u32('ack checksum', 'value', hex32)) : undefined
      return { kind: 'multipart', remaining: b0 >> 4, innerType, ackCrc }
    }
    case PayloadType.Control:
      return decodeControl(f, ctx)
    default:
      f.rest('data', 'value', (b) => `${b.length} B`)
      return { kind: 'other' }
  }
}

function decodeGroup(f: Fields, raw: Uint8Array, type: number, ctx: AnalyzeContext): PacketDetail {
  const channelHash = f.u8('channel hash', 'address', (v) => {
    const names = ctx.keys.filter((k) => k.hash === v).map((k) => k.name)
    return names.length ? `${hex8(v)} (${names.join(' or ')})` : `${hex8(v)} (no key)`
  })
  const sealed = raw.slice(f.pos)
  f.bytes(2, 'MAC', 'mac')
  f.rest('ciphertext', 'encrypted', (b) => (b.length % 16 ? `${b.length} B, not whole blocks` : `${b.length} B`))
  const tried = ctx.keys.filter((k) => k.hash === channelHash)
  for (const key of tried) {
    const plain = macThenDecrypt(key.secret, sealed)
    if (!plain) continue
    const p = new Fields(plain)
    try {
      if (type === PayloadType.GrpTxt) {
        const timestamp = p.u32('timestamp', 'value', utcText)
        const flags = p.u8('flags', 'value', (v) => `${v >> 2 ? `text type ${v >> 2}, the radio drops it` : 'plain text'} · attempt ${v & 3}`)
        const end = plain.indexOf(0, p.pos)
        const textBytes = p.bytes((end < 0 ? plain.length : end) - p.pos, 'text', 'text', (b) => cString(b))
        if (p.remaining) p.rest('padding', 'padding')
        const text = { timestamp, txtType: flags >> 2, attempt: flags & 3, text: cString(textBytes) }
        return { kind: 'group', channelHash, channel: key, tried, text, plain, plainFields: p.list }
      }
      const dataType = p.u16('data type', 'value', hex16)
      const len = p.u8('data length', 'value', (v) => `${v} B`)
      const data = p.bytes(Math.min(len, p.remaining), 'data', 'value')
      if (p.remaining) p.rest('padding', 'padding')
      return { kind: 'group', channelHash, channel: key, tried, data: { dataType, data }, plain, plainFields: p.list }
    } catch (err) {
      if (!(err instanceof Truncated)) throw err
      return { kind: 'group', channelHash, channel: key, tried, plain, plainFields: p.list }
    }
  }
  return { kind: 'group', channelHash, tried, plainFields: [] }
}

function decodeAdvert(f: Fields, raw: Uint8Array, ctx: AnalyzeContext): PacketDetail {
  const payload = raw.subarray(f.pos)
  const publicKey = toHex(f.bytes(32, 'public key', 'key', (b) => {
    const k = toHex(b)
    return k === ctx.selfKey ? `${k} (this radio)` : k
  }))
  const timestamp = f.u32('timestamp', 'value', utcText)
  const signatureOk = advertSignatureOk(raw, payload)
  f.bytes(64, 'signature', 'signature', () => (signatureOk ? 'valid' : 'does not match, so the radio drops it'))
  const detail: Extract<PacketDetail, { kind: 'advert' }> = { kind: 'advert', publicKey, timestamp, signatureOk, self: publicKey === ctx.selfKey }
  if (f.remaining === 0) return detail

  // AdvertDataParser: flags, then optional lat/lon, feat1, feat2, name. The firmware reads at most 32 bytes.
  const appEnd = f.pos + Math.min(f.remaining, MAX_ADVERT_DATA)
  const flags = f.u8('flags', 'value', (v) => {
    const parts = [ADV_TYPE_NAMES[v & 15] ?? `type ${v & 15}`]
    if (v & 0x10) parts.push('location')
    if (v & 0x80) parts.push('name')
    return parts.join(' · ')
  })
  detail.advType = flags & 15
  const appLeft = () => appEnd - f.pos
  const need = (flags & 0x10 ? 8 : 0) + (flags & 0x20 ? 2 : 0) + (flags & 0x40 ? 2 : 0)
  if (need > appLeft()) {
    f.bytes(appLeft(), 'app data (truncated)', 'value')
    if (f.remaining) f.rest('ignored (over the 32-byte app data limit)', 'padding')
    return detail
  }
  if (flags & 0x10) {
    detail.lat = f.i32('latitude', 'value', (v) => `${(v / 1e6).toFixed(6)}°`) / 1e6
    detail.lon = f.i32('longitude', 'value', (v) => `${(v / 1e6).toFixed(6)}°`) / 1e6
  }
  if (flags & 0x20) f.u16('feature 1', 'value', hex16)
  if (flags & 0x40) f.u16('feature 2', 'value', hex16)
  if (flags & 0x80 && appLeft() > 0) detail.name = cString(f.bytes(appLeft(), 'name', 'text', (b) => cString(b)))
  if (appLeft() > 0) f.bytes(appLeft(), 'unused app data', 'padding')
  if (f.remaining) f.rest('ignored (over the 32-byte app data limit)', 'padding')
  return detail
}

function decodeControl(f: Fields, ctx: AnalyzeContext): PacketDetail {
  const b0 = f.u8('control type', 'value', (v) => {
    const t = v & 0xf0
    if (t === CTL_DISCOVER_REQ) return `discover request${v & 1 ? ', key prefix only' : ''}`
    if (t === CTL_DISCOVER_RESP) return `discover response · ${ADV_TYPE_NAMES[v & 15] ?? `type ${v & 15}`}`
    return hex8(v)
  })
  const t = b0 & 0xf0
  if (t === CTL_DISCOVER_REQ) {
    const typeFilter = f.u8('type filter', 'value', filterText)
    const tag = f.u32('tag', 'value', hex32)
    const since = f.remaining >= 4 ? f.u32('since', 'value', utcText) : undefined
    return { kind: 'discover-request', prefixOnly: (b0 & 1) !== 0, typeFilter, tag, since }
  }
  if (t === CTL_DISCOVER_RESP) {
    const snr = f.i8('SNR heard', 'value', (v) => `${v / 4} dB`) / 4
    const tag = f.u32('tag', 'value', hex32)
    const publicKey = toHex(f.rest('public key', 'key', (b) => {
      const k = toHex(b)
      const names = ctx.nodes.filter((n) => n.publicKey.startsWith(k)).map((n) => n.name)
      return names.length ? `${k} (${names.join(' or ')})` : k
    }))
    return { kind: 'discover-response', nodeType: b0 & 15, snr, tag, publicKey }
  }
  f.rest('data', 'value', (b) => `${b.length} B`)
  return { kind: 'other' }
}

function filterText(v: number): string {
  if ((v & 0x1e) === 0x1e) return 'all node types'
  const names = [1, 2, 3, 4].filter((t) => v & (1 << t)).map((t) => ADV_TYPE_NAMES[t])
  return names.length ? names.join(', ') : 'none'
}

function summarize(a: PacketAnalysis, ctx: AnalyzeContext): string {
  const d = a.detail
  let s: string
  switch (d.kind) {
    case 'group': {
      if (d.text) s = `${d.channel?.name}: ${d.text.text}`
      else if (d.data) s = `${d.channel?.name}: data ${hex16(d.data.dataType)}, ${d.data.data.length} B`
      else if (d.channel) s = `${d.channel.name}: (unreadable plaintext)`
      else if (a.problem) s = `channel ${hex8(d.channelHash)}`
      else if (d.tried.length) s = `channel ${hex8(d.channelHash)}: MAC doesn't match ${d.tried.map((k) => k.name).join(' or ')}`
      else s = `channel ${hex8(d.channelHash)}: no key`
      break
    }
    case 'datagram':
      s = `to ${nodeText(ctx.nodes, d.dest)} from ${nodeText(ctx.nodes, d.src)}`
      break
    case 'anon':
      s = `to ${nodeText(ctx.nodes, d.dest)} from ${ctx.nodes.find((n) => n.publicKey === d.senderKey)?.name ?? `${d.senderKey.slice(0, 8)}…`}`
      break
    case 'advert': {
      const who = d.self ? 'this radio' : d.name || `${d.publicKey.slice(0, 8)}…`
      const parts = [who]
      if (d.advType !== undefined) parts.push(ADV_TYPE_NAMES[d.advType] ?? `type ${d.advType}`)
      if (d.lat !== undefined && d.lon !== undefined && (d.lat || d.lon)) parts.push(`${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}`)
      if (!d.signatureOk) parts.push('forged signature')
      s = parts.join(' · ')
      break
    }
    case 'ack':
      s = `ack ${d.crc}`
      break
    case 'trace':
      s = `tag ${hex32(d.tag)} · route ${d.route.join(' → ') || '(none)'}${d.snrs.length ? ` · SNR ${d.snrs.join(', ')} dB` : ''}`
      break
    case 'multipart':
      s = `${d.ackCrc ? `ack ${d.ackCrc}` : PAYLOAD_TYPE_NAMES[d.innerType] ?? `type ${d.innerType}`} · ${d.remaining} more to come`
      break
    case 'discover-request':
      s = `discover ${filterText(d.typeFilter)}`
      break
    case 'discover-response':
      s = `${ADV_TYPE_NAMES[d.nodeType] ?? `type ${d.nodeType}`} ${d.publicKey.slice(0, 8)}… answered, heard at ${d.snr} dB`
      break
    default:
      s = a.problem || a.payloadLength === undefined ? '' : `${a.payloadLength} B`
  }
  return a.problem ? (s ? `${s} · ${a.problem}` : a.problem) : s
}
