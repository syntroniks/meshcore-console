import { describe, expect, it } from 'vitest'
import { MeshCoreClient, type TransportSink } from '../src/protocol/client.ts'
import { Cmd } from '../src/protocol/codes.ts'
import { MockRadioTransport } from '../src/protocol/transports/mock.ts'
import { NUS_RX, NUS_SERVICE, NUS_TX, WebBluetoothTransport } from '../src/protocol/transports/webbluetooth.ts'

/** Just enough of a Web Bluetooth device: the Nordic UART service, relayed to the demo radio in whole frames. */
class FakeRadio extends EventTarget {
  readonly name = 'MeshCore-Demo Node'
  readonly log: string[] = []
  readonly written: number[][] = []
  inFlight = 0
  maxInFlight = 0
  failPairing: Error | null = null
  private readonly radio = new MockRadioTransport({ framed: true })
  private notifying = false

  readonly tx = Object.assign(new EventTarget(), {
    uuid: NUS_TX,
    properties: { read: true, notify: true },
    value: undefined as DataView | undefined,
    startNotifications: async () => {
      this.log.push('startNotifications')
      if (this.failPairing) throw this.failPairing
      this.notifying = true
      return this.tx
    },
    stopNotifications: async () => {
      this.notifying = false
      return this.tx
    },
    readValue: async () => {
      this.log.push('readValue')
      return new DataView(new ArrayBuffer(0))
    },
  })

  readonly rx = {
    uuid: NUS_RX,
    writeValueWithResponse: async (buf: Uint8Array) => {
      this.log.push('write')
      this.inFlight++
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
      await new Promise((r) => setTimeout(r, 1))
      this.inFlight--
      this.written.push([...buf])
      await this.radio.write(buf)
    },
  }

  readonly gatt = {
    connected: false,
    connect: async () => {
      this.gatt.connected = true
      const sink: TransportSink = {
        onData: (frame) => {
          if (!this.notifying) return
          this.tx.value = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
          this.tx.dispatchEvent(new Event('characteristicvaluechanged'))
        },
        onClose: () => {},
      }
      await this.radio.open(sink)
      return this.gatt
    },
    disconnect: () => {
      this.gatt.connected = false
    },
    getPrimaryService: async (uuid: string) => {
      if (uuid !== NUS_SERVICE) throw new DOMException(`No Services matching UUID ${uuid} found in Device.`, 'NotFoundError')
      return { getCharacteristic: async (c: string) => (c === NUS_RX ? this.rx : this.tx) }
    },
  }

  /** the radio walks out of range */
  drop(): void {
    this.gatt.connected = false
    void this.radio.close()
    this.dispatchEvent(new Event('gattserverdisconnected'))
  }
}

const transportFor = (radio: FakeRadio) => new WebBluetoothTransport(radio as unknown as BluetoothDevice)

describe('WebBluetoothTransport', () => {
  it('pairs before the first command, then talks in whole frames, one write at a time', async () => {
    const radio = new FakeRadio()
    const transport = transportFor(radio)
    const client = new MeshCoreClient(transport)
    await client.connect()
    expect(radio.log).toEqual(['startNotifications', 'readValue'])
    const [device, self, ch] = await Promise.all([client.deviceQuery(), client.appStart(), client.getChannel(1)])
    expect(device.firmwareVersion).toBe('v1.18.0-demo')
    expect(self.name).toBe('Demo Node')
    expect(ch?.name).toBe('#austin')
    expect(radio.written[0]).toEqual([Cmd.DeviceQuery, 3]) // no '<' len header
    const time = Uint8Array.of(Cmd.GetDeviceTime)
    await Promise.all([transport.write(time), transport.write(time), transport.write(time)])
    expect(radio.maxInFlight).toBe(1)
    await client.disconnect()
    expect(radio.gatt.connected).toBe(false)
  })

  it('reports a dropped link and fails what was pending', async () => {
    const radio = new FakeRadio()
    const client = new MeshCoreClient(transportFor(radio))
    const closed: (Error | undefined)[] = []
    client.on('close', (err) => closed.push(err))
    await client.connect()
    const p = client.getDeviceTime()
    radio.drop()
    await expect(p).rejects.toThrow('Bluetooth link to MeshCore-Demo Node dropped')
    expect(closed[0]?.message).toMatch(/dropped/)
    expect(client.isOpen).toBe(false)
  })

  it('says what a failed pairing means, and lets go of the link', async () => {
    const radio = new FakeRadio()
    radio.failPairing = new DOMException('Authentication canceled.', 'NetworkError')
    const client = new MeshCoreClient(transportFor(radio))
    await expect(client.connect()).rejects.toThrow(/pairing with MeshCore-Demo Node failed .*PIN/)
    expect(radio.gatt.connected).toBe(false)
    expect(client.isOpen).toBe(false)
  })
})
