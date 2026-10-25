import { useMemo, useState } from 'react'
import { fromHex, toHex } from '../protocol/bytes.ts'
import { channelLink, MAX_CHANNEL_NAME_BYTES, nameBytes, parseChannelLink, parseSecret, randomSecret } from '../protocol/channels.ts'
import type { MeshCoreClient } from '../protocol/client.ts'
import { channelHash, hashtagSecret, normalizeHashtag, PUBLIC_CHANNEL_SECRET } from '../protocol/crypto.ts'
import type { ChannelInfo } from '../protocol/messages.ts'
import { Button, Card, Empty } from './parts.tsx'
import type { RadioState } from './useRadio.ts'

type WriteChannels = (fn: (c: MeshCoreClient) => Promise<unknown>) => Promise<void>

export interface ChannelEditor {
  connected: boolean
  /** where the next added channel goes; undefined when every slot is taken */
  nextSlot?: number
  slotOf: (secret: Uint8Array) => ChannelInfo | undefined
  add: (name: string, secret: Uint8Array) => Promise<number>
  rename: (ch: ChannelInfo, name: string) => Promise<void>
  remove: (ch: ChannelInfo) => Promise<void>
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function nameProblem(name: string): string | undefined {
  if (!name.trim()) return 'give it a name'
  if (nameBytes(name.trim()) > MAX_CHANNEL_NAME_BYTES) return `names are at most ${MAX_CHANNEL_NAME_BYTES} bytes`
  return undefined
}

/** What kind of key a slot holds, judged from the key itself. */
function kindOf(ch: ChannelInfo): string {
  if (ch.secret === PUBLIC_CHANNEL_SECRET) return 'public'
  if (ch.name.startsWith('#') && toHex(hashtagSecret(ch.name)) === ch.secret) return 'hashtag'
  return 'private'
}

/**
 * Slot bookkeeping for adding, renaming and removing channels. Messages files channel posts by slot, so a new channel
 * avoids free slots that still have stored messages from an earlier channel.
 */
export function useChannelEditor(state: RadioState, writeChannels: WriteChannels, busySlots: Set<number>): ChannelEditor {
  return useMemo(() => {
    const channels = state.channels ?? []
    const max = state.device?.maxChannels ?? 40
    const used = new Set(channels.map((c) => c.index))
    const free = Array.from({ length: max }, (_, i) => i).filter((i) => !used.has(i))
    const nextSlot = free.find((i) => !busySlots.has(i)) ?? free[0]
    const slotOf = (secret: Uint8Array) => channels.find((c) => c.secret === toHex(secret))
    return {
      connected: state.status === 'connected' && state.channels !== undefined,
      nextSlot,
      slotOf,
      add: async (name, secret) => {
        const problem = nameProblem(name)
        if (problem) throw new Error(problem)
        const existing = slotOf(secret)
        if (existing) throw new Error(`that key is already in slot ${existing.index}`)
        if (nextSlot === undefined) throw new Error(`all ${max} slots are in use`)
        await writeChannels((c) => c.setChannel(nextSlot, name.trim(), secret))
        return nextSlot
      },
      rename: async (ch, name) => {
        const problem = nameProblem(name)
        if (problem) throw new Error(problem)
        await writeChannels((c) => c.setChannel(ch.index, name.trim(), fromHex(ch.secret)))
      },
      remove: (ch) => writeChannels((c) => c.removeChannel(ch.index)),
    }
  }, [state.channels, state.device?.maxChannels, state.status, writeChannels, busySlots])
}

export function ChannelsView({ state, editor, onRefresh }: { state: RadioState; editor: ChannelEditor; onRefresh: () => void }) {
  const [reveal, setReveal] = useState(false)
  const max = state.device?.maxChannels ?? 40
  return (
    <div className="stack">
      <Card
        title={`Channels${state.channels ? ` · ${state.channels.length} of ${max} slots` : ''}`}
        actions={
          <>
            <Button kind="small" onClick={() => setReveal((r) => !r)}>{reveal ? 'hide keys' : 'show keys'}</Button>
            <Button kind="small" onClick={onRefresh}>refresh</Button>
          </>
        }
      >
        {state.channels?.length ? (
          <table className="table">
            <thead>
              <tr><th>Slot</th><th>Name</th><th>Kind</th><th>Hash</th><th>Key</th><th /></tr>
            </thead>
            <tbody>
              {state.channels.map((c) => (
                <ChannelRow key={`${c.index}:${c.secret}`} ch={c} reveal={reveal} editor={editor} />
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{state.channels ? 'No channels configured.' : 'Loading…'}</Empty>
        )}
      </Card>
      <AddChannel editor={editor} />
    </div>
  )
}

function ChannelRow({ ch, reveal, editor }: { ch: ChannelInfo; reveal: boolean; editor: ChannelEditor }) {
  const [mode, setMode] = useState<'view' | 'rename' | 'remove'>('view')
  const [name, setName] = useState(ch.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const secret = fromHex(ch.secret)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      setMode('view')
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  const share = async () => {
    await navigator.clipboard?.writeText(channelLink(ch.name || `slot ${ch.index}`, secret))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <tr>
      <td>{ch.index}</td>
      <td>
        {mode === 'rename' ? (
          <span className="editor-line">
            <input
              className="field"
              autoFocus
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run(() => editor.rename(ch, name))
                if (e.key === 'Escape') setMode('view')
              }}
            />
            <Button kind="small" onClick={() => void run(() => editor.rename(ch, name))} disabled={busy}>save</Button>
            <Button kind="small" onClick={() => setMode('view')} disabled={busy}>cancel</Button>
          </span>
        ) : (
          ch.name || <span className="warn-text">no name, so the radio ignores this slot</span>
        )}
        {error && <div className="editor-error">{error}</div>}
      </td>
      <td className="muted">{kindOf(ch)}</td>
      <td><code>{hex2(channelHash(secret))}</code></td>
      <td><code>{reveal ? ch.secret : '•'.repeat(16)}</code></td>
      <td>
        <span className="row-action">
          {mode === 'remove' ? (
            <>
              <span className="small warn-text">remove from slot {ch.index}?</span>
              <Button kind="small" onClick={() => void run(() => editor.remove(ch))} disabled={busy || !editor.connected}>remove</Button>
              <Button kind="small" onClick={() => setMode('view')} disabled={busy}>keep</Button>
            </>
          ) : (
            mode === 'view' && (
              <>
                <Button kind="small" onClick={() => void share()} title="Copy a meshcore:// link that adds this channel">{copied ? 'copied' : 'share'}</Button>
                <Button kind="small" onClick={() => { setName(ch.name); setMode('rename') }} disabled={!editor.connected}>{ch.name ? 'rename' : 'name it'}</Button>
                <Button kind="small" onClick={() => setMode('remove')} disabled={!editor.connected}>remove</Button>
              </>
            )
          )}
        </span>
      </td>
    </tr>
  )
}

type Kind = 'hashtag' | 'private' | 'import' | 'public'

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'hashtag', label: 'Hashtag', hint: 'Anyone who knows the name can read it: the key is made from the name.' },
  { id: 'private', label: 'New private', hint: 'A new random key. Only people you share the link with can read it.' },
  { id: 'import', label: 'From a link or key', hint: 'Paste a meshcore:// link (from the MeshCore app or a QR code), or a key as 32 hex characters or base64.' },
  { id: 'public', label: 'Public', hint: 'The channel every radio ships with, on the well-known key.' },
]

function AddChannel({ editor }: { editor: ChannelEditor }) {
  const [kind, setKind] = useState<Kind>('hashtag')
  const [tag, setTag] = useState('')
  const [name, setName] = useState('')
  const [secret, setSecret] = useState(randomSecret)
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [added, setAdded] = useState<{ name: string; slot: number; link?: string }>()

  const draft = useMemo((): { name: string; secret: Uint8Array } | { problem: string } => {
    if (kind === 'hashtag') {
      const n = normalizeHashtag(tag)
      return n ? { name: n, secret: hashtagSecret(n) } : { problem: tag.trim() ? 'a hashtag is one word, like #hiking' : '' }
    }
    if (kind === 'private') return { name, secret }
    if (kind === 'public') return { name: 'Public', secret: fromHex(PUBLIC_CHANNEL_SECRET) }
    const key = parseChannelLink(pasted)?.secret ?? parseSecret(pasted)
    if (!key) return { problem: pasted.trim() ? 'not a meshcore:// channel link or a 16-byte key' : '' }
    return { name, secret: key }
  }, [kind, tag, name, secret, pasted])

  const existing = 'secret' in draft ? editor.slotOf(draft.secret) : undefined
  const problem = 'problem' in draft ? draft.problem : existing ? `already on the radio in slot ${existing.index}` : nameProblem(draft.name)

  const paste = (text: string) => {
    setPasted(text)
    const link = parseChannelLink(text)
    if (link) setName(link.name)
  }

  const add = async () => {
    if (!('secret' in draft) || problem) return
    setBusy(true)
    setError(undefined)
    try {
      const slot = await editor.add(draft.name, draft.secret)
      const shareable = kind === 'private' || kind === 'import'
      setAdded({ name: draft.name.trim(), slot, link: shareable ? channelLink(draft.name.trim(), draft.secret) : undefined })
      setTag('')
      setName('')
      setPasted('')
      if (kind === 'private') setSecret(randomSecret())
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  const needsName = kind === 'private' || kind === 'import'
  return (
    <Card title="Add a channel">
      <div className="add-channel">
        <div className="seg">
          {KINDS.map((k) => (
            <button key={k.id} className={kind === k.id ? 'seg-active' : undefined} onClick={() => { setKind(k.id); setError(undefined) }}>
              {k.label}
            </button>
          ))}
        </div>
        <div className="muted small">{KINDS.find((k) => k.id === kind)?.hint}</div>
        {kind === 'hashtag' && (
          <input className="field" placeholder="#hiking" value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        )}
        {kind === 'import' && (
          <input className="field field-wide" placeholder="meshcore://channel/add?name=…&secret=…" value={pasted} onChange={(e) => paste(e.target.value)} />
        )}
        {needsName && (
          <input className="field" placeholder="channel name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        )}
        {kind === 'private' && (
          <div className="editor-line">
            <code className="raw">{toHex(secret)}</code>
            <Button kind="small" onClick={() => setSecret(randomSecret())}>new key</Button>
          </div>
        )}
        <div className="editor-line">
          <Button kind="primary" onClick={() => void add()} disabled={!editor.connected || busy || !!problem || editor.nextSlot === undefined}>
            {busy ? 'adding…' : 'Add to radio'}
          </Button>
          <span className="muted small">
            {!editor.connected
              ? 'connect a radio first'
              : editor.nextSlot === undefined
                ? 'every slot is in use: remove a channel first'
                : `goes in slot ${editor.nextSlot}${'secret' in draft ? ` · hash ${hex2(channelHash(draft.secret))}` : ''}`}
          </span>
          {(error || (problem && problem !== 'give it a name')) && <span className="editor-error">{error || problem}</span>}
        </div>
        {added && (
          <div className="added">
            Added <b>{added.name}</b> to slot {added.slot}. Its posts now show in Messages.
            {added.link && (
              <div className="editor-line">
                <span className="muted small">Share it:</span>
                <code className="raw wrap">{added.link}</code>
                <Button kind="small" onClick={() => void navigator.clipboard?.writeText(added.link!)}>copy</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
