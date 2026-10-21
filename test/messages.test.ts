// Frames here are built field by field in the firmware's memcpy order (MyMesh.cpp, v1.18.0).

import { describe, expect, it } from 'vitest'
import { ByteWriter, fromHex } from '../src/protocol/bytes.ts'
import { Push, Resp } from '../src/protocol/codes.ts'
import {
  commands,
  decodePacket,
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
