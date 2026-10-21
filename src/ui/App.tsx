import { useCallback, useEffect, useRef, useState } from 'react'
import { isWebSerialSupported } from '../protocol/transports/webserial.ts'
import { MessagesView } from './MessagesView.tsx'
import { Button } from './parts.tsx'
import { Shell, type ShellHandle } from './Shell.tsx'
import { useMessages } from './useMessages.ts'
import { useRadio } from './useRadio.ts'
import { Channels, Contacts, driftText, Overview, Packets, Settings } from './views.tsx'

type Tab = 'overview' | 'messages' | 'settings' | 'contacts' | 'channels' | 'packets'

export function App() {
  const radio = useRadio()
  const { state } = radio
  const msgs = useMessages(radio.client, state.self?.publicKey, state.contacts, state.channels)
  const [clockDismissed, setClockDismissed] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')
  const shell = useRef<ShellHandle>(null)
  const [dockHeight, setDockHeight] = useState(300)
  const connected = state.status === 'connected'
  const webSerial = isWebSerialSupported()
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
            <Button kind="primary" onClick={() => void radio.connectSerial()} disabled={!webSerial || state.status === 'connecting'} title={webSerial ? 'Pick the radio’s USB serial port' : 'WebSerial needs Chrome or Edge on desktop'}>
              Connect USB
            </Button>
            <Button onClick={() => void radio.connectDemo()} disabled={state.status === 'connecting'}>
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
          <Welcome webSerial={webSerial} onConnect={() => void radio.connectSerial()} onDemo={() => void radio.connectDemo()} />
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
              {tab === 'overview' && <Overview state={state} onSyncClock={radio.syncClock} />}
              {tab === 'messages' && <MessagesView msgs={msgs} connected={connected} nodeName={state.self?.name} />}
              {tab === 'settings' && <Settings state={state} write={radio.write} onRefresh={radio.refreshSettings} />}
              {tab === 'contacts' && <Contacts state={state} onRefresh={radio.refreshContacts} />}
              {tab === 'channels' && <Channels state={state} onRefresh={radio.refreshChannels} />}
              {tab === 'packets' && <Packets state={state} onClear={radio.clearRx} />}
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

function Welcome({ webSerial, onConnect, onDemo }: { webSerial: boolean; onConnect: () => void; onDemo: () => void }) {
  return (
    <div className="welcome">
      <h1>Connect a MeshCore companion radio</h1>
      <p className="muted">
        Plug the radio in over USB and pick its serial port. It needs companion firmware built for USB
        (eg. <code>heltec_v4_companion_radio_usb</code>), v1.18 or newer for the shell.
      </p>
      {!webSerial && <p className="banner banner-error">This browser has no WebSerial. Use Chrome or Edge on desktop.</p>}
      <div className="welcome-actions">
        <Button kind="primary" onClick={onConnect} disabled={!webSerial}>Connect USB</Button>
        <Button onClick={onDemo}>Try the demo radio</Button>
      </div>
    </div>
  )
}
