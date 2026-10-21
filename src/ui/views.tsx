import { useMemo, useState } from 'react'
import { toHex } from '../protocol/bytes.ts'
import { ADV_TYPE_NAMES, AutoAdd } from '../protocol/codes.ts'
import { Button, Card, Empty, Rows, type Row } from './parts.tsx'
import { CLI_SETTINGS, type RadioState } from './useRadio.ts'
import { ago, batteryPercent, cliValue, coords, duration, shortKey, time } from './format.ts'

const TELEMETRY = ['deny', 'per contact', 'allow all']

/** firmware: 0 = no limit, 1 = direct only, N = up to N-1 hops */
const maxHopsText = (n: number) => (n === 0 ? 'no limit' : n === 1 ? 'direct only' : `${n - 1}`)

export function Overview({ state }: { state: RadioState }) {
  const { self, batt, clock, core, radioStats: r, packets: p } = state
  const drift = clock ? Math.round(clock.radio - clock.local) : 0
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
      <Card title="Clock">
        <Rows
          rows={[
            { label: 'Radio time', value: clock ? new Date(clock.radio * 1000).toLocaleString() : '…' },
            {
              label: 'Drift',
              value: clock ? (Math.abs(drift) < 3 ? 'in sync' : `${drift > 0 ? '+' : ''}${duration(Math.abs(drift))}${drift > 0 ? ' ahead' : ' behind'}`) : '…',
              muted: Math.abs(drift) < 3,
            },
            { label: 'Uptime', value: core ? duration(core.uptimeSecs) : '…' },
          ]}
        />
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
        {state.rx.length ? (
          <ul className="mini-log">
            {state.rx.slice(0, 6).map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className="muted">{time(e.at)}</span> {e.packet?.payloadName ?? 'unparsed'}{' '}
                <span className="muted">
                  {e.packet?.routeName} · {e.rssi} dBm · SNR {e.snr}
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

export function Settings({ state, onEdit, onRefresh }: { state: RadioState; onEdit: (cmd: string) => void; onRefresh: () => void }) {
  const { device: d, self: s, tuning, autoadd, floodScope, customVars } = state
  const edit = (cmd: string) => (
    <Button kind="small" onClick={() => onEdit(cmd)} title="Edit in the shell">
      edit
    </Button>
  )
  const autoTypes = autoadd
    ? [
        autoadd.flags & AutoAdd.Chat && 'companions',
        autoadd.flags & AutoAdd.Repeater && 'repeaters',
        autoadd.flags & AutoAdd.RoomServer && 'room servers',
        autoadd.flags & AutoAdd.Sensor && 'sensors',
      ].filter(Boolean).join(', ') || 'none'
    : '…'

  const cliRows: Row[] = CLI_SETTINGS.map(({ key, label }) => {
    const v = cliValue(state.cli[key])
    return { label, value: v.text, muted: !v.ok, action: v.ok ? edit(`set ${key} ${v.text.replace(/%$/, '')}`) : undefined }
  })

  return (
    <div className="grid">
      <Card title="Device" actions={<Button kind="small" onClick={onRefresh}>refresh</Button>}>
        <Rows
          rows={[
            { label: 'Firmware', value: d ? `${d.firmwareVersion} (${d.buildDate})` : '…' },
            { label: 'Board', value: d?.manufacturer ?? '…' },
            { label: 'Protocol', value: d ? `v${d.protocolVersion}` : '…' },
            { label: 'Capacity', value: d ? `${d.maxContacts} contacts, ${d.maxChannels} channels` : '…' },
            { label: 'BLE PIN', value: d ? (d.blePin ? String(d.blePin).padStart(6, '0') : 'random each boot') : '…', action: edit('set pin ') },
            { label: 'Repeats packets', value: d?.clientRepeat === undefined ? '…' : d.clientRepeat ? 'yes' : 'no' },
          ]}
        />
      </Card>
      <Card title="Identity">
        <Rows
          rows={[
            { label: 'Name', value: s?.name ?? '…', action: s && edit(`set name ${s.name}`) },
            { label: 'Type', value: s ? ADV_TYPE_NAMES[s.advType] : '…' },
            {
              label: 'Public key',
              value: s ? <code className="wrap">{s.publicKey}</code> : '…',
              action: s && <Button kind="small" onClick={() => void navigator.clipboard.writeText(s.publicKey)}>copy</Button>,
            },
            { label: 'Location', value: s ? coords(s.lat, s.lon) : '…', muted: !s?.lat && !s?.lon },
            { label: 'Location in adverts', value: s ? (s.advertLocationPolicy ? 'shared' : 'not shared') : '…' },
          ]}
        />
      </Card>
      <Card title="Radio">
        <Rows
          rows={[
            {
              label: 'Frequency',
              value: s ? `${s.radio.freqMHz} MHz` : '…',
              action: s && edit(`set radio ${s.radio.freqMHz},${s.radio.bwKHz},${s.radio.sf},${s.radio.cr}`),
            },
            { label: 'Bandwidth', value: s ? `${s.radio.bwKHz} kHz` : '…' },
            { label: 'Spreading factor', value: s ? `SF${s.radio.sf}` : '…' },
            { label: 'Coding rate', value: s ? `4/${s.radio.cr}` : '…' },
            { label: 'TX power', value: s ? `${s.txPowerDbm} dBm (max ${s.maxTxPowerDbm})` : '…', action: s && edit(`set tx ${s.txPowerDbm}`) },
            { label: 'Airtime factor', value: tuning?.airtimeFactor ?? '…', action: tuning && edit(`set af ${tuning.airtimeFactor}`) },
            { label: 'RX delay base', value: tuning?.rxDelayBase ?? '…', action: tuning && edit(`set rxdelay ${tuning.rxDelayBase}`) },
          ]}
        />
      </Card>
      <Card title="Firmware settings">
        <Rows rows={cliRows} />
      </Card>
      <Card title="Contacts & telemetry">
        <Rows
          rows={[
            { label: 'Add contacts', value: s ? (s.manualAddContacts ? 'manually (by type below)' : 'automatically, all types') : '…' },
            { label: 'Auto-add types', value: autoTypes, muted: !s?.manualAddContacts },
            { label: 'When full', value: autoadd ? (autoadd.flags & AutoAdd.OverwriteOldest ? 'overwrite oldest' : 'stop adding') : '…' },
            { label: 'Auto-add max hops', value: autoadd ? maxHopsText(autoadd.maxHops) : '…' },
            { label: 'Telemetry: base', value: s ? TELEMETRY[s.telemetry.base] : '…' },
            { label: 'Telemetry: location', value: s ? TELEMETRY[s.telemetry.location] : '…' },
            { label: 'Telemetry: environment', value: s ? TELEMETRY[s.telemetry.environment] : '…' },
          ]}
        />
      </Card>
      <Card title="Scope & sensors">
        <Rows
          rows={[
            { label: 'Default flood scope', value: floodScope === undefined ? '…' : floodScope ? floodScope.name : 'none (unscoped)', muted: !floodScope },
            ...(customVars && Object.keys(customVars).length
              ? Object.entries(customVars).map(([k, v]) => ({ label: `Sensor: ${k}`, value: v }))
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

export function Channels({ state, onRefresh }: { state: RadioState; onRefresh: () => void }) {
  const [reveal, setReveal] = useState(false)
  return (
    <Card
      title={`Channels${state.channels ? ` (${state.channels.length})` : ''}`}
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
            <tr><th>#</th><th>Name</th><th>Secret</th></tr>
          </thead>
          <tbody>
            {state.channels.map((c) => (
              <tr key={c.index}>
                <td>{c.index}</td>
                <td>{c.name || <span className="muted">(unnamed)</span>}</td>
                <td><code>{reveal ? c.secret : '•'.repeat(16)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{state.channels ? 'No channels configured.' : 'Loading…'}</Empty>
      )}
    </Card>
  )
}

export function Packets({ state, onClear }: { state: RadioState; onClear: () => void }) {
  return (
    <Card title={`Received packets (${state.rx.length})`} actions={<Button kind="small" onClick={onClear}>clear</Button>}>
      {state.rx.length ? (
        <table className="table">
          <thead>
            <tr><th>Time</th><th>Type</th><th>Route</th><th>Hops</th><th>Payload</th><th>RSSI</th><th>SNR</th><th>Raw</th></tr>
          </thead>
          <tbody>
            {state.rx.map((e, i) => (
              <tr key={`${e.at}-${i}`}>
                <td className="muted">{time(e.at)}</td>
                <td>{e.packet?.payloadName ?? 'unparsed'}</td>
                <td>{e.packet?.routeName ?? ''}</td>
                <td>{e.packet?.hops ?? ''}</td>
                <td>{e.packet ? `${e.packet.payloadLength} B` : `${e.raw.length} B`}</td>
                <td>{e.rssi} dBm</td>
                <td>{e.snr} dB</td>
                <td><code className="raw" title={toHex(e.raw)}>{toHex(e.raw).slice(0, 24)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>The radio reports every packet it receives while the console is connected. Nothing yet.</Empty>
      )}
    </Card>
  )
}
