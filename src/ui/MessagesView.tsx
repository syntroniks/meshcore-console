import { useEffect, useMemo, useRef, useState } from 'react'
import { MAX_TEXT_LEN } from '../protocol/codes.ts'
import { Button, Empty } from './parts.tsx'
import type { ChatMessage, Conversation, useMessages } from './useMessages.ts'

type Messages = ReturnType<typeof useMessages>

const utf8Len = (s: string) => new TextEncoder().encode(s).length

function clock(unixSecs: number): string {
  const d = new Date(unixSecs * 1000)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function routeText(m: ChatMessage): string {
  if (m.hops === undefined) return ''
  return m.hops === null ? 'direct' : `${m.hops} hop${m.hops === 1 ? '' : 's'}`
}

export function MessagesView({ msgs, connected, nodeName }: { msgs: Messages; connected: boolean; nodeName?: string }) {
  const [selected, setSelected] = useState<string>()
  const conv = msgs.conversations.find((c) => c.id === selected) ?? msgs.conversations[0]

  // reading a conversation clears its unread count
  useEffect(() => {
    if (conv && conv.unread > 0) msgs.markRead(conv.id)
  }, [conv, msgs])

  const channels = msgs.conversations.filter((c) => c.kind === 'channel')
  const direct = msgs.conversations
    .filter((c) => c.kind === 'direct')
    .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0) || a.title.localeCompare(b.title))

  return (
    <div className="messages">
      <aside className="conv-list">
        <div className="conv-section">
          Channels
          {msgs.syncing && <span className="muted small"> · syncing…</span>}
        </div>
        {channels.map((c) => (
          <ConvItem key={c.id} c={c} active={c.id === conv?.id} onClick={() => setSelected(c.id)} />
        ))}
        <div className="conv-section">Direct</div>
        {direct.length ? (
          direct.map((c) => <ConvItem key={c.id} c={c} active={c.id === conv?.id} onClick={() => setSelected(c.id)} />)
        ) : (
          <p className="muted small conv-empty">No companions in your contacts yet.</p>
        )}
        {msgs.syncError && <p className="conv-error">sync failed: {msgs.syncError}</p>}
      </aside>
      {conv ? (
        <Thread key={conv.id} conv={conv} msgs={msgs} connected={connected} nodeName={nodeName} />
      ) : (
        <Empty>No conversations yet.</Empty>
      )}
    </div>
  )
}

function ConvItem({ c, active, onClick }: { c: Conversation; active: boolean; onClick: () => void }) {
  const preview = c.last ? `${c.last.dir === 'out' ? 'you: ' : c.last.sender ? `${c.last.sender}: ` : ''}${c.last.text}` : ''
  return (
    <button className={`conv ${active ? 'conv-active' : ''}`} onClick={onClick}>
      <span className="conv-title">
        {c.kind === 'channel' ? '# ' : ''}
        {c.title}
      </span>
      {c.unread > 0 && <span className="badge">{c.unread}</span>}
      <span className="conv-preview">{preview || <span className="muted">no messages</span>}</span>
    </button>
  )
}

function Thread({ conv, msgs, connected, nodeName }: { conv: Conversation; msgs: Messages; connected: boolean; nodeName?: string }) {
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const items = useMemo(() => msgs.messages.filter((m) => m.conv === conv.id), [msgs.messages, conv.id])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [items.length])

  // channel posts go out as "<name>: <text>" and the firmware cuts the whole thing at MAX_TEXT_LEN
  const limit = conv.kind === 'channel' ? MAX_TEXT_LEN - utf8Len(`${nodeName ?? ''}: `) : MAX_TEXT_LEN
  const used = utf8Len(draft)
  const canSend = connected && draft.trim().length > 0 && used <= limit && (conv.contact || conv.channel)

  const send = () => {
    if (!canSend) return
    const text = draft.trim()
    setDraft('')
    if (conv.channel) void msgs.sendChannel(conv.channel, text)
    else if (conv.contact) void msgs.sendDirect(conv.contact, text)
  }

  const subtitle = conv.channel
    ? `channel ${conv.channel.index} · no delivery confirmation`
    : conv.contact
      ? `direct · ${conv.contact.outPath.known ? `${conv.contact.outPath.hops} hop${conv.contact.outPath.hops === 1 ? '' : 's'}` : 'path unknown, sends by flood'}`
      : 'not in your contacts'

  return (
    <section className="thread">
      <header className="thread-head">
        <div>
          <div className="thread-title">{conv.kind === 'channel' ? `# ${conv.title}` : conv.title}</div>
          <div className="muted small">{subtitle}</div>
        </div>
        <span className="spacer" />
        {items.length > 0 && (
          <Button kind="small" onClick={() => confirm(`Delete this conversation's ${items.length} messages from this browser?`) && msgs.clearConversation(conv.id)}>
            clear
          </Button>
        )}
      </header>
      <div className="thread-list" ref={listRef}>
        {items.length ? items.map((m) => <Bubble key={m.id} m={m} conv={conv} msgs={msgs} />) : <Empty>No messages here yet.</Empty>}
      </div>
      <footer className="composer">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={!connected ? 'connect a radio to send' : conv.channel || conv.contact ? `message ${conv.title}` : 'unknown sender, can’t reply'}
          disabled={!connected || !(conv.channel || conv.contact)}
        />
        <span className={`count ${used > limit ? 'count-over' : ''}`}>{used}/{limit}</span>
        <Button kind="primary" onClick={send} disabled={!canSend}>Send</Button>
      </footer>
    </section>
  )
}

function Bubble({ m, conv, msgs }: { m: ChatMessage; conv: Conversation; msgs: Messages }) {
  const out = m.dir === 'out'
  const from = out ? undefined : m.sender ?? (m.authorPrefix ? `author ${m.authorPrefix}` : conv.title)
  const meta = out
    ? [clock(m.ts), statusText(m)]
    : [clock(m.ts), m.snr !== undefined ? `SNR ${m.snr} dB` : '', routeText(m)]
  return (
    <div className={`bubble ${out ? 'bubble-out' : 'bubble-in'} ${m.status === 'failed' ? 'bubble-failed' : ''}`}>
      {from && <div className="bubble-from">{from}</div>}
      <div className="bubble-text">{m.text}</div>
      <div className="bubble-meta">
        {meta.filter(Boolean).join(' · ')}
        {out && m.status === 'failed' && conv.contact && (
          <button className="link" onClick={() => void msgs.sendDirect(conv.contact!, m.text, m)}>retry</button>
        )}
      </div>
    </div>
  )
}

function statusText(m: ChatMessage): string {
  switch (m.status) {
    case 'sending':
      return 'sending…'
    case 'sent':
      return m.ack ? `sent${m.flood ? ' by flood' : ' direct'}, waiting for ACK` : `sent${m.flood ? ' by flood' : ''}`
    case 'delivered':
      return `delivered${m.tripMs ? ` in ${(m.tripMs / 1000).toFixed(1)} s` : ''}${m.attempt ? ` (attempt ${m.attempt + 1})` : ''}`
    case 'failed':
      return m.error ?? 'failed'
    default:
      return ''
  }
}
