import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isWebBluetoothSupported, pairsInBrowser } from '../protocol/transports/webbluetooth.ts'
import { isWebSerialSupported } from '../protocol/transports/webserial.ts'
import { ChannelsView, useChannelEditor } from './ChannelsView.tsx'
import { MessagesView } from './MessagesView.tsx'
import { PacketsView } from './PacketsView.tsx'
import { Button } from './parts.tsx'
import { Shell, type ShellHandle } from './Shell.tsx'
import { useChannelKeys } from './useChannelKeys.ts'
import { useMessages } from './useMessages.ts'
import { useAnalyzedPackets } from './usePackets.ts'
import { useRadio } from './useRadio.ts'
import { Contacts, driftText, Overview, Settings } from './views.tsx'

type Tab = 'overview' | 'messages' | 'settings' | 'contacts' | 'channels' | 'packets'

export function App() {
  const radio = useRadio()
  const { state } = radio
  const msgs = useMessages(radio.client, state.self?.publicKey, state.contacts, state.channels)
  const channelKeys = useChannelKeys(state.channels)
  const packets = useAnalyzedPackets(state, channelKeys.keys)
  // free slots that still hold stored messages, which Messages files by slot
  const busySlots = useMemo(
    () => new Set(msgs.conversations.filter((c) => c.id.startsWith('ch:') && c.last).map((c) => Number(c.id.slice(3)))),
    [msgs.conversations],
  )
  const channelEditor = useChannelEditor(state, radio.writeChannels, busySlots)
  const [clockDismissed, setClockDismissed] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')
  const shell = useRef<ShellHandle>(null)
  const [dockHeight, setDockHeight] = useState(300)
  const connected = state.status === 'connected'
  const webSerial = isWebSerialSupported()
  const webBluetooth = isWebBluetoothSupported()
  const connecting = state.status === 'connecting'
  const drift = state.clock ? Math.round(state.clock.radio - state.clock.local) : 0

  useEffect(() => {
    document.title = msgs.unreadTotal ? `(${msgs.unreadTotal}) MeshCore Console` : 'MeshCore Console'
  }, [msgs.unreadTotal])

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      const startY = e.clientY
      const startH = dockHeight
      const move = (ev: PointerEvent) => setDockHeight(Math.max(120, Math.min(window.innerHeight - 160, startH - (ev.clientY - startY))))
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [dockHeight],
  )

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'messages', label: msgs.unreadTotal ? `Messages · ${msgs.unreadTotal} new` : 'Messages' },
    { id: 'settings', label: 'Settings' },
    { id: 'contacts', label: `Contacts${state.contacts ? ` · ${state.contacts.length}` : ''}` },
    { id: 'channels', label: `Channels${state.channels ? ` · ${state.channels.length}` : ''}` },
    { id: 'packets', label: `Packets${state.rx.length ? ` · ${state.rx.length}` : ''}` },
  ]

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">MeshCore Console</span>
        <span className={`status status-${state.status}`}>
          <span className="dot" />
          {state.status === 'connected' ? `${state.self?.name ?? 'radio'} · ${state.label}` : state.status}
        </span>
        {state.device && <span className="muted">{state.device.manufacturer} · {state.device.firmwareVersion}</span>}
        <span className="spacer" />
        {connected ? (
          <Button onClick={() => void radio.disconnect()}>Disconnect</Button>
        ) : (
          <>
            <Button kind="primary" onClick={() => void radio.connectSerial()} disabled={!webSerial || connecting} title={webSerial ? 'Pick the radio’s USB serial port' : 'WebSerial needs Chrome or Edge on desktop'}>
              Connect USB
            </Button>
            <Button onClick={() => void radio.connectBluetooth()} disabled={!webBluetooth || connecting} title={webBluetooth ? 'Pick the radio and pair with its PIN' : 'Web Bluetooth needs Chrome or Edge'}>
              Connect Bluetooth
            </Button>
            {radio.bleName && (
              <Button onClick={() => void radio.reconnectBluetooth()} disabled={connecting} title="Connect to the same radio again, without the chooser">
                Reconnect {radio.bleName}
              </Button>
            )}
            <Button onClick={() => void radio.connectDemo()} disabled={connecting}>
              Demo radio
            </Button>
          </>
        )}
      </header>

      {state.error && (
        <div className="banner banner-error">
          {state.error}
          <button className="banner-close" onClick={radio.clearError}>×</button>
        </div>
      )}
      {connected && drift < -60 && !clockDismissed && (
        <div className="banner">
          The radio’s clock is {driftText(drift)}. Messages and adverts carry its timestamps.
          <Button kind="small" onClick={() => void radio.syncClock().catch(() => {})}>sync clock</Button>
          <button className="banner-close" onClick={() => setClockDismissed(true)}>×</button>
        </div>
      )}

      <div className="workspace">
        {state.status === 'disconnected' && !state.device ? (
          <Welcome webSerial={webSerial} webBluetooth={webBluetooth} onSerial={() => void radio.connectSerial()} onBluetooth={() => void radio.connectBluetooth()} onDemo={() => void radio.connectDemo()} />
        ) : (
          <>
            <nav className="tabs">
              {tabs.map((t) => (
                <button key={t.id} className={`tab ${tab === t.id ? 'tab-active' : ''}`} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              ))}
              <span className="spacer" />
              {state.updatedAt && <span className="muted small">updated {new Date(state.updatedAt).toLocaleTimeString([], { hour12: false })}</span>}
              <Button kind="small" onClick={radio.refreshStatus} disabled={!connected}>refresh</Button>
            </nav>
            <main className="view">
              {tab === 'overview' && <Overview state={state} packets={packets} onSyncClock={radio.syncClock} />}
              {tab === 'messages' && <MessagesView msgs={msgs} connected={connected} nodeName={state.self?.name} />}
              {tab === 'settings' && <Settings state={state} write={radio.write} onRefresh={radio.refreshSettings} />}
              {tab === 'contacts' && <Contacts state={state} onRefresh={radio.refreshContacts} />}
              {tab === 'channels' && <ChannelsView state={state} editor={channelEditor} onRefresh={radio.refreshChannels} />}
              {tab === 'packets' && <PacketsView packets={packets} channelKeys={channelKeys} editor={channelEditor} onClear={radio.clearRx} />}
            </main>
          </>
        )}
      </div>

      <div className="dock" style={{ height: dockHeight }}>
        <div className="dock-handle" onPointerDown={startDrag} title="Drag to resize">
          <span>Shell</span>
          <span className="muted small">commands go to the radio’s CLI · /help</span>
        </div>
        <Shell ref={shell} client={radio.client} nodeName={state.self?.name} />
      </div>
    </div>
  )
}

function Welcome({ webSerial, webBluetooth, onSerial, onBluetooth, onDemo }: { webSerial: boolean; webBluetooth: boolean; onSerial: () => void; onBluetooth: () => void; onDemo: () => void }) {
  const linux = !pairsInBrowser()
  return (
    <div className="welcome">
      <h1>Connect a MeshCore companion radio</h1>
      <p className="muted">
        <strong>USB:</strong> plug the radio in and pick its serial port. It needs companion firmware built for USB
        (eg. <code>heltec_v4_companion_radio_usb</code>), v1.18 or newer for the shell.
      </p>
      <p className="muted">
        <strong>Bluetooth:</strong> pick the radio, then pair with its PIN: the one on its screen, or <code>123456</code> if
        it has no screen, unless you set your own under Settings. It needs firmware built for BLE
        (eg. <code>heltec_v4_companion_radio_ble</code>). The radio takes one Bluetooth connection at a time, so disconnect
        the MeshCore phone app first.
      </p>
      {!webSerial && <p className="banner banner-error">This browser has no WebSerial. Use Chrome or Edge on desktop.</p>}
      {!webBluetooth && (
        <p className="banner banner-error">
          <span>
            This browser has no Web Bluetooth. Use Chrome or Edge{linux && <>; on Linux, turn on <code>chrome://flags/#enable-web-bluetooth</code> first</>}.
          </span>
        </p>
      )}
      {linux && (
        <div className="banner">
          <div>
            Chrome on Linux can’t enter a Bluetooth PIN. Pair the radio once in the system’s Bluetooth settings, or
            with <code>bluetoothctl</code>, then connect here:
            <pre className="welcome-pre">{`bluetoothctl
scan on                # wait for MeshCore-… and note its address
pair AA:BB:CC:DD:EE:FF # enter the PIN when asked
disconnect AA:BB:CC:DD:EE:FF`}</pre>
          </div>
        </div>
      )}
      <div className="welcome-actions">
        <Button kind="primary" onClick={onSerial} disabled={!webSerial}>Connect USB</Button>
        <Button kind="primary" onClick={onBluetooth} disabled={!webBluetooth}>Connect Bluetooth</Button>
        <Button onClick={onDemo}>Try the demo radio</Button>
      </div>
    </div>
  )
}
