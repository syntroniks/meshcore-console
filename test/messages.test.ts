// Frames here are built field by field in the firmware's memcpy order (MyMesh.cpp, v1.18.0).

import { describe, expect, it } from 'vitest'
import { ByteReader, ByteWriter, fromHex, toHex } from '../src/protocol/bytes.ts'
import { channelLink, parseChannelLink, parseSecret } from '../src/protocol/channels.ts'
import { Push, Resp, TxtType } from '../src/protocol/codes.ts'
import {
  commands,
  decodePacket,
  parseIncomingMessage,
  parseSendConfirmed,
  parseSent,
  splitChannelText,
  parseContact,
  parseCoreStats,
  parseCustomVars,
  parseDefaultFloodScope,
  parseDeviceInfo,
  parseRadioStats,
  parseRxLog,
  parseSelfInfo,
} from '../src/protocol/messages.ts'

const KEY = 'e9248280bc40f693' + '00'.repeat(24)

describe('parseDeviceInfo', () => {
  it('reads a v1.18.0 device info frame, including the v9+/v10+ trailing bytes', () => {
    const f = new ByteWriter()
      .u8(Resp.DeviceInfo).u8(14).u8(175).u8(40).u32(0)
      .fixedString('15-Oct-2026', 12).fixedString('Heltec V4 OLED', 40).fixedString('v1.18.0-81dbae5', 20)
      .u8(0).u8(1).toBytes()
    expect(parseDeviceInfo(f)).toEqual({
      protocolVersion: 14,
      maxContacts: 350,
      maxChannels: 40,
      blePin: 0,
      buildDate: '15-Oct-2026',
      manufacturer: 'Heltec V4 OLED',
      firmwareVersion: 'v1.18.0-81dbae5',
      clientRepeat: false,
      pathHashMode: 1,
    })
  })

  it('accepts older firmware without the trailing bytes', () => {
    const f = new ByteWriter().u8(Resp.DeviceInfo).u8(8).u8(50).u8(8).u32(123456)
      .fixedString('1-Jan-2026', 12).fixedString('RAK 4631', 40).fixedString('v1.10.0', 20).toBytes()
    const info = parseDeviceInfo(f)
    expect(info.blePin).toBe(123456)
    expect(info.clientRepeat).toBeUndefined()
    expect(info.pathHashMode).toBeUndefined()
  })
})

describe('parseSelfInfo', () => {
  it('reads identity, position, packed telemetry modes, radio params and a UTF-8 name', () => {
    const f = new ByteWriter()
      .u8(Resp.SelfInfo).u8(1).u8(22).u8(22).bytes(fromHex(KEY))
      .u32(30267153).u32(-97743057) // lat/lon * 1e6
      .u8(1).u8(1).u8((2 << 4) | (1 << 2) | 0).u8(1)
      .u32(910525).u32(62500).u8(7).u8(5)
      .string('🎅').toBytes()
    const s = parseSelfInfo(f)
    expect(s.publicKey).toBe(KEY)
    expect(s.lat).toBeCloseTo(30.267153)
    expect(s.lon).toBeCloseTo(-97.743057)
    expect(s.telemetry).toEqual({ base: 0, location: 1, environment: 2 })
    expect(s.radio).toEqual({ freqMHz: 910.525, bwKHz: 62.5, sf: 7, cr: 5 })
    expect(s.name).toBe('🎅')
  })
})

describe('parseContact', () => {
  const contact = (outPathLen: number) =>
    new ByteWriter()
      .u8(Resp.Contact).bytes(fromHex(KEY)).u8(2).u8(0).u8(outPathLen)
      .bytes(Uint8Array.from({ length: 64 }, (_, i) => i + 1))
      .fixedString('UT2 AustinMesh.org', 32).u32(1792600000).u32(0).u32(0).u32(1792600100).toBytes()

  it('treats out_path_len 0xff as no known path', () => {
    const c = parseContact(contact(0xff))
    expect(c.name).toBe('UT2 AustinMesh.org')
    expect(c.outPath).toEqual({ known: false, hops: 0, hashSize: 1, path: '' })
    expect(c.lastAdvert).toBe(1792600000)
    expect(c.lastModified).toBe(1792600100)
  })

  it('decodes multi-byte path hashes from the top two bits', () => {
    // 0b01_000011: 2-byte hashes, 3 hops -> 6 path bytes
    expect(parseContact(contact(0x43)).outPath).toEqual({ known: true, hops: 3, hashSize: 2, path: '010203040506' })
  })
})

describe('stats', () => {
  it('reads core stats', () => {
    const f = new ByteWriter().u8(Resp.Stats).u8(0).u16(4069).u32(596).u16(0).u8(2).toBytes()
    expect(parseCoreStats(f)).toEqual({ batteryMv: 4069, uptimeSecs: 596, errFlags: 0, queueLen: 2 })
  })

  it('reads signed radio stats, with SNR in quarter dB', () => {
    const f = new ByteWriter().u8(Resp.Stats).u8(1).u16(-106).u8(-61).u8(-75).u32(12).u32(340).toBytes()
    expect(parseRadioStats(f)).toEqual({ noiseFloorDbm: -106, lastRssiDbm: -61, lastSnrDb: -18.75, txAirSecs: 12, rxAirSecs: 340 })
  })
})

describe('small replies', () => {
  it('splits custom vars', () => {
    const f = new ByteWriter().u8(Resp.CustomVars).string('gps:1,gps_interval:30').toBytes()
    expect(parseCustomVars(f)).toEqual({ gps: '1', gps_interval: '30' })
    expect(parseCustomVars(Uint8Array.of(Resp.CustomVars))).toEqual({})
  })

  it('reads an unset default flood scope as null', () => {
    expect(parseDefaultFloodScope(Uint8Array.of(Resp.DefaultFloodScope))).toBeNull()
  })
})

describe('packets', () => {
  it('decodes a flood advert header and path', () => {
    // header: version 0, payload type 4 (advert), route 1 (flood); path_len 2 (1-byte hashes)
    const raw = Uint8Array.from([(4 << 2) | 1, 2, 0xaa, 0xbb, 1, 2, 3, 4, 5])
    expect(decodePacket(raw)).toMatchObject({ routeName: 'flood', payloadName: 'advert', hops: 2, path: 'aabb', payloadLength: 5 })
  })

  it('reads transport codes on transport routes', () => {
    const raw = Uint8Array.from([(5 << 2) | 0, 0x34, 0x12, 0x78, 0x56, 0, 9, 9])
    expect(decodePacket(raw)).toMatchObject({ routeName: 'transport-flood', payloadName: 'group-text', transportCodes: [0x1234, 0x5678], hops: 0 })
  })

  it('returns undefined for a truncated packet instead of throwing', () => {
    expect(decodePacket(Uint8Array.of((4 << 2) | 1, 5, 0xaa))).toBeUndefined()
  })

  it('reads the rx log push', () => {
    const f = Uint8Array.from([Push.LogRxData, 28, -71 & 0xff, (2 << 2) | 2, 0])
    const e = parseRxLog(f)
    expect(e.snr).toBe(7)
    expect(e.rssi).toBe(-71)
    expect(e.packet?.payloadName).toBe('text')
  })
})

describe('commands', () => {
  it('builds app start with 7 reserved bytes before the app name', () => {
    expect([...commands.appStart('x')]).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0x78])
  })

  it('builds CLI commands as plain text after the command byte', () => {
    expect(new TextDecoder().decode(commands.runCli('get tx').slice(1))).toBe('get tx')
  })
})

describe('incoming messages', () => {
  it('reads a v3 direct message: SNR, sender prefix, flood path, timestamp, text', () => {
    const f = new ByteWriter().u8(Resp.ContactMsgRecvV3).u8(-10 & 0xff).u16(0).bytes(fromHex('c3c3c3c3c3c3'))
      .u8(2).u8(TxtType.Plain).u32(1792600000).string('are you on the trail?').toBytes()
    expect(parseIncomingMessage(f)).toEqual({
      kind: 'direct', snr: -2.5, senderPrefix: 'c3c3c3c3c3c3', hops: 2, txtType: 0,
      senderTimestamp: 1792600000, authorPrefix: undefined, text: 'are you on the trail?',
    })
  })

  it('treats path_len 0xff as a direct route, and reads the author of signed posts', () => {
    const f = new ByteWriter().u8(Resp.ContactMsgRecvV3).u8(0).u16(0).bytes(fromHex('b2b2b2b2b2b2'))
      .u8(0xff).u8(TxtType.SignedPlain).u32(1).bytes(fromHex('a1b2c3d4')).string('room post').toBytes()
    expect(parseIncomingMessage(f)).toMatchObject({ hops: null, authorPrefix: 'a1b2c3d4', text: 'room post' })
  })

  it('reads the pre-v3 direct format, which has no SNR', () => {
    const f = new ByteWriter().u8(Resp.ContactMsgRecv).bytes(fromHex('010203040506')).u8(0xff).u8(0).u32(5).string('hi').toBytes()
    expect(parseIncomingMessage(f)).toMatchObject({ kind: 'direct', snr: undefined, senderPrefix: '010203040506', text: 'hi' })
  })

  it('reads a v3 channel post and splits off the poster name', () => {
    const f = new ByteWriter().u8(Resp.ChannelMsgRecvV3).u8(28).u16(0).u8(1).u8(3).u8(0).u32(7).string('Maya: repeater looks healthy').toBytes()
    const m = parseIncomingMessage(f)
    expect(m).toMatchObject({ kind: 'channel', snr: 7, channelIndex: 1, hops: 3, text: 'Maya: repeater looks healthy' })
    expect(splitChannelText(m.text)).toEqual({ sender: 'Maya', body: 'repeater looks healthy' })
  })

  it('reads channel data with its type and length', () => {
    const f = new ByteWriter().u8(Resp.ChannelDataRecv).u8(0).u16(0).u8(0).u8(0xff).u16(0x1234).u8(3).bytes([9, 8, 7]).toBytes()
    expect(parseIncomingMessage(f)).toMatchObject({ kind: 'channel-data', dataType: 0x1234, data: Uint8Array.of(9, 8, 7) })
  })

  it('reads the send reply and the delivery push', () => {
    expect(parseSent(new ByteWriter().u8(Resp.Sent).u8(1).u32(0xdeadbeef).u32(8000).toBytes())).toEqual({ flood: true, expectedAck: 0xdeadbeef, timeoutMs: 8000 })
    expect(parseSendConfirmed(new ByteWriter().u8(Push.SendConfirmed).u32(0xdeadbeef).u32(1300).toBytes())).toEqual({ ack: 0xdeadbeef, tripMs: 1300 })
  })
})

describe('write commands', () => {
  it('sends a DM with the 6-byte key prefix, timestamp and attempt', () => {
    const f = commands.sendTxtMsg(KEY, 'hi', 0x01020304, 1)
    expect(Array.from(f.slice(0, 13))).toEqual([2, 0, 1, 4, 3, 2, 1, 0xe9, 0x24, 0x82, 0x80, 0xbc, 0x40])
    expect(new TextDecoder().decode(f.slice(13))).toBe('hi')
  })

  it('always includes the client-repeat byte in radio params, in kHz and Hz', () => {
    const f = commands.setRadioParams({ freqMHz: 910.525, bwKHz: 62.5, sf: 7, cr: 5 }, false)
    const r = new ByteReader(f, 1)
    expect([r.u32(), r.u32(), r.u8(), r.u8(), r.u8(), r.remaining]).toEqual([910525, 62500, 7, 5, 0, 0])
  })

  it('packs telemetry modes into one byte, in the same order the radio reports them', () => {
    const o = { manualAddContacts: 1, telemetry: { base: 2, location: 1, environment: 0 }, advertLocationPolicy: 1, multiAcks: 0 }
    const f = commands.setOtherParams(o)
    expect([...f]).toEqual([38, 1, (0 << 4) | (1 << 2) | 2, 1, 0])
    const self = new ByteWriter().u8(Resp.SelfInfo).u8(1).u8(22).u8(22).bytes(fromHex(KEY)).u32(0).u32(0)
      .u8(0).u8(0).u8(f[2]).u8(0).u32(910525).u32(62500).u8(7).u8(5).string('x').toBytes()
    expect(parseSelfInfo(self).telemetry).toEqual(o.telemetry)
  })

  it('encodes negative TX power and signed coordinates', () => {
    expect([...commands.setTxPower(-9)]).toEqual([12, 0xf7])
    const r = new ByteReader(commands.setAdvertLatLon(-33.8688, 151.2093), 1)
    expect([r.i32(), r.i32()]).toEqual([-33868800, 151209300])
  })

  it('sets the path hash mode with its leading zero byte', () => {
    expect([...commands.setPathHashMode(2)]).toEqual([61, 0, 2])
  })

  it('writes a channel slot as index, NUL-padded 32-byte name, 16-byte key', () => {
    const f = commands.setChannel(3, '#hiking', fromHex('2370a013053e384e5f18918bc2b26baf'))
    expect(f.length).toBe(2 + 32 + 16)
    expect([f[0], f[1]]).toEqual([32, 3])
    expect(new ByteReader(f, 2).fixedString(32)).toBe('#hiking')
    expect(toHex(f.slice(34))).toBe('2370a013053e384e5f18918bc2b26baf')
  })

  it('reads shared channel keys: meshcore:// links, hex and base64', () => {
    const pub = '8b3387e9c5cdea6ac9e5edbaa115cd72'
    expect(toHex(parseSecret('izOH6cXN6mrJ5e26oRXNcg==')!)).toBe(pub)
    expect(toHex(parseSecret(pub.toUpperCase())!)).toBe(pub)
    expect(parseSecret('00'.repeat(16))).toBeNull()
    expect(parseSecret('8b3387')).toBeNull()
    const link = channelLink('Trail crew', fromHex(pub))
    expect(link).toBe(`meshcore://channel/add?name=Trail+crew&secret=${pub}`)
    expect(parseChannelLink(link)).toEqual({ name: 'Trail crew', secret: fromHex(pub) })
    expect(parseChannelLink('meshcore://contact/add?name=x&public_key=00')).toBeNull()
  })
})
