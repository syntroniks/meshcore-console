// node-serialport transport, for scripts that talk to a radio outside the browser.

import { SerialPort } from 'serialport'
import type { Transport, TransportSink } from '../src/protocol/client.ts'

export class NodeSerialTransport implements Transport {
  readonly label: string
  private readonly path: string
  private port: SerialPort | null = null

  constructor(path: string) {
    this.path = path
    this.label = path
  }

  open(sink: TransportSink): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: this.path, baudRate: 115200 }, (err) => {
        if (err) reject(err)
        else resolve()
      })
      port.on('data', (chunk: Buffer) => sink.onData(new Uint8Array(chunk)))
      port.on('close', () => sink.onClose())
      port.on('error', (err: Error) => sink.onClose(err))
      this.port = port
    })
  }

  write(data: Uint8Array): Promise<void> {
    const port = this.port
    if (!port) return Promise.reject(new Error('port not open'))
    return new Promise((resolve, reject) => {
      port.write(Buffer.from(data), (err) => (err ? reject(err) : port.drain(() => resolve())))
    })
  }

  close(): Promise<void> {
    const port = this.port
    this.port = null
    if (!port?.isOpen) return Promise.resolve()
    return new Promise((resolve) => port.close(() => resolve()))
  }
}

/** USB vendor ids of boards that commonly run MeshCore. */
const KNOWN_VENDORS = new Set(['303a', '239a', '2e8a', '10c4', '1a86', '0403', '2886'])

export async function findRadioPort(): Promise<string | undefined> {
  const ports = await SerialPort.list()
  return ports.find((p) => p.vendorId && KNOWN_VENDORS.has(p.vendorId.toLowerCase()))?.path
}
