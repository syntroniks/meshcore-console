// WebSerial transport (Chrome / Edge on desktop). Needs a secure context: https or localhost.

import type { Transport, TransportSink } from '../client.ts'

export const isWebSerialSupported = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator

export class WebSerialTransport implements Transport {
  readonly label: string
  private readonly port: SerialPort
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private closing = false

  constructor(port: SerialPort) {
    this.port = port
    const info = port.getInfo()
    this.label =
      info.usbVendorId !== undefined
        ? `USB ${hex4(info.usbVendorId)}:${hex4(info.usbProductId ?? 0)}`
        : 'serial port'
  }

  /** Ask the user to pick a port; null if they close the chooser. Must be called from a click handler. */
  static async request(): Promise<WebSerialTransport | null> {
    try {
      return new WebSerialTransport(await navigator.serial.requestPort())
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return null // no port selected
      throw err
    }
  }

  /** A port the user already granted on an earlier visit, if any. */
  static async previouslyGranted(): Promise<WebSerialTransport | null> {
    const [port] = await navigator.serial.getPorts()
    return port ? new WebSerialTransport(port) : null
  }

  async open(sink: TransportSink): Promise<void> {
    this.closing = false
    await this.port.open({ baudRate: 115200 })
    void this.readLoop(sink)
  }

  private async readLoop(sink: TransportSink): Promise<void> {
    let error: Error | undefined
    try {
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader()
        try {
          for (;;) {
            const { value, done } = await this.reader.read()
            if (done) break
            if (value) sink.onData(value)
          }
        } finally {
          this.reader.releaseLock()
          this.reader = null
        }
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err)) // eg. the device was unplugged
    }
    if (!this.closing) sink.onClose(error)
  }

  async write(data: Uint8Array): Promise<void> {
    const writable = this.port.writable
    if (!writable) throw new Error('port not writable')
    const writer = writable.getWriter()
    try {
      await writer.write(data)
    } finally {
      writer.releaseLock()
    }
  }

  async close(): Promise<void> {
    this.closing = true
    try {
      await this.reader?.cancel()
    } catch {
      // already gone
    }
    try {
      await this.port.close()
    } catch {
      // already closed, or unplugged
    }
  }
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0')
