import { describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder } from '../src/protocol/framing.ts'

const fromRadio = (payload: number[]) => Uint8Array.from([0x3e, payload.length & 0xff, payload.length >> 8, ...payload])

describe('encodeFrame', () => {
  it('prefixes "<" and a little-endian length', () => {
    expect([...encodeFrame(Uint8Array.of(22, 3))]).toEqual([0x3c, 2, 0, 22, 3])
  })

  it('rejects empty and oversized payloads', () => {
    expect(() => encodeFrame(new Uint8Array(0))).toThrow(RangeError)
    expect(() => encodeFrame(new Uint8Array(177))).toThrow(RangeError)
  })
})

describe('FrameDecoder', () => {
  it('reassembles a frame split across chunks', () => {
    const d = new FrameDecoder()
    const bytes = fromRadio([13, 14, 175, 40])
    expect(d.push(bytes.slice(0, 2))).toEqual([])
    expect(d.push(bytes.slice(2, 5))).toEqual([])
    expect(d.push(bytes.slice(5)).map((f) => [...f])).toEqual([[13, 14, 175, 40]])
  })

  it('returns several frames from one chunk', () => {
    const d = new FrameDecoder()
    const chunk = Uint8Array.from([...fromRadio([0]), ...fromRadio([29, 0x4f, 0x4b])])
    expect(d.push(chunk).map((f) => [...f])).toEqual([[0], [29, 0x4f, 0x4b]])
  })

  it('skips text outside frames, like ROM boot output', () => {
    const d = new FrameDecoder()
    const noise = new TextEncoder().encode('ESP-ROM:esp32s3\r\nboot:0x8\r\n')
    const chunk = Uint8Array.from([...noise, ...fromRadio([9, 1, 2, 3, 4])])
    expect(d.push(chunk).map((f) => [...f])).toEqual([[9, 1, 2, 3, 4]])
  })

  it('resyncs after a ">" with an impossible length', () => {
    const d = new FrameDecoder()
    // '>' followed by length 0xffff is noise; the real frame comes after it
    const chunk = Uint8Array.from([0x3e, 0xff, 0xff, ...fromRadio([5, 6])])
    expect(d.push(chunk).map((f) => [...f])).toEqual([[5, 6]])
  })
})
