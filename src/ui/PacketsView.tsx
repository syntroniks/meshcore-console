import { Fragment, useMemo, useState } from 'react'
import { toHex } from '../protocol/bytes.ts'
import { PAYLOAD_TYPE_NAMES, ROUTE_TYPE_NAMES } from '../protocol/codes.ts'
import type { ChannelKey } from '../protocol/crypto.ts'
import { splitChannelText } from '../protocol/messages.ts'
import type { Field, PacketAnalysis, PacketDetail } from '../protocol/packets.ts'
import type { ChannelEditor } from './ChannelsView.tsx'
import { ago, time } from './format.ts'
import { Button, Card, Empty } from './parts.tsx'
import type { ChannelKeys } from './useChannelKeys.ts'
import type { AnalyzedPacket } from './usePackets.ts'

type GroupDetail = Extract<PacketDetail, { kind: 'group' }>

const hex2 = (n: number) => n.toString(16).padStart(2, '0')
const typeName = (t: number | undefined) => (t === undefined ? '?' : (PAYLOAD_TYPE_NAMES[t] ?? `type ${t}`))

/** Whether the radio itself delivers posts on this key to the app (and so to Messages). */
function keyStatus(key: ChannelKey | undefined): { text: string; ok: boolean } {
  if (!key) return { text: 'no key: if it’s a hashtag channel, try its name', ok: false }
  if (key.source === 'radio' && key.unnamed) return { text: `slot ${key.slot} has the key but no name, so the radio skips it`, ok: false }
  if (key.source === 'radio') return { text: `radio slot ${key.slot}, shows in Messages`, ok: true }
  if (key.source === 'public') return { text: 'the Public key, not on the radio: console only', ok: false }
  return { text: 'hashtag, not on the radio: console only', ok: false }
}

export function PacketsView({ packets, channelKeys, editor, onClear }: {
  packets: AnalyzedPacket[]
  channelKeys: ChannelKeys
  editor: ChannelEditor
  onClear: () => void
}) {
  const [frozen, setFrozen] = useState<AnalyzedPacket[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [type, setType] = useState('all')
  const [channel, setChannel] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [collapse, setCollapse] = useState(false)

  const list = frozen ?? packets
  // packets that arrived while paused; the one paused at may have dropped out of the log since
  const pausedAt = frozen?.length ? packets.findIndex((p) => p.e === frozen[0].e) : -1
  const newer = frozen ? (pausedAt < 0 ? packets.length : pausedAt) : 0

  const types = useMemo(() => [...new Set(list.map((p) => p.a.payloadType).filter((t) => t !== undefined))].sort((a, b) => a - b), [list])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const seen = new Set<string>()
    return list.filter(({ e, a }) => {
      if (type === 'problems' ? !a.problem : type !== 'all' && String(a.payloadType) !== type) return false
      if (channel !== null && !(a.detail.kind === 'group' && a.detail.channelHash === channel)) return false
      if (q && !(a.summary.toLowerCase().includes(q) || a.hash?.includes(q) || toHex(e.raw).includes(q))) return false
      if (collapse && a.hash) {
        if (seen.has(a.hash)) return false
        seen.add(a.hash)
      }
      return true
    })
  }, [list, type, channel, search, collapse])

  const clear = () => {
    setFrozen(null)
    setSelected(null)
    onClear()
  }

  return (
    <div className="stack">
      <ChannelsHeard packets={list} channelKeys={channelKeys} editor={editor} active={channel} onPick={(h) => setChannel(channel === h ? null : h)} />
      <Card title={`Received packets (${packets.length})`}>
        <div className="pkt-toolbar">
          <select className="filter" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">all types</option>
            {types.map((t) => (
              <option key={t} value={String(t)}>{typeName(t)}</option>
            ))}
            <option value="problems">problems only</option>
          </select>
          <input className="filter" placeholder="search text, hash or hex" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} /> hide repeats
          </label>
          {channel !== null && (
            <span className="chip">
              channel {hex2(channel)}
              <button onClick={() => setChannel(null)} title="Show every channel">×</button>
            </span>
          )}
          <span className="spacer" />
          {shown.length !== list.length && <span className="muted small">{shown.length} shown</span>}
          <Button kind="small" onClick={() => setFrozen(frozen ? null : packets)}>
            {frozen ? `resume${newer > 0 ? ` · ${newer} new` : ''}` : 'pause'}
          </Button>
          <Button kind="small" onClick={clear}>clear</Button>
        </div>
        {shown.length ? (
          <table className="table pkt-table">
            <thead>
              <tr><th>Time</th><th>Type</th><th>Route</th><th>Path</th><th>Contents</th><th>Size</th><th>RSSI</th><th>SNR</th><th>Heard</th></tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const { e, a } = p
                const open = selected === e.id
                return (
                  <Fragment key={e.id}>
                    <tr className={`pkt-row${open ? ' pkt-open' : ''}`} onClick={() => setSelected(open ? null : e.id)}>
                      <td className="muted">{time(e.at)}</td>
                      <td>{typeName(a.payloadType)}</td>
                      <td className="muted">{a.routeType === undefined ? '' : ROUTE_TYPE_NAMES[a.routeType]}</td>
                      <td><code className="raw">{a.path.join(' ') || '·'}</code></td>
                      <td className="pkt-contents"><Contents a={a} /></td>
                      <td>{e.raw.length} B</td>
                      <td>{e.rssi}</td>
                      <td>{e.snr}</td>
                      <td className="muted">{p.heard > 1 ? `×${p.heard}` : ''}</td>
                    </tr>
                    {open && (
                      <tr className="pkt-detail-row">
                        <td colSpan={9}><PacketInspector p={p} /></td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        ) : (
          <Empty>
            {list.length
              ? 'No packets match.'
              : 'The radio reports every packet it hears while the console is connected, before it decrypts anything. Nothing yet.'}
          </Empty>
        )}
      </Card>
    </div>
  )
}

function Contents({ a }: { a: PacketAnalysis }) {
  const d = a.detail
  if (d.kind === 'group' && d.channel && d.text) {
    const { sender, body } = splitChannelText(d.text.text)
    const { ok } = keyStatus(d.channel)
    return (
      <>
        <span className={`chan${ok ? '' : ' chan-console'}`} title={keyStatus(d.channel).text}>{d.channel.name}</span>{' '}
        {sender && <b>{sender}: </b>}
        {body}
      </>
    )
  }
  return <span className={a.problem ? 'pkt-problem-text' : d.kind === 'group' ? 'muted' : undefined}>{a.summary}</span>
}

interface HeardChannel {
  id: string
  hash: number
  key?: ChannelKey
  posts: Set<string>
  last: number
}

function ChannelsHeard({ packets, channelKeys, editor, active, onPick }: {
  packets: AnalyzedPacket[]
  channelKeys: ChannelKeys
  editor: ChannelEditor
  active: number | null
  onPick: (hash: number) => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()

  const heard = useMemo(() => {
    const byId = new Map<string, HeardChannel>()
    for (const { e, a } of packets) {
      if (a.detail.kind !== 'group' || a.problem) continue
      const d: GroupDetail = a.detail
      const id = `${d.channelHash}:${d.channel ? toHex(d.channel.secret) : ''}`
      let h = byId.get(id)
      if (!h) byId.set(id, (h = { id, hash: d.channelHash, key: d.channel, posts: new Set(), last: 0 }))
      h.posts.add(a.hash ?? String(e.id))
      h.last = Math.max(h.last, e.at)
    }
    return [...byId.values()].sort((x, y) => y.last - x.last)
  }, [packets])

  const add = () => {
    const problem = channelKeys.addHashtag(name)
    setError(problem)
    if (!problem) setName('')
  }

  return (
    <Card title="Channels heard">
      {heard.length ? (
        <table className="table">
          <thead>
            <tr><th>Channel</th><th>Hash</th><th>Posts</th><th>Last heard</th><th>Key</th></tr>
          </thead>
          <tbody>
            {heard.map((h) => {
              const status = keyStatus(h.key)
              return (
                <tr key={h.id} className={`pkt-row${active === h.hash ? ' pkt-open' : ''}`} onClick={() => onPick(h.hash)} title="Show only this channel">
                  <td>{h.key ? h.key.name : <span className="muted">unknown</span>}</td>
                  <td><code>{hex2(h.hash)}</code></td>
                  <td>{h.posts.size}</td>
                  <td className="muted">{ago(h.last / 1000)}</td>
                  <td>
                    <span className={status.ok ? undefined : 'warn-text'}>{status.text}</span>
                    {h.key && h.key.source !== 'radio' && <AddToRadio channel={h.key} editor={editor} />}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <Empty>No channel posts heard yet.</Empty>
      )}
      <div className="hashtags">
        <span className="muted small">Hashtag channels use a key made from their name. Try one:</span>
        <input
          className="filter"
          placeholder="#hiking"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button kind="small" onClick={add} disabled={!name.trim()}>try</Button>
        {error && <span className="editor-error">{error}</span>}
        {channelKeys.hashtags.map((h) => (
          <span key={h} className="chip">
            {h}
            <button onClick={() => channelKeys.removeHashtag(h)} title="Stop trying this name">×</button>
          </span>
        ))}
      </div>
    </Card>
  )
}

/** One click from a console-only key to a radio slot, after which the radio delivers the channel to Messages. */
function AddToRadio({ channel, editor }: { channel: ChannelKey; editor: ChannelEditor }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!editor.connected) return null
  const add = async (e: React.MouseEvent) => {
    e.stopPropagation() // the row itself filters by channel
    setBusy(true)
    setError(undefined)
    try {
      await editor.add(channel.name, channel.secret)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="add-to-radio">
      <button className="btn btn-small" onClick={(e) => void add(e)} disabled={busy || editor.nextSlot === undefined} title={editor.nextSlot === undefined ? 'every slot is in use' : `add to slot ${editor.nextSlot}`}>
        {busy ? 'adding…' : 'add to radio'}
      </button>
      {error && <span className="editor-error">{error}</span>}
    </span>
  )
}

function PacketInspector({ p }: { p: AnalyzedPacket }) {
  const { e, a, heard } = p
  const [hover, setHover] = useState<number | null>(null)
  const d = a.detail
  return (
    <div className="pkt-inspector">
      <div className="pkt-meta">
        <span>{e.raw.length} bytes</span>
        {a.hash && <span>packet hash <code>{a.hash}</code></span>}
        <span>{heard > 1 ? `heard ${heard} times` : 'heard once'}</span>
        <span>{e.rssi} dBm · SNR {e.snr} dB</span>
        <span className="muted">{new Date(e.at).toLocaleString()}</span>
        <span className="spacer" />
        <Button kind="small" onClick={() => void navigator.clipboard?.writeText(toHex(e.raw))}>copy hex</Button>
      </div>
      {a.problem && <div className="pkt-problem">{a.problem}</div>}
      <Layout bytes={e.raw} fields={a.fields} hover={hover} onHover={setHover} />
      {d.kind === 'group' && !a.problem && <GroupInspector d={d} />}
    </div>
  )
}

function GroupInspector({ d }: { d: GroupDetail }) {
  const [hover, setHover] = useState<number | null>(null)
  if (!d.channel || !d.plain) {
    const tried = d.tried.map((k) => k.name).join(', ')
    return (
      <p className="muted small">
        {tried
          ? `The MAC doesn't match ${tried}: it's another channel whose key hashes to ${hex2(d.channelHash)} too.`
          : `No key hashes to ${hex2(d.channelHash)}. For a hashtag channel, try its name under Channels heard; a private channel needs its key.`}
      </p>
    )
  }
  return (
    <>
      <h3 className="pkt-sub">
        Decrypted with {d.channel.name} <span className="muted small">· {keyStatus(d.channel).text}</span>
      </h3>
      <Layout bytes={d.plain} fields={d.plainFields} hover={hover} onHover={setHover} />
    </>
  )
}

/** The bytes coloured by field, above a table of the fields. Hovering either highlights the other. */
function Layout({ bytes, fields, hover, onHover }: { bytes: Uint8Array; fields: Field[]; hover: number | null; onHover: (i: number | null) => void }) {
  const end = fields.reduce((n, f) => Math.max(n, f.start + f.length), 0)
  return (
    <div className="pkt-layout" onMouseLeave={() => onHover(null)}>
      <div className="hex">
        {fields.map((f, i) => (
          <span key={i} className={`hx hx-${f.kind}${hover === i ? ' hx-hover' : ''}`} title={`${f.label}: ${f.value}`} onMouseEnter={() => onHover(i)}>
            {toHex(bytes.subarray(f.start, f.start + f.length), ' ')}
          </span>
        ))}
        {end < bytes.length && <span className="hx">{toHex(bytes.subarray(end), ' ')}</span>}
      </div>
      <table className="table pkt-fields">
        <thead>
          <tr><th>Offset</th><th>Size</th><th>Field</th><th>Value</th></tr>
        </thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={i} className={hover === i ? 'pkt-field-hover' : undefined} onMouseEnter={() => onHover(i)}>
              <td className="muted">{f.start}</td>
              <td className="muted">{f.length}</td>
              <td><span className={`swatch hx-${f.kind}`} />{f.label}</td>
              <td className="wrap">{f.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
