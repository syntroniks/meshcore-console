import { useMemo, useState } from 'react'
import type { MeshCoreClient } from '../protocol/client.ts'
import { ADV_TYPE_NAMES, AutoAdd, PAYLOAD_TYPE_NAMES } from '../protocol/codes.ts'
import type { OtherParams, RadioParams } from '../protocol/messages.ts'
import { Button, Card, Empty, Rows, type EditSpec, type Row } from './parts.tsx'
import type { AnalyzedPacket } from './usePackets.ts'
import { CLI_SETTINGS, type RadioState } from './useRadio.ts'
import { ago, batteryPercent, cliValue, coords, duration, shortKey, time } from './format.ts'

const TELEMETRY = ['deny', 'per contact', 'allow all']

/** firmware: 0 = no limit, 1 = direct only, N = up to N-1 hops */
const maxHopsText = (n: number) => (n === 0 ? 'no limit' : n === 1 ? 'direct only' : `${n - 1}`)

export function Overview({ state, packets, onSyncClock }: { state: RadioState; packets: AnalyzedPacket[]; onSyncClock: () => Promise<void> }) {
  const { self, batt, clock, core, radioStats: r, packets: p } = state
  const drift = clock ? Math.round(clock.radio - clock.local) : 0
  const [syncError, setSyncError] = useState<string>()
  const [syncing, setSyncing] = useState(false)
  const syncClock = async () => {
    setSyncing(true)
    setSyncError(undefined)
    try {
      await onSyncClock()
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }
  return (
    <div className="grid">
      <Card title="Node">
        <Rows
          rows={[
            { label: 'Name', value: self?.name ?? '…' },
            { label: 'Type', value: self ? ADV_TYPE_NAMES[self.advType] : '…' },
            { label: 'Public key', value: self ? <code title={self.publicKey}>{shortKey(self.publicKey)}</code> : '…' },
            { label: 'Location', value: self ? coords(self.lat, self.lon) : '…', muted: !self?.lat && !self?.lon },
          ]}
        />
      </Card>
      <Card title="Power">
        {batt ? (
          <>
            <div className="meter" title={`${batt.batteryMv} mV`}>
              <div className="meter-fill" style={{ width: `${batteryPercent(batt.batteryMv)}%` }} />
            </div>
            <Rows
              rows={[
                { label: 'Battery', value: `${batt.batteryMv} mV (~${batteryPercent(batt.batteryMv)}%)` },
                { label: 'Storage', value: `${batt.storageUsedKb} of ${batt.storageTotalKb} KB used` },
              ]}
            />
          </>
        ) : (
          <Empty>…</Empty>
        )}
      </Card>
      <Card
        title="Clock"
        actions={
          <Button
            kind="small"
            onClick={() => void syncClock()}
            disabled={!clock || syncing || drift > 2}
            title={drift > 2 ? 'The firmware only moves its clock forward, so a clock that runs ahead can’t be pulled back' : 'Set the radio’s clock from this computer'}
          >
            {syncing ? 'syncing…' : 'sync clock'}
          </Button>
        }
      >
        <Rows
          rows={[
            { label: 'Radio time', value: clock ? new Date(clock.radio * 1000).toLocaleString() : '…' },
            {
              label: 'Drift',
              value: clock ? driftText(drift) : '…',
              muted: Math.abs(drift) < 3,
            },
            { label: 'Uptime', value: core ? duration(core.uptimeSecs) : '…' },
          ]}
        />
        {drift > 2 && <p className="muted small">The radio runs ahead of this computer. Firmware only moves its clock forward, so it can’t be synced back.</p>}
        {syncError && <p className="editor-error">{syncError}</p>}
      </Card>
      <Card title="Radio">
        <Rows
          rows={[
            { label: 'Preset', value: self ? `${self.radio.freqMHz} MHz · ${self.radio.bwKHz} kHz · SF${self.radio.sf} · CR${self.radio.cr}` : '…' },
            { label: 'TX power', value: self ? `${self.txPowerDbm} dBm (max ${self.maxTxPowerDbm})` : '…' },
            { label: 'Noise floor', value: r ? `${r.noiseFloorDbm} dBm` : '…' },
            { label: 'Last packet', value: r ? `${r.lastRssiDbm} dBm, SNR ${r.lastSnrDb} dB` : '…' },
          ]}
        />
      </Card>
      <Card title="Traffic">
        <Rows
          rows={[
            { label: 'Received', value: p ? `${p.received} (${p.receivedFlood} flood, ${p.receivedDirect} direct)` : '…' },
            { label: 'Receive errors', value: p ? p.receiveErrors : '…' },
            { label: 'Sent', value: p ? `${p.sent} (${p.sentFlood} flood, ${p.sentDirect} direct)` : '…' },
            { label: 'Airtime', value: r ? `TX ${duration(r.txAirSecs)} · RX ${duration(r.rxAirSecs)}` : '…' },
            { label: 'TX queue', value: core ? core.queueLen : '…' },
          ]}
        />
      </Card>
      <Card title="Recent packets">
        {packets.length ? (
          <ul className="mini-log">
            {packets.slice(0, 6).map(({ e, a }) => (
              <li key={e.id}>
                <span className="muted">{time(e.at)}</span> {a.payloadType === undefined ? 'unparsed' : (PAYLOAD_TYPE_NAMES[a.payloadType] ?? `type ${a.payloadType}`)}{' '}
                <span className="muted">
                  {a.summary} · {e.rssi} dBm · SNR {e.snr}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing heard since connecting.</Empty>
        )}
      </Card>
    </div>
  )
}

export function driftText(drift: number): string {
  if (Math.abs(drift) < 3) return 'in sync'
  return `${duration(Math.abs(drift))} ${drift > 0 ? 'ahead' : 'behind'}`
}

type Write = (fn: (c: MeshCoreClient) => Promise<unknown>) => Promise<void>

const BANDWIDTHS = ['7.8', '10.4', '15.6', '20.8', '31.25', '41.7', '62.5', '125', '250', '500']
const onOff = [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }]
const TELEMETRY_OPTIONS = TELEMETRY.map((label, i) => ({ value: String(i), label }))
const AUTO_ADD_TYPES = [
  { value: String(AutoAdd.Chat), label: 'companions' },
  { value: String(AutoAdd.Repeater), label: 'repeaters' },
  { value: String(AutoAdd.RoomServer), label: 'room servers' },
  { value: String(AutoAdd.Sensor), label: 'sensors' },
]

/** How each CLI-only setting is edited; the radio validates again when it gets the 'set'. */
const CLI_EDIT: Record<string, Pick<EditSpec, 'type' | 'options' | 'min' | 'max' | 'step' | 'hint'>> = {
  dutycycle: { type: 'number', min: 1, max: 100, step: 1, hint: 'percent of airtime the radio may transmit' },
  txdelay: { type: 'number', min: 0, max: 2, step: 0.1 },
  'direct.txdelay': { type: 'number', min: 0, max: 2, step: 0.1 },
  'agc.reset.interval': { type: 'number', min: 0, step: 4, hint: 'seconds, rounded to a multiple of 4; 0 turns it off' },
  'int.thresh': { type: 'number', min: 0, step: 1, hint: 'dB above the noise floor; 0 turns it off' },
  cad: { type: 'select', options: onOff },
  'radio.rxgain': { type: 'select', options: onOff, hint: 'SX126x boosted receive gain: ~3 dB more sensitive, under 0.5 mA more' },
  'radio.fem.rxgain': { type: 'select', options: onOff },
  'tz.offset': { type: 'number', min: -12, max: 14, step: 1, hint: 'hours from UTC, for the on-screen clock' },
}

const num = (min: number, max: number, what: string) => (v: string) => {
  const n = Number(v)
  return v.trim() === '' || !Number.isFinite(n) || n < min || n > max ? `${what} must be ${min} to ${max}` : undefined
}

export function Settings({ state, write, onRefresh }: { state: RadioState; write: Write; onRefresh: () => void }) {
  const { device: d, self: s, tuning, autoadd, floodScope, customVars } = state

  // frames that carry several settings get the current values for the ones not being edited
  const other = (patch: Partial<OtherParams>): OtherParams => ({
    manualAddContacts: s!.manualAddContacts,
    telemetry: s!.telemetry,
    advertLocationPolicy: s!.advertLocationPolicy,
    multiAcks: s!.multiAcks,
    ...patch,
  })
  const radio = (patch: Partial<RadioParams>) => (c: MeshCoreClient) => c.setRadioParams({ ...s!.radio, ...patch }, d?.clientRepeat ?? false)
  const radioHint = 'applies immediately; every radio you talk to must use the same value'

  const autoTypes = autoadd
    ? AUTO_ADD_TYPES.filter((t) => autoadd.flags & Number(t.value)).map((t) => t.label).join(', ') || 'none'
    : '…'

  const cliRows: Row[] = CLI_SETTINGS.map(({ key, label }) => {
    const v = cliValue(state.cli[key])
    const meta = CLI_EDIT[key]
    return {
      label,
      value: v.text,
      muted: !v.ok,
      edit: v.ok && meta
        ? { ...meta, value: v.text.replace(/%$/, ''), save: (val: string) => write((c) => c.runCliExpectOk(`set ${key} ${val}`)) }
        : undefined,
    }
  })

  return (
    <div className="grid">
      <Card title="Identity" actions={<Button kind="small" onClick={onRefresh}>refresh</Button>}>
        <Rows
          rows={[
            {
              label: 'Name',
              value: s?.name ?? '…',
              edit: s && {
                type: 'text',
                value: s.name,
                hint: 'shown in your adverts and channel posts',
                validate: (v) => (!v.trim() ? 'name can’t be empty' : new TextEncoder().encode(v).length > 31 ? 'at most 31 bytes' : undefined),
                save: (v) => write((c) => c.setAdvertName(v.trim())),
              },
            },
            { label: 'Type', value: s ? ADV_TYPE_NAMES[s.advType] : '…' },
            {
              label: 'Public key',
              value: s ? <code className="wrap">{s.publicKey}</code> : '…',
              action: s && <Button kind="small" onClick={() => void navigator.clipboard.writeText(s.publicKey)}>copy</Button>,
            },
            {
              label: 'Location',
              value: s ? coords(s.lat, s.lon) : '…',
              muted: !s?.lat && !s?.lon,
              edit: s && {
                type: 'text',
                value: s.lat || s.lon ? `${s.lat}, ${s.lon}` : '',
                hint: 'latitude, longitude in degrees; 0, 0 clears it',
                validate: (v) => {
                  const [lat, lon] = v.split(',').map((x) => Number(x.trim()))
                  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'enter "latitude, longitude"'
                  return Math.abs(lat) > 90 || Math.abs(lon) > 180 ? 'out of range' : undefined
                },
                save: (v) => {
                  const [lat, lon] = v.split(',').map((x) => Number(x.trim()))
                  return write((c) => c.setAdvertLatLon(lat, lon))
                },
              },
            },
            {
              label: 'Location in adverts',
              value: s ? (s.advertLocationPolicy ? 'shared' : 'not shared') : '…',
              edit: s && {
                type: 'select',
                value: String(s.advertLocationPolicy),
                options: [{ value: '0', label: 'not shared' }, { value: '1', label: 'shared' }],
                save: (v) => write((c) => c.setOtherParams(other({ advertLocationPolicy: Number(v) }))),
              },
            },
          ]}
        />
      </Card>
      <Card title="Radio">
        <Rows
          rows={[
            {
              label: 'Frequency',
              value: s ? `${s.radio.freqMHz} MHz` : '…',
              edit: s && { type: 'number', value: String(s.radio.freqMHz), step: 0.001, hint: radioHint, validate: num(150, 2500, 'frequency'), save: (v) => write(radio({ freqMHz: Number(v) })) },
            },
            {
              label: 'Bandwidth',
              value: s ? `${s.radio.bwKHz} kHz` : '…',
              edit: s && {
                type: 'select',
                value: BANDWIDTHS.find((b) => Number(b) === s.radio.bwKHz) ?? String(s.radio.bwKHz),
                options: BANDWIDTHS.map((b) => ({ value: b, label: `${b} kHz` })),
                hint: radioHint,
                save: (v) => write(radio({ bwKHz: Number(v) })),
              },
            },
            {
              label: 'Spreading factor',
              value: s ? `SF${s.radio.sf}` : '…',
              edit: s && {
                type: 'select',
                value: String(s.radio.sf),
                options: [5, 6, 7, 8, 9, 10, 11, 12].map((n) => ({ value: String(n), label: `SF${n}` })),
                hint: radioHint,
                save: (v) => write(radio({ sf: Number(v) })),
              },
            },
            {
              label: 'Coding rate',
              value: s ? `4/${s.radio.cr}` : '…',
              edit: s && {
                type: 'select',
                value: String(s.radio.cr),
                options: [5, 6, 7, 8].map((n) => ({ value: String(n), label: `4/${n}` })),
                hint: radioHint,
                save: (v) => write(radio({ cr: Number(v) })),
              },
            },
            {
              label: 'TX power',
              value: s ? `${s.txPowerDbm} dBm (max ${s.maxTxPowerDbm})` : '…',
              edit: s && {
                type: 'number',
                value: String(s.txPowerDbm),
                min: -9,
                max: s.maxTxPowerDbm,
                step: 1,
                hint: 'dBm',
                validate: num(-9, s.maxTxPowerDbm, 'TX power'),
                save: (v) => write((c) => c.setTxPower(Number(v))),
              },
            },
            {
              label: 'Airtime factor',
              value: tuning?.airtimeFactor ?? '…',
              edit: tuning && {
                type: 'number',
                value: String(tuning.airtimeFactor),
                min: 0,
                max: 9,
                step: 0.1,
                validate: num(0, 9, 'airtime factor'),
                save: (v) => write((c) => c.setTuningParams({ ...tuning, airtimeFactor: Number(v) })),
              },
            },
            {
              label: 'RX delay base',
              value: tuning?.rxDelayBase ?? '…',
              edit: tuning && {
                type: 'number',
                value: String(tuning.rxDelayBase),
                min: 0,
                max: 20,
                step: 0.1,
                validate: num(0, 20, 'RX delay base'),
                save: (v) => write((c) => c.setTuningParams({ ...tuning, rxDelayBase: Number(v) })),
              },
            },
          ]}
        />
      </Card>
      <Card title="Firmware settings">
        <Rows rows={cliRows} />
      </Card>
      <Card title="Contacts & telemetry">
        <Rows
          rows={[
            {
              label: 'Add contacts',
              value: s ? (s.manualAddContacts ? 'manually, except the types below' : 'automatically, all types') : '…',
              edit: s && {
                type: 'select',
                value: String(s.manualAddContacts & 1),
                options: [{ value: '0', label: 'automatically, all types' }, { value: '1', label: 'manually, except the types below' }],
                save: (v) => write((c) => c.setOtherParams(other({ manualAddContacts: Number(v) }))),
              },
            },
            {
              label: 'Auto-add types',
              value: autoTypes,
              muted: !s?.manualAddContacts,
              edit: autoadd && {
                type: 'flags',
                value: AUTO_ADD_TYPES.filter((t) => autoadd.flags & Number(t.value)).map((t) => t.value).join(','),
                options: AUTO_ADD_TYPES,
                hint: 'only used when contacts are added manually',
                save: (v) => {
                  const types = v.split(',').filter(Boolean).reduce((acc, x) => acc | Number(x), 0)
                  return write((c) => c.setAutoaddConfig({ ...autoadd, flags: (autoadd.flags & AutoAdd.OverwriteOldest) | types }))
                },
              },
            },
            {
              label: 'When full',
              value: autoadd ? (autoadd.flags & AutoAdd.OverwriteOldest ? 'overwrite oldest' : 'stop adding') : '…',
              edit: autoadd && {
                type: 'select',
                value: autoadd.flags & AutoAdd.OverwriteOldest ? '1' : '0',
                options: [{ value: '0', label: 'stop adding' }, { value: '1', label: 'overwrite oldest non-favourite' }],
                save: (v) => write((c) => c.setAutoaddConfig({ ...autoadd, flags: (autoadd.flags & ~AutoAdd.OverwriteOldest) | (v === '1' ? AutoAdd.OverwriteOldest : 0) })),
              },
            },
            {
              label: 'Auto-add max hops',
              value: autoadd ? maxHopsText(autoadd.maxHops) : '…',
              edit: autoadd && {
                type: 'number',
                value: String(autoadd.maxHops),
                min: 0,
                max: 64,
                step: 1,
                hint: '0 = no limit, 1 = direct neighbours only, N = up to N-1 hops',
                validate: num(0, 64, 'max hops'),
                save: (v) => write((c) => c.setAutoaddConfig({ ...autoadd, maxHops: Number(v) })),
              },
            },
            ...(['base', 'location', 'environment'] as const).map((k) => ({
              label: `Telemetry: ${k}`,
              value: s ? TELEMETRY[s.telemetry[k]] : '…',
              edit: s && {
                type: 'select' as const,
                value: String(s.telemetry[k]),
                options: TELEMETRY_OPTIONS,
                hint: 'who may request this telemetry from you',
                save: (v: string) => write((c) => c.setOtherParams(other({ telemetry: { ...s.telemetry, [k]: Number(v) } }))),
              },
            })),
          ]}
        />
      </Card>
      <Card title="Messaging & routing">
        <Rows
          rows={[
            {
              label: 'Extra ACKs',
              value: s ? (s.multiAcks ? `${s.multiAcks} extra` : 'off') : '…',
              edit: s && {
                type: 'select',
                value: String(s.multiAcks),
                options: [{ value: '0', label: 'off' }, { value: '1', label: '1 extra' }],
                hint: 'send an extra ACK for messages you receive',
                save: (v) => write((c) => c.setOtherParams(other({ multiAcks: Number(v) }))),
              },
            },
            {
              label: 'Path hash size',
              value: d?.pathHashMode === undefined ? '…' : `${d.pathHashMode + 1} byte${d.pathHashMode ? 's' : ''} per hop`,
              edit: d?.pathHashMode !== undefined ? {
                type: 'select',
                value: String(d.pathHashMode),
                options: [0, 1, 2].map((m) => ({ value: String(m), label: `${m + 1} byte${m ? 's' : ''} per hop` })),
                hint: 'larger hashes tell more repeaters apart, but make paths longer',
                save: (v) => write((c) => c.setPathHashMode(Number(v))),
              } : undefined,
            },
            { label: 'Default flood scope', value: floodScope === undefined ? '…' : floodScope ? floodScope.name : 'none (unscoped)', muted: !floodScope },
          ]}
        />
      </Card>
      <Card title="Device">
        <Rows
          rows={[
            { label: 'Firmware', value: d ? `${d.firmwareVersion} (${d.buildDate})` : '…' },
            { label: 'Board', value: d?.manufacturer ?? '…' },
            { label: 'Protocol', value: d ? `v${d.protocolVersion}` : '…' },
            { label: 'Capacity', value: d ? `${d.maxContacts} contacts, ${d.maxChannels} channels` : '…' },
            {
              label: 'BLE PIN',
              value: d ? (d.blePin ? String(d.blePin).padStart(6, '0') : 'random each boot') : '…',
              edit: d && {
                type: 'text',
                value: d.blePin ? String(d.blePin) : '0',
                hint: 'six digits, or 0 for a random PIN shown on screen each boot; used by BLE builds after a reboot',
                validate: (v) => (/^(0|[1-9]\d{5})$/.test(v.trim()) ? undefined : 'six digits (not starting with 0), or 0'),
                save: (v) => write((c) => c.setDevicePin(Number(v.trim()))),
              },
            },
            { label: 'Repeats packets', value: d?.clientRepeat === undefined ? '…' : d.clientRepeat ? 'yes' : 'no' },
            ...(customVars && Object.keys(customVars).length
              ? Object.entries(customVars).map(([k, v]) => ({
                  label: `Sensor: ${k}`,
                  value: v,
                  edit: {
                    type: 'text' as const,
                    value: v,
                    hint: k === 'gps' ? '1 = on, 0 = off' : undefined,
                    save: (val: string) => write((c) => c.setCustomVar(k, val.trim())),
                  },
                }))
              : [{ label: 'Sensor settings', value: customVars ? 'none on this board' : '…', muted: true }]),
          ]}
        />
      </Card>
    </div>
  )
}

export function Contacts({ state, onRefresh }: { state: RadioState; onRefresh: () => void }) {
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => {
    const f = filter.toLowerCase()
    return (state.contacts ?? [])
      .filter((c) => !f || c.name.toLowerCase().includes(f) || c.publicKey.startsWith(f))
      .sort((a, b) => b.lastAdvert - a.lastAdvert)
  }, [state.contacts, filter])
  return (
    <Card
      title={`Contacts${state.contacts ? ` (${state.contacts.length})` : ''}`}
      actions={
        <>
          <input className="filter" placeholder="filter by name or key" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Button kind="small" onClick={onRefresh}>refresh</Button>
        </>
      }
    >
      {rows.length ? (
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Type</th><th>Path</th><th>Last advert</th><th>Location</th><th>Key</th></tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.publicKey}>
                <td>{c.name}</td>
                <td>{ADV_TYPE_NAMES[c.type] ?? c.type}</td>
                <td>{c.outPath.known ? `${c.outPath.hops} hop${c.outPath.hops === 1 ? '' : 's'}` : <span className="muted">flood</span>}</td>
                <td title={c.lastAdvert ? new Date(c.lastAdvert * 1000).toLocaleString() : ''}>{ago(c.lastAdvert)}</td>
                <td className={!c.lat && !c.lon ? 'muted' : undefined}>{coords(c.lat, c.lon)}</td>
                <td><code title={c.publicKey}>{shortKey(c.publicKey)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{state.contacts ? 'No contacts match.' : 'Loading…'}</Empty>
      )}
    </Card>
  )
}

