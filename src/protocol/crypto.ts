// MeshCore payload crypto, as in src/Utils.cpp and src/helpers/BaseChatMesh.cpp (firmware v1.18.0).
// Payloads are AES-128-ECB with zero padding, prefixed by a 2-byte truncated HMAC-SHA256 of the ciphertext. The AES key
// is the first 16 bytes of the secret; the HMAC key is the secret zero-extended to 32 bytes. Channel secrets are 16
// bytes, direct-message secrets are 32 (an X25519 shared secret).

import { ecb } from '@noble/ciphers/aes.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex } from './bytes.ts'

export const MAC_SIZE = 2
export const BLOCK_SIZE = 16

/** The well-known key every radio ships with in slot 0 ("izOH6cXN6mrJ5e26oRXNcg==", MyMesh.cpp). */
export const PUBLIC_CHANNEL_SECRET = '8b3387e9c5cdea6ac9e5edbaa115cd72'

const utf8 = new TextEncoder()

function macKey(secret: Uint8Array): Uint8Array {
  const k = new Uint8Array(32)
  k.set(secret.subarray(0, 32))
  return k
}

function mac(secret: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return hmac(sha256, macKey(secret), ciphertext).subarray(0, MAC_SIZE)
}

/** Utils::encryptThenMAC: MAC(2) + ciphertext, padded with zeroes to whole blocks. */
export function encryptThenMac(secret: Uint8Array, plain: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(plain.length / BLOCK_SIZE) * BLOCK_SIZE)
  padded.set(plain)
  const ciphertext = ecb(secret.subarray(0, 16), { disablePadding: true }).encrypt(padded)
  const out = new Uint8Array(MAC_SIZE + ciphertext.length)
  out.set(mac(secret, ciphertext))
  out.set(ciphertext, MAC_SIZE)
  return out
}

/** Utils::MACThenDecrypt: the plaintext (still zero padded), or null when the MAC doesn't match. */
export function macThenDecrypt(secret: Uint8Array, data: Uint8Array): Uint8Array | null {
  if (data.length <= MAC_SIZE || (data.length - MAC_SIZE) % BLOCK_SIZE) return null
  const ciphertext = data.subarray(MAC_SIZE)
  const expected = mac(secret, ciphertext)
  if (expected[0] !== data[0] || expected[1] !== data[1]) return null
  return ecb(secret.subarray(0, 16), { disablePadding: true }).decrypt(ciphertext)
}

/**
 * First byte of SHA-256 of the secret (BaseChatMesh::setChannel). Sent in the clear with every channel packet, so
 * receivers know which key to try. A 32-byte secret whose second half is zero hashes as 16 bytes.
 */
export function channelHash(secret: Uint8Array): number {
  const long = secret.length > 16 && secret.subarray(16, 32).some((b) => b !== 0)
  return sha256(secret.subarray(0, long ? 32 : 16))[0]
}

/** Hashtag channels have no shared key: it's the first 16 bytes of SHA-256 of the name, '#' included. */
export function hashtagSecret(name: string): Uint8Array {
  return sha256(utf8.encode(name)).slice(0, 16)
}

export interface ChannelKey {
  name: string
  secret: Uint8Array // 16 bytes
  hash: number
  /** where the key came from: a slot on the radio, the well-known Public key, or a hashtag name typed in */
  source: 'radio' | 'public' | 'hashtag'
  slot?: number // radio slot index
  /** a radio slot with a key but no name: BaseChatMesh::searchChannelsByHash skips it, so its posts never arrive */
  unnamed?: boolean
}

export function channelKey(name: string, secretHex: string, source: ChannelKey['source'], slot?: number): ChannelKey {
  const secret = fromHex(secretHex)
  return { name, secret, hash: channelHash(secret), source, slot }
}

export function hashtagKey(name: string): ChannelKey {
  const secret = hashtagSecret(name)
  return { name, secret, hash: channelHash(secret), source: 'hashtag' }
}

/** "austin" or "#austin" -> "#austin"; null for names that can't be hashtags. */
export function normalizeHashtag(input: string): string | null {
  const name = input.trim()
  if (!name || /\s/.test(name)) return null
  return name.startsWith('#') ? (name.length > 1 ? name : null) : `#${name}`
}
