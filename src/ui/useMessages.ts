import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toHex } from '../protocol/bytes.ts'
import { Push } from '../protocol/codes.ts'
import type { MeshCoreClient } from '../protocol/client.ts'
import { parseSendConfirmed, splitChannelText, type ChannelInfo, type Contact, type IncomingMessage } from '../protocol/messages.ts'

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'failed'

export interface ChatMessage {
  id: string
  conv: string // 'ch:<index>' or 'dm:<first 6 bytes of the contact key, hex>'
  dir: 'in' | 'out'
  text: string
  sender?: string // channel posts carry the poster's name inline
  authorPrefix?: string // signed room-server posts: the original author
  ts: number // unix secs: the sender's timestamp, or ours when sending
  at: number // local ms when received or sent
  snr?: number
  hops?: number | null // null = arrived by a direct route
  status?: MessageStatus
  flood?: boolean
  ack?: number
  timeoutMs?: number
  tripMs?: number
  attempt?: number
  error?: string
}

export interface Conversation {
  id: string
  kind: 'channel' | 'direct'
  title: string
  contact?: Contact
  channel?: ChannelInfo
  last?: ChatMessage
  unread: number
}

const MAX_STORED = 5000
const storageKey = (selfKey: string, what: 'messages' | 'read') => `meshcore-console:v1:${what}:${selfKey.slice(0, 16)}`

export const dmConv = (publicKey: string) => `dm:${publicKey.slice(0, 12)}`
export const chConv = (index: number) => `ch:${index}`

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function fromIncoming(m: IncomingMessage): ChatMessage {
  const base = { id: crypto.randomUUID(), dir: 'in' as const, ts: m.senderTimestamp, at: Date.now(), snr: m.snr, hops: m.hops }
  if (m.kind === 'direct') {
    return { ...base, conv: `dm:${m.senderPrefix}`, text: m.text, authorPrefix: m.authorPrefix }
  }
  if (m.kind === 'channel') {
    const { sender, body } = splitChannelText(m.text)
    return { ...base, conv: chConv(m.channelIndex ?? 0), text: body, sender }
  }
  const bytes = m.data ? `${m.data.length} bytes` : 'no data'
  return { ...base, conv: chConv(m.channelIndex ?? 0), text: `[binary data, type 0x${(m.dataType ?? 0).toString(16)}, ${bytes}: ${toHex(m.data ?? new Uint8Array()).slice(0, 32)}]` }
}

export function useMessages(client: MeshCoreClient | null, selfKey: string | undefined, contacts: Contact[] | undefined, channels: ChannelInfo[] | undefined) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [readMarks, setReadMarks] = useState<Record<string, number>>({})
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string>()
  const messagesRef = useRef<ChatMessage[]>([])
  const keyRef = useRef<string | undefined>(undefined)
  const syncState = useRef({ running: false, again: false })
  const ackTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  // write-through: a synced message is gone from the radio, so it's saved before anything else happens
  const commit = useCallback((next: ChatMessage[]) => {
    const trimmed = next.length > MAX_STORED ? next.slice(next.length - MAX_STORED) : next
    messagesRef.current = trimmed
    if (keyRef.current) localStorage.setItem(storageKey(keyRef.current, 'messages'), JSON.stringify(trimmed))
    setMessages(trimmed)
  }, [])

  const update = useCallback(
    (id: string, patch: Partial<ChatMessage>) => commit(messagesRef.current.map((m) => (m.id === id ? { ...m, ...patch } : m))),
    [commit],
  )

  // load this node's history when its key is known
  useEffect(() => {
    keyRef.current = selfKey
    if (!selfKey) return
    messagesRef.current = load<ChatMessage[]>(storageKey(selfKey, 'messages'), [])
    setMessages(messagesRef.current)
    setReadMarks(load<Record<string, number>>(storageKey(selfKey, 'read'), {}))
  }, [selfKey])

  const sync = useCallback(async () => {
    const c = client
    const st = syncState.current
    if (!c?.isOpen || !keyRef.current) return
    if (st.running) {
      st.again = true // the radio got more while we were syncing
      return
    }
    st.running = true
    setSyncing(true)
    setSyncError(undefined)
    try {
      do {
        st.again = false
        for (let m = await c.syncNextMessage(); m; m = await c.syncNextMessage()) {
          commit([...messagesRef.current, fromIncoming(m)])
        }
      } while (st.again)
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err))
    } finally {
      st.running = false
      setSyncing(false)
    }
  }, [client, commit])

  // sync on connect, and whenever the radio says a message is waiting; mark DMs delivered on ACK
  useEffect(() => {
    if (!client || !selfKey) return
    void sync()
    const off = client.on('push', (f) => {
      if (f[0] === Push.MsgWaiting) {
        void sync()
      } else if (f[0] === Push.SendConfirmed) {
        const { ack, tripMs } = parseSendConfirmed(f)
        const m = messagesRef.current.find((x) => x.dir === 'out' && x.ack === ack && x.status !== 'delivered')
        if (m) {
          clearTimeout(ackTimers.current.get(m.id))
          update(m.id, { status: 'delivered', tripMs, error: undefined })
        }
      }
    })
    return off
  }, [client, selfKey, sync, update])

  useEffect(() => () => ackTimers.current.forEach(clearTimeout), [])

  const sendDirect = useCallback(
    async (contact: Contact, text: string, retryOf?: ChatMessage) => {
      if (!client?.isOpen) throw new Error('not connected')
      const attempt = retryOf ? (retryOf.attempt ?? 0) + 1 : 0
      const ts = retryOf?.ts ?? Math.floor(Date.now() / 1000) // same timestamp lets the recipient drop duplicates
      let id = retryOf?.id
      if (id) {
        update(id, { status: 'sending', attempt, error: undefined, at: Date.now() })
      } else {
        id = crypto.randomUUID()
        commit([...messagesRef.current, { id, conv: dmConv(contact.publicKey), dir: 'out', text, ts, at: Date.now(), status: 'sending', attempt }])
      }
      const msgId = id
      try {
        const sent = await client.sendText(contact.publicKey, text, ts, attempt)
        update(msgId, { status: 'sent', flood: sent.flood, ack: sent.expectedAck, timeoutMs: sent.timeoutMs })
        // give the ACK some slack past the radio's own estimate before calling it lost
        const wait = Math.max(sent.timeoutMs * 1.5, 8000)
        ackTimers.current.set(
          msgId,
          setTimeout(() => {
            const m = messagesRef.current.find((x) => x.id === msgId)
            if (m?.status === 'sent') update(msgId, { status: 'failed', error: 'no ACK' })
          }, wait),
        )
      } catch (err) {
        update(msgId, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    },
    [client, commit, update],
  )

  const sendChannel = useCallback(
    async (channel: ChannelInfo, text: string) => {
      if (!client?.isOpen) throw new Error('not connected')
      const id = crypto.randomUUID()
      const ts = Math.floor(Date.now() / 1000)
      commit([...messagesRef.current, { id, conv: chConv(channel.index), dir: 'out', text, ts, at: Date.now(), status: 'sending' }])
      try {
        await client.sendChannelText(channel.index, text, ts)
        update(id, { status: 'sent', flood: true })
      } catch (err) {
        update(id, { status: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    },
    [client, commit, update],
  )

  const markRead = useCallback((conv: string) => {
    setReadMarks((marks) => {
      const next = { ...marks, [conv]: Date.now() }
      if (keyRef.current) localStorage.setItem(storageKey(keyRef.current, 'read'), JSON.stringify(next))
      return next
    })
  }, [])

  const clearConversation = useCallback(
    (conv: string) => commit(messagesRef.current.filter((m) => m.conv !== conv)),
    [commit],
  )

  const conversations = useMemo((): Conversation[] => {
    const lastByConv = new Map<string, ChatMessage>()
    const unreadByConv = new Map<string, number>()
    for (const m of messages) {
      lastByConv.set(m.conv, m)
      if (m.dir === 'in' && m.at > (readMarks[m.conv] ?? 0)) unreadByConv.set(m.conv, (unreadByConv.get(m.conv) ?? 0) + 1)
    }
    const conv = (id: string, kind: Conversation['kind'], title: string, extra: Partial<Conversation>): Conversation => ({
      id, kind, title, last: lastByConv.get(id), unread: unreadByConv.get(id) ?? 0, ...extra,
    })
    const list: Conversation[] = (channels ?? []).map((ch) => conv(chConv(ch.index), 'channel', ch.name || `channel ${ch.index}`, { channel: ch }))
    const known = new Set(list.map((c) => c.id))
    for (const ct of contacts ?? []) {
      const id = dmConv(ct.publicKey)
      if (known.has(id)) continue
      // companions can always be messaged; others only appear once they've sent something
      if (ct.type === 1 || lastByConv.has(id)) {
        list.push(conv(id, 'direct', ct.name, { contact: ct }))
        known.add(id)
      }
    }
    for (const id of lastByConv.keys()) {
      if (!known.has(id)) list.push(conv(id, id.startsWith('ch:') ? 'channel' : 'direct', id.startsWith('ch:') ? `channel ${id.slice(3)}` : `unknown ${id.slice(3)}`, {}))
    }
    return list
  }, [messages, readMarks, contacts, channels])

  const unreadTotal = conversations.reduce((n, c) => n + c.unread, 0)

  return { messages, conversations, unreadTotal, syncing, syncError, sync, sendDirect, sendChannel, markRead, clearConversation }
}
