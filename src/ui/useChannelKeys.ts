import { useCallback, useMemo, useState } from 'react'
import { toHex } from '../protocol/bytes.ts'
import { channelKey, hashtagKey, normalizeHashtag, PUBLIC_CHANNEL_SECRET, type ChannelKey } from '../protocol/crypto.ts'
import type { ChannelInfo } from '../protocol/messages.ts'

const STORAGE_KEY = 'meshcore-console:v1:hashtags'

function loadHashtags(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Every channel key the console can try on received packets: the radio's slots, the well-known Public key, and
 * hashtag names typed into the packet analyzer (kept in localStorage, for every radio). A secret already in a radio
 * slot isn't repeated, so a match names the slot.
 */
export function useChannelKeys(channels: ChannelInfo[] | undefined) {
  const [hashtags, setHashtags] = useState<string[]>(loadHashtags)

  const save = useCallback((next: string[]) => {
    setHashtags(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }, [])

  const keys = useMemo(() => {
    const out: ChannelKey[] = []
    const seen = new Set<string>()
    const add = (k: ChannelKey) => {
      const id = toHex(k.secret)
      if (seen.has(id)) return
      seen.add(id)
      out.push(k)
    }
    for (const c of channels ?? []) {
      if (/[^0]/.test(c.secret)) add({ ...channelKey(c.name || `slot ${c.index}`, c.secret, 'radio', c.index), unnamed: !c.name })
    }
    add(channelKey('Public', PUBLIC_CHANNEL_SECRET, 'public'))
    for (const name of hashtags) add(hashtagKey(name))
    return out
  }, [channels, hashtags])

  /** Returns an error message, or undefined once the name is added. */
  const addHashtag = useCallback(
    (input: string): string | undefined => {
      const name = normalizeHashtag(input)
      if (!name) return 'a hashtag is one word, like #hiking'
      if (!hashtags.includes(name)) save([...hashtags, name])
      return undefined
    },
    [hashtags, save],
  )

  const removeHashtag = useCallback((name: string) => save(hashtags.filter((h) => h !== name)), [hashtags, save])

  return { keys, hashtags, addHashtag, removeHashtag }
}

export type ChannelKeys = ReturnType<typeof useChannelKeys>
