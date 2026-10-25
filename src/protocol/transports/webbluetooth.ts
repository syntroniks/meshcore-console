// Web Bluetooth transport (Chrome / Edge). Companion firmware built for BLE serves the Nordic UART service
// (src/helpers/{esp32,nrf52}/SerialBLEInterface.cpp): the app writes frames to RX and the radio notifies them on TX,
// one whole frame each, with no serial framing. Both characteristics need an encrypted link with MITM, so the
// first access pairs with the radio's 6-digit PIN.

import type { Transport, TransportSink } from '../client.ts'

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e' // app -> radio
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e' // radio -> app

/** BLE_NAME_PREFIX in MyMesh.h; the advertised name is this plus the node name. */
const NAME_PREFIX = 'MeshCore-'

export const isWebBluetoothSupported = (): boolean => typeof navigator !== 'undefined' && 'bluetooth' in navigator

/** Chrome on Linux pairs through BlueZ but answers its passkey request with a cancel (web_bluetooth_pairing_manager_impl.cc). */
export const pairsInBrowser = (): boolean => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return !(/Linux/.test(ua) && !/Android|CrOS/.test(ua))
}

export class WebBluetoothTransport implements Transport {
  readonly framed = true
  readonly label = 'Bluetooth'
  readonly device: BluetoothDevice
  private rx: BluetoothRemoteGATTCharacteristic | null = null
  private tx: BluetoothRemoteGATTCharacteristic | null = null
  private sink: TransportSink | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private closing = false

  constructor(device: BluetoothDevice) {
    this.device = device
  }

  /** Ask the user to pick a radio; null if they close the chooser. Must be called from a click handler. */
  static async request(): Promise<WebBluetoothTransport | null> {
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS_SERVICE] }, { namePrefix: NAME_PREFIX }],
        optionalServices: [NUS_SERVICE],
      })
      return new WebBluetoothTransport(device)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError' && /cancel/i.test(err.message)) return null
      throw err
    }
  }

  get name(): string {
    return this.device.name ?? 'radio'
  }

  async open(sink: TransportSink): Promise<void> {
    const gatt = this.device.gatt
    if (!gatt) throw new Error('this Bluetooth device has no GATT server')
    this.closing = false
    this.sink = sink
    this.device.addEventListener('gattserverdisconnected', this.onDisconnected)
    try {
      const server = await gatt.connect()
      const service = await server.getPrimaryService(NUS_SERVICE)
      this.rx = await service.getCharacteristic(NUS_RX)
      this.tx = await service.getCharacteristic(NUS_TX)
      this.tx.addEventListener('characteristicvaluechanged', this.onNotify)
      // Pair here, before any command, so the PIN prompt doesn't run into a request timeout. nRF52 protects the
      // notify descriptor; ESP32 leaves it open but protects reads of TX, and only answers once the link is secure.
      await this.tx.startNotifications()
      if (this.tx.properties.read) await this.tx.readValue()
    } catch (err) {
      this.closing = true
      this.teardown()
      throw pairingError(err, this.name)
    }
  }

  private readonly onNotify = (e: Event) => {
    const value = (e.target as BluetoothRemoteGATTCharacteristic).value
    if (value?.byteLength) this.sink?.onData(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice())
  }

  private readonly onDisconnected = () => {
    const sink = this.sink
    this.teardown()
    if (!this.closing) sink?.onClose(new Error(`Bluetooth link to ${this.name} dropped`))
  }

  /** One GATT write at a time: Chrome rejects a write while another is in flight. */
  write(data: Uint8Array): Promise<void> {
    const rx = this.rx
    if (!rx) return Promise.reject(new Error('not connected'))
    const buf = data.slice() // a fresh ArrayBuffer-backed copy for the BufferSource type
    const w = this.writes.then(() => rx.writeValueWithResponse(buf))
    this.writes = w.catch(() => {})
    return w
  }

  async close(): Promise<void> {
    this.closing = true
    try {
      await this.tx?.stopNotifications()
    } catch {
      // already gone
    }
    this.teardown()
  }

  private teardown(): void {
    this.tx?.removeEventListener('characteristicvaluechanged', this.onNotify)
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected)
    this.rx = this.tx = null
    this.sink = null
    if (this.device.gatt?.connected) this.device.gatt.disconnect()
  }
}

/** Say what a failed setup most likely means, since the browser's errors don't mention the PIN. */
export function pairingError(err: unknown, name: string): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (/authenticat|authoriz|pair|insufficient|encrypt/i.test(message)) {
    return new Error(
      pairsInBrowser()
        ? `pairing with ${name} failed (${message}). Use the PIN on the radio's screen, or 123456 if it has none. If the radio was erased or reflashed, remove it from this computer's Bluetooth devices and connect again.`
        : `pairing with ${name} failed (${message}). Chrome on Linux can't enter a Bluetooth PIN: pair the radio once in the system's Bluetooth settings or with bluetoothctl, then connect again.`,
    )
  }
  if (/disconnected/i.test(message)) {
    return new Error(`${name} closed the Bluetooth link during setup (${message}). A wrong PIN does this, and so does another app that is already connected to the radio.`)
  }
  if (/no services/i.test(message)) {
    return new Error(`${name} has no MeshCore companion service. It needs companion firmware built for BLE.`)
  }
  return err instanceof Error ? err : new Error(message)
}
