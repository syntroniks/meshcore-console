// Channel keys the way people share them: meshcore:// links (docs/qr_codes.md in the firmware repo), 32 hex
// characters, or base64 like the firmware's built-in Public key.

import { fromHex, toHex } from './bytes.ts'

/** ChannelDetails.name is 32 bytes with its NUL (BaseChatMesh.h). */
export const MAX_CHANNEL_NAME_BYTES = 31

const utf8 = new TextEncoder()

export function nameBytes(name: string): number {
  return utf8.encode(name).length
}

/** A 16-byte key from 32 hex characters or base64; null for anything else, and for an all-zero key (an empty slot). */
export function parseSecret(text: string): Uint8Array | null {
  const t = text.trim()
  let key: Uint8Array | null = null
  if (/^(0x)?[0-9a-f]{32}$/i.test(t)) {
    key = fromHex(t.replace(/^0x/i, ''))
  } else if (/^[A-Za-z0-9+/_-]{22}(==)?$/.test(t)) {
    try {
      key = Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/').padEnd(24, '=')), (c) => c.charCodeAt(0))
    } catch {
      key = null
    }
  }
  return key && key.length === 16 && key.some((b) => b !== 0) ? key : null
}

/** meshcore://channel/add?name=<name>&secret=<32 hex> */
export function parseChannelLink(text: string): { name: string; secret: Uint8Array } | null {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'meshcore:' || `${url.host}${url.pathname}` !== 'channel/add') return null
  const name = url.searchParams.get('name') ?? ''
  const secret = parseSecret(url.searchParams.get('secret') ?? '')
  return name && secret ? { name, secret } : null
}

export function channelLink(name: string, secret: Uint8Array): string {
  return `meshcore://channel/add?${new URLSearchParams({ name, secret: toHex(secret) })}`
}

export function randomSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}
