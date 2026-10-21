import { afterEach, describe, expect, it, vi } from 'vitest'
import { MeshCoreClient, MeshCoreError, type Transport, type TransportSink } from '../src/protocol/client.ts'
import { ErrCode, Push, Resp } from '../src/protocol/codes.ts'
import { MockRadioTransport } from '../src/protocol/transports/mock.ts'

/** A transport whose replies the test scripts by hand. */
class ScriptedTransport implements Transport {
  readonly label = 'scripted'
  sink: TransportSink | null = null
  written: Uint8Array[] = []

  async open(sink: TransportSink) {
    this.sink = sink
  }
  async write(data: Uint8Array) {
    this.written.push(data.slice(3)) // drop the '<' len header
  }
  async close() {}

  reply(payload: number[]) {
    this.sink!.onData(Uint8Array.from([0x3e, payload.length, 0, ...payload]))
  }
}

afterEach(() => vi.useRealTimers())

describe('MeshCoreClient against the mock radio', () => {
  it('runs the connect sequence and the read-only queries', async () => {
    const client = new MeshCoreClient(new MockRadioTransport())
    await client.connect()
    const device = await client.deviceQuery()
    expect(device.firmwareVersion).toBe('v1.18.0-demo')
    expect((await client.appStart()).name).toBe('Demo Node')
    const { total, contacts } = await client.getContacts()
    expect(total).toBe(3)
    expect(contacts.map((c) => c.name)).toContain('Alex 📡')
    expect((await client.getChannels(device.maxChannels)).map((c) => c.name)).toEqual(['Public', '#austin'])
    expect(await client.runCli('get tx')).toBe('> 22')
    expect(await client.runCli('set tx 17')).toBe('OK')
    expect(await client.runCli('get tx')).toBe('> 17')
    await client.disconnect()
  })

  it('answers queued requests in order', async () => {
    const client = new MeshCoreClient(new MockRadioTransport())
    await client.connect()
    const [a, b, c] = await Promise.all([client.runCli('ver'), client.getCoreStats(), client.runCli('board')])
    expect(a).toMatch(/^v1\.18\.0-demo/)
    expect(b.batteryMv).toBe(3987)
    expect(c).toBe('Demo Board')
    await client.disconnect()
  })
})

describe('MeshCoreClient reply handling', () => {
  it('turns RESP_CODE_ERR into a MeshCoreError with the error code', async () => {
    const t = new ScriptedTransport()
    const client = new MeshCoreClient(t)
    await client.connect()
    const p = client.getTuningParams()
    await vi.waitFor(() => expect(t.written).toHaveLength(1))
    t.reply([Resp.Err, ErrCode.UnsupportedCmd])
    await expect(p).rejects.toMatchObject({ name: 'MeshCoreError', code: ErrCode.UnsupportedCmd })
    expect(MeshCoreError).toBeDefined()
  })

  it('routes pushes to listeners without disturbing the pending request', async () => {
    const t = new ScriptedTransport()
    const client = new MeshCoreClient(t)
    const pushes: number[] = []
    client.on('push', (f) => pushes.push(f[0]))
    await client.connect()
    const p = client.getDeviceTime()
    await vi.waitFor(() => expect(t.written).toHaveLength(1))
    t.reply([Push.MsgWaiting])
    t.reply([Resp.CurrTime, 0x10, 0x20, 0x30, 0x40])
    expect(await p).toBe(0x40302010)
    expect(pushes).toEqual([Push.MsgWaiting])
  })

  it('reports a reply for some other command as unsolicited', async () => {
    const t = new ScriptedTransport()
    const client = new MeshCoreClient(t)
    const stray: number[] = []
    client.on('unsolicited', (f) => stray.push(f[0]))
    await client.connect()
    const p = client.getDeviceTime()
    await vi.waitFor(() => expect(t.written).toHaveLength(1))
    t.reply([Resp.CliReply, 0x4f, 0x4b]) // a late CLI reply
    t.reply([Resp.CurrTime, 1, 0, 0, 0])
    expect(await p).toBe(1)
    expect(stray).toEqual([Resp.CliReply])
  })

  it('returns null when a CLI command gets no reply, then carries on', async () => {
    vi.useFakeTimers()
    const t = new ScriptedTransport()
    const client = new MeshCoreClient(t)
    await client.connect()
    const reboot = client.runCli('reboot', 1000)
    const next = client.getDeviceTime()
    await vi.advanceTimersByTimeAsync(1001)
    expect(await reboot).toBeNull()
    t.reply([Resp.CurrTime, 2, 0, 0, 0])
    expect(await next).toBe(2)
  })

  it('fails pending requests when the transport closes', async () => {
    const t = new ScriptedTransport()
    const client = new MeshCoreClient(t)
    await client.connect()
    const p = client.getDeviceTime()
    t.sink!.onClose(new Error('device lost'))
    await expect(p).rejects.toThrow('device lost')
    expect(client.isOpen).toBe(false)
  })
})
