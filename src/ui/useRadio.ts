import { useCallback, useEffect, useRef, useState } from 'react'
import { MeshCoreClient, MeshCoreError, type Transport } from '../protocol/client.ts'
import { ErrCode, Push } from '../protocol/codes.ts'
import {
  parseRxLog,
  type AutoaddConfig,
  type BattAndStorage,
  type ChannelInfo,
  type Contact,
  type CoreStats,
  type DeviceInfo,
  type FloodScope,
  type PacketStats,
  type RadioStats,
  type RxLogEntry,
  type SelfInfo,
  type TuningParams,
} from '../protocol/messages.ts'
import { MockRadioTransport } from '../protocol/transports/mock.ts'
import { WebSerialTransport } from '../protocol/transports/webserial.ts'

/** Settings the binary protocol can't read, fetched with CLI 'get' commands. */
export const CLI_SETTINGS: { key: string; label: string }[] = [
  { key: 'dutycycle', label: 'Duty cycle limit' },
  { key: 'txdelay', label: 'Flood TX delay factor' },
  { key: 'direct.txdelay', label: 'Direct TX delay factor' },
  { key: 'agc.reset.interval', label: 'AGC reset interval (s)' },
  { key: 'int.thresh', label: 'Interference threshold (dB)' },
  { key: 'cad', label: 'Channel activity detection' },
  { key: 'radio.rxgain', label: 'Boosted RX gain' },
  { key: 'radio.fem.rxgain', label: 'External LNA' },
  { key: 'tz.offset', label: 'Clock UTC offset' },
]

export type Status = 'disconnected' | 'connecting' | 'connected'

export interface RxEvent extends RxLogEntry {
  at: number
  id: number // stable for the session, for keys and selection
}

export interface RadioState {
  status: Status
  label?: string
  error?: string
  device?: DeviceInfo
  self?: SelfInfo
  batt?: BattAndStorage
  clock?: { radio: number; local: number } // unix secs, read at the same moment
  core?: CoreStats
  radioStats?: RadioStats
  packets?: PacketStats
  contacts?: Contact[]
  channels?: ChannelInfo[]
  customVars?: Record<string, string>
  tuning?: TuningParams
  autoadd?: AutoaddConfig
  floodScope?: FloodScope | null
  cli: Record<string, string | null>
  rx: RxEvent[]
  updatedAt?: number
}

const CONTACT_PUSHES = new Set<number>([Push.NewAdvert, Push.Advert, Push.PathUpdated, Push.ContactDeleted])

const RX_LOG_MAX = 500
const POLL_MS = 15000

const initial: RadioState = { status: 'disconnected', cli: {}, rx: [] }

export function useRadio() {
  const [state, setState] = useState<RadioState>(initial)
  const clientRef = useRef<MeshCoreClient | null>(null)
  const rxSeq = useRef(0)
  const [client, setClient] = useState<MeshCoreClient | null>(null)

  const patch = useCallback((p: Partial<RadioState>) => setState((s) => ({ ...s, ...p })), [])

  const refreshStatus = useCallback(async () => {
    const c = clientRef.current
    if (!c?.isOpen) return
    const batt = await c.getBattAndStorage()
    const radio = await c.getDeviceTime()
    const core = await c.getCoreStats()
    const radioStats = await c.getRadioStats()
    const packets = await c.getPacketStats()
    patch({ batt, clock: { radio, local: Date.now() / 1000 }, core, radioStats, packets, updatedAt: Date.now() })
  }, [patch])

  const refreshContacts = useCallback(async () => {
    const c = clientRef.current
    if (!c?.isOpen) return
    const { contacts } = await c.getContacts()
    patch({ contacts })
  }, [patch])

  const refreshSettings = useCallback(async () => {
    const c = clientRef.current
    if (!c?.isOpen) return
    const device = await c.deviceQuery()
    const self = await c.appStart()
    const customVars = await c.getCustomVars()
    const tuning = await c.getTuningParams()
    const autoadd = await c.getAutoaddConfig()
    const floodScope = await c.getDefaultFloodScope()
    const cli: Record<string, string | null> = {}
    for (const { key } of CLI_SETTINGS) cli[key] = await c.runCli(`get ${key}`)
    patch({ device, self, customVars, tuning, autoadd, floodScope, cli })
  }, [patch])

  /** Run a settings write, then re-read settings so the UI shows what the radio actually stored. */
  const write = useCallback(
    async (fn: (c: MeshCoreClient) => Promise<unknown>) => {
      const c = clientRef.current
      if (!c?.isOpen) throw new Error('not connected')
      await fn(c)
      await refreshSettings()
    },
    [refreshSettings],
  )

  const syncClock = useCallback(async () => {
    const c = clientRef.current
    if (!c?.isOpen) throw new Error('not connected')
    try {
      await c.setDeviceTime(Math.floor(Date.now() / 1000))
    } catch (err) {
      if (err instanceof MeshCoreError && err.code === ErrCode.IllegalArg) {
        throw new Error('the radio refused: its clock is ahead, and the firmware only moves it forward')
      }
      throw err
    }
    await refreshStatus()
  }, [refreshStatus])

  const refreshChannels = useCallback(async () => {
    const c = clientRef.current
    if (!c?.isOpen) return
    const max = state.device?.maxChannels ?? 40
    patch({ channels: await c.getChannels(max) })
  }, [patch, state.device?.maxChannels])

  /** Run a channel write, then re-read the slots so the UI shows what the radio stored. */
  const writeChannels = useCallback(
    async (fn: (c: MeshCoreClient) => Promise<unknown>) => {
      const c = clientRef.current
      if (!c?.isOpen) throw new Error('not connected')
      try {
        await fn(c)
      } finally {
        await refreshChannels()
      }
    },
    [refreshChannels],
  )

  const connect = useCallback(
    async (makeTransport: () => Promise<Transport>) => {
      if (clientRef.current?.isOpen) return
      patch({ ...initial, status: 'connecting' })
      let c: MeshCoreClient | null = null
      try {
        c = new MeshCoreClient(await makeTransport())
        c.on('push', (f) => {
          if (f[0] === Push.LogRxData) {
            const entry: RxEvent = { ...parseRxLog(f), at: Date.now(), id: ++rxSeq.current }
            setState((s) => ({ ...s, rx: [entry, ...s.rx].slice(0, RX_LOG_MAX) }))
          } else if (CONTACT_PUSHES.has(f[0])) {
            void refreshContacts().catch(() => {})
          }
        })
        c.on('close', (err) => {
          clientRef.current = null
          setClient(null)
          setState((s) => ({ ...s, status: 'disconnected', error: err ? `connection lost: ${err.message}` : s.error }))
        })
        await c.connect()
        clientRef.current = c
        setClient(c)
        const device = await c.deviceQuery()
        const self = await c.appStart()
        patch({ status: 'connected', label: c.label, device, self })
        await refreshStatus()
        await refreshContacts()
        patch({ channels: await c.getChannels(device.maxChannels) })
        await refreshSettings()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (c?.isOpen) {
          patch({ error: message }) // connected, but a query failed
        } else {
          clientRef.current = null
          setClient(null)
          patch({ status: 'disconnected', error: message })
        }
      }
    },
    [patch, refreshContacts, refreshSettings, refreshStatus],
  )

  const connectSerial = useCallback(() => connect(() => WebSerialTransport.request()), [connect])
  const connectDemo = useCallback(() => connect(async () => new MockRadioTransport({ rxLog: true, chatter: true, queuedMessages: 3, clockBehindSecs: 7200 })), [connect])

  const disconnect = useCallback(async () => {
    await clientRef.current?.disconnect()
  }, [])

  // keep battery, clock and counters fresh
  useEffect(() => {
    if (state.status !== 'connected') return
    const t = setInterval(() => void refreshStatus().catch(() => {}), POLL_MS)
    return () => clearInterval(t)
  }, [state.status, refreshStatus])

  const run = useCallback(
    (what: () => Promise<void>) => () =>
      void what().catch((err: unknown) => patch({ error: err instanceof Error ? err.message : String(err) })),
    [patch],
  )

  return {
    state,
    client,
    connectSerial,
    connectDemo,
    disconnect,
    clearError: () => patch({ error: undefined }),
    clearRx: () => patch({ rx: [] }),
    refreshStatus: run(refreshStatus),
    refreshContacts: run(refreshContacts),
    refreshSettings: run(refreshSettings),
    refreshChannels: run(refreshChannels),
    write,
    writeChannels,
    syncClock,
  }
}
