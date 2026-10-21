// Serial framing for the companion protocol over USB / UART / TCP:
//   app -> radio:  '<' len_lo len_hi payload
//   radio -> app:  '>' len_lo len_hi payload

import { MAX_FRAME_SIZE } from './codes.ts'

export const TO_RADIO = 0x3c // '<'
export const FROM_RADIO = 0x3e // '>'

export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length === 0 || payload.length > MAX_FRAME_SIZE) {
    throw new RangeError(`frame payload must be 1-${MAX_FRAME_SIZE} bytes, got ${payload.length}`)
  }
  const out = new Uint8Array(3 + payload.length)
  out[0] = TO_RADIO
  out[1] = payload.length & 0xff
  out[2] = payload.length >> 8
  out.set(payload, 3)
  return out
}

/**
 * Splits the radio's byte stream into frame payloads. Bytes outside a frame (eg. ROM boot messages)
 * are skipped, and a header with an impossible length is treated as noise so the decoder resyncs.
 */
export class FrameDecoder {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)

    const frames: Uint8Array[] = []
    let i = 0
    while (i < merged.length) {
      if (merged[i] !== FROM_RADIO) {
        i++
        continue
      }
      if (merged.length - i < 3) break // header incomplete
      const len = merged[i + 1] | (merged[i + 2] << 8)
      if (len === 0 || len > MAX_FRAME_SIZE) {
        i++ // not a real header
        continue
      }
      if (merged.length - i - 3 < len) break // payload incomplete
      frames.push(merged.slice(i + 3, i + 3 + len))
      i += 3 + len
    }
    this.buf = merged.slice(i)
    return frames
  }

  reset(): void {
    this.buf = new Uint8Array(0)
  }
}
