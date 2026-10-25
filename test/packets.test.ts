// Packet analyzer and payload crypto. The golden fixture is output of the MeshCore v1.18.0 C++ (see its "source").

import { describe, expect, it } from 'vitest'
import { ByteWriter, cString, fromHex, toHex } from '../src/protocol/bytes.ts'
import { PayloadType } from '../src/protocol/codes.ts'
import {
  channelHash,
  channelKey,
  encryptThenMac,
  hashtagKey,
  hashtagSecret,
  macThenDecrypt,
  normalizeHashtag,
  PUBLIC_CHANNEL_SECRET,
  type ChannelKey,
} from '../src/protocol/crypto.ts'
import { analyzePacket, packetHash, type AnalyzeContext, type PacketDetail } from '../src/protocol/packets.ts'
import golden from './fixtures/meshcore-golden-1.18.0.json'

const PUBLIC = channelKey('Public', PUBLIC_CHANNEL_SECRET, 'radio', 0)
const NONE: AnalyzeContext = { keys: [], nodes: [] }

/** header + path_len + path + payload, for a flood (or direct) packet without transport codes */
function packet(type: number, payload: Uint8Array, path: number[] = [], route = 1): Uint8Array {
  return new ByteWriter().u8((type << 2) | route).u8(path.length).bytes(path).bytes(payload).toBytes()
}

function groupPacket(key: ChannelKey, ts: number, text: string, path: number[] = []): Uint8Array {
  const plain = new ByteWriter().u32(ts).u8(0).string(text).toBytes()
  const payload = new ByteWriter().u8(key.hash).bytes(encryptThenMac(key.secret, plain)).toBytes()
  return packet(PayloadType.GrpTxt, payload, path)
}

function detail<K extends PacketDetail['kind']>(raw: Uint8Array, ctx: AnalyzeContext, kind: K): Extract<PacketDetail, { kind: K }> {
  const d = analyzePacket(raw, ctx).detail
  expect(d.kind).toBe(kind)
  return d as Extract<PacketDetail, { kind: K }>
}

describe('channel crypto, against the C++ reference', () => {
  it('hashes and opens channel payloads, 16- and 32-byte secrets alike', () => {
    for (const r of golden.channel) {
      const psk = fromHex(r.psk)
      expect(channelHash(psk).toString(16).padStart(2, '0')).toBe(r.hash)
      expect(toHex(macThenDecrypt(psk, fromHex(r.in))!)).toBe(r.plain)
    }
  })

  it('encrypts then MACs byte for byte', () => {
    for (const r of golden.encryptThenMac) expect(toHex(encryptThenMac(fromHex(r.secret), fromHex(r.plain)))).toBe(r.out)
  })

  it('accepts and refuses the same MACs', () => {
    for (const r of golden.macThenDecrypt) {
      const plain = macThenDecrypt(fromHex(r.secret), fromHex(r.in))
      if (r.valid) expect(toHex(plain!)).toBe(r.plain)
      else expect(plain).toBeNull()
    }
  })

  it('builds group payloads the way createGroupDatagram does', () => {
    for (const r of golden.builder.filter((b) => b.kind === 'group')) {
      const psk = fromHex(r.psk!)
      const payload = new ByteWriter().u8(channelHash(psk)).bytes(encryptThenMac(psk, fromHex(r.data!))).toBytes()
      expect(toHex(payload)).toBe(r.payload)
    }
  })

  it('derives hashtag keys from the name, # included', () => {
    expect(toHex(hashtagSecret('#test'))).toBe('9cd8fcf22a47333b591d96a2b848b73f')
    expect(hashtagKey('#austin')).toMatchObject({ hash: 0xf2, source: 'hashtag' })
    expect(PUBLIC.hash).toBe(0x11)
    expect(normalizeHashtag(' hiking ')).toBe('#hiking')
    expect(normalizeHashtag('#hiking')).toBe('#hiking')
    expect(normalizeHashtag('#')).toBeNull()
    expect(normalizeHashtag('two words')).toBeNull()
  })
})

describe('analyzePacket framing, against the C++ reference', () => {
  it('flags exactly the frames Packet::readFrom refuses', () => {
    for (const r of golden.packetParse) expect(analyzePacket(fromHex(r.frame), NONE).malformed, r.frame).toBe(!r.valid)
  })

  it('computes Packet::calculatePacketHash, traces included', () => {
    for (const r of golden.packetHash) expect(analyzePacket(fromHex(r.frame), NONE).hash, r.frame).toBe(r.hash)
  })

  it('gives every field its own bytes, in order, covering the packet', () => {
    for (const r of golden.packetParse.filter((p) => p.valid)) {
      const raw = fromHex(r.frame)
      const { fields } = analyzePacket(raw, NONE)
      let at = 0
      for (const f of fields) {
        expect(f.start).toBe(at)
        at += f.length
      }
      expect(at).toBe(raw.length)
    }
  })

  it('reads transport codes and multi-byte path hashes', () => {
    const raw = new ByteWriter().u8((PayloadType.Ack << 2) | 0).u16(0x1234).u16(0xabcd).u8((1 << 6) | 2)
      .bytes([0xa1, 0xa1, 0x5c, 0x07]).u32(0x0badf00d).toBytes()
    const a = analyzePacket(raw, { keys: [], nodes: [{ publicKey: 'a1a1' + '00'.repeat(30), name: 'Hilltop' }] })
    expect(a.path).toEqual(['a1a1', '5c07'])
    expect(a.fields.map((f) => f.label)).toEqual(['header', 'transport code 1', 'transport code 2', 'path length', 'path', 'ack checksum'])
    expect(a.fields[4].value).toBe('a1a1 (Hilltop) → 5c07')
    expect(a.summary).toBe('ack 0badf00d')
  })
})

describe('group packets', () => {
  const ts = 1792875600 // 2026-10-24 21:00 UTC

  it('opens a Public post and lays out its plaintext', () => {
    const raw = groupPacket(PUBLIC, ts, 'Maya: hello from the hilltop', [0xa1, 0x5c])
    expect(toHex(raw)).toBe(
      '1502a15c114bae16e1f5940ff289eacb1bea1a67b72f4b906bb7bedd09506f104a475d8fbeedab8b4d8cf9622ed399ac67d2c573cbacf1',
    )
    const a = analyzePacket(raw, { keys: [PUBLIC], nodes: [] })
    expect(a.summary).toBe('Public: Maya: hello from the hilltop')
    expect(a.problem).toBeUndefined()
    const d = detail(raw, { keys: [PUBLIC], nodes: [] }, 'group')
    expect(d.channel?.name).toBe('Public')
    expect(d.text).toEqual({ timestamp: ts, txtType: 0, attempt: 0, text: 'Maya: hello from the hilltop' })
    expect(d.plainFields.map((f) => [f.label, f.start, f.length])).toEqual([
      ['timestamp', 0, 4], ['flags', 4, 1], ['text', 5, 28], ['padding', 33, 15],
    ])
    expect(d.plainFields[0].value).toBe('2026-10-24 21:00:00 UTC')
  })

  it('says when no key has the hash byte', () => {
    const raw = groupPacket(hashtagKey('#hiking'), ts, 'Tom: on the trail')
    expect(analyzePacket(raw, { keys: [PUBLIC], nodes: [] }).summary).toBe('channel a2: no key')
    expect(analyzePacket(raw, { keys: [PUBLIC, hashtagKey('#hiking')], nodes: [] }).summary).toBe('#hiking: Tom: on the trail')
  })

  it('tells a hash collision from a match by the MAC', () => {
    // a hashtag whose hash byte is Public's 0x11, but a different key
    let n = 0
    while (hashtagKey(`#c${n}`).hash !== PUBLIC.hash) n++
    const impostor = hashtagKey(`#c${n}`)
    const raw = groupPacket(PUBLIC, ts, 'Maya: hi')
    const d = detail(raw, { keys: [impostor, PUBLIC], nodes: [] }, 'group')
    expect(d.tried.map((k) => k.name)).toEqual([impostor.name, 'Public'])
    expect(d.channel?.name).toBe('Public')
    expect(analyzePacket(raw, { keys: [impostor], nodes: [] }).summary).toBe(`channel 11: MAC doesn't match ${impostor.name}`)
  })

  it('reads group data', () => {
    const plain = new ByteWriter().u16(0x0102).u8(3).bytes([9, 8, 7]).toBytes()
    const raw = packet(PayloadType.GrpData, new ByteWriter().u8(PUBLIC.hash).bytes(encryptThenMac(PUBLIC.secret, plain)).toBytes())
    const d = detail(raw, { keys: [PUBLIC], nodes: [] }, 'group')
    expect(d.data?.dataType).toBe(0x0102)
    expect(Array.from(d.data!.data)).toEqual([9, 8, 7])
  })

  it('names ciphertext no key can open', () => {
    expect(analyzePacket(packet(PayloadType.GrpTxt, fromHex('426ebc')), NONE).problem).toBe('no ciphertext, so the radio ignores it')
    expect(analyzePacket(packet(PayloadType.GrpTxt, fromHex('11aabb' + '00'.repeat(15))), NONE).problem).toMatch(/whole 16-byte blocks/)
  })
})

describe('adverts', () => {
  const advert = (appdata: Uint8Array) => packet(PayloadType.Advert, new ByteWriter().bytes(new Uint8Array(32).fill(7)).u32(1).bytes(new Uint8Array(64)).bytes(appdata).toBytes())

  it('checks signatures like the firmware', () => {
    for (const r of golden.advertVerify) {
      const a = analyzePacket(packet(PayloadType.Advert, fromHex(r.payload)), NONE)
      if (a.detail.kind === 'advert') expect(a.detail.signatureOk, r.payload).toBe(r.valid)
      else expect(a.problem).toMatch(/ends inside/)
    }
  })

  it('parses app data like AdvertDataParser', () => {
    for (const r of golden.advertAppdata) {
      const d = detail(advert(fromHex(r.appdata)), NONE, 'advert')
      if (!r.valid) {
        expect(d.name).toBeUndefined()
        continue
      }
      expect(d.advType).toBe(r.adv_type)
      if (r.has_loc) expect([Math.round(d.lat! * 1e6), Math.round(d.lon! * 1e6)]).toEqual([r.lat, r.lon])
      const name = cString(fromHex(r.name_hex!))
      expect(d.name ?? '').toBe(name)
    }
  })

  it('summarizes a signed advert and spots this radio', () => {
    const a = analyzePacket(advert(new ByteWriter().u8(0x92).u32(30284900).u32(-97734100).string('Hilltop').toBytes()), NONE)
    expect(a.summary).toBe('Hilltop · repeater · 30.28490, -97.73410 · forged signature')
    const self = analyzePacket(advert(Uint8Array.of(0x81)), { keys: [], nodes: [], selfKey: '07'.repeat(32) })
    expect(self.summary).toMatch(/^this radio · companion/)
  })
})

describe('other payloads, against the C++ builders', () => {
  const nodes = [
    { publicKey: '4f' + '11'.repeat(31), name: 'Alex' },
    { publicKey: '68' + '22'.repeat(31), name: 'Sam' },
  ]

  it('addresses datagrams by key prefix', () => {
    for (const r of golden.builder.filter((b) => b.kind === 'datagram' || b.kind === 'path')) {
      const d = detail(packet(r.ptype, fromHex(r.payload)), { keys: [], nodes }, 'datagram')
      expect([d.dest, d.src]).toEqual([r.dest, r.src])
    }
    const raw = packet(PayloadType.TxtMsg, fromHex(golden.builder.find((b) => b.kind === 'datagram' && b.payload.length > 8)!.payload))
    expect(analyzePacket(raw, { keys: [], nodes }).summary).toBe('to 4f (Alex) from 68 (Sam)')
  })

  it('reads the anonymous sender key', () => {
    for (const r of golden.builder.filter((b) => b.kind === 'anon')) {
      const d = detail(packet(PayloadType.AnonReq, fromHex(r.payload)), NONE, 'anon')
      expect([d.dest, d.senderKey]).toEqual([r.dest, r.sender_pub])
    }
  })

  it('reads traces, with SNRs from the path', () => {
    for (const r of golden.builder.filter((b) => b.kind === 'trace')) {
      const d = detail(packet(PayloadType.Trace, fromHex(r.payload), [], 2), NONE, 'trace')
      expect([d.tag, d.authCode, d.hashSize]).toEqual([r.tag, r.auth_code, 1 << (r.flags! & 3)])
    }
    const raw = packet(PayloadType.Trace, fromHex('0d29a7b6a896bb6200' + '4f68'), [29, 0xf4], 2)
    const d = detail(raw, { keys: [], nodes }, 'trace')
    expect(d.route).toEqual(['4f', '68'])
    expect(d.snrs).toEqual([7.25, -3])
  })

  it('reads acks, multipart acks and discovery', () => {
    for (const r of golden.builder.filter((b) => b.kind === 'ack' && b.payload.length === 8)) {
      expect(detail(packet(PayloadType.Ack, fromHex(r.payload)), NONE, 'ack').crc).toBe(r.payload.match(/../g)!.reverse().join(''))
    }
    for (const r of golden.builder.filter((b) => b.kind === 'multi_ack' && b.payload.length === 10)) {
      expect(detail(packet(PayloadType.Multipart, fromHex(r.payload)), NONE, 'multipart')).toMatchObject({ remaining: r.remaining, innerType: PayloadType.Ack })
    }
    const req = new ByteWriter().u8(0x81).u8(1 << 2).u32(0xcafe).toBytes()
    expect(detail(packet(PayloadType.Control, req, [], 2), NONE, 'discover-request')).toMatchObject({ prefixOnly: true, typeFilter: 4, tag: 0xcafe })
    const resp = new ByteWriter().u8(0x92).u8(-12 & 0xff).u32(0xcafe).bytes(fromHex('4f'.padEnd(16, '1'))).toBytes()
    const a = analyzePacket(packet(PayloadType.Control, resp, [], 2), { keys: [], nodes })
    expect(a.summary).toBe('repeater 4f111111… answered, heard at -3 dB')
  })

  it('hashes traces with their path length', () => {
    const payload = fromHex('0d29a7b6a896bb6200')
    expect(packetHash(PayloadType.Trace, 0, payload)).not.toBe(packetHash(PayloadType.Trace, 1, payload))
  })
})
