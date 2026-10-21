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
    expect(total).toBe(4)
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

describe('messages and writes against the mock radio', () => {
  it('drains the offline queue, then reports it empty', async () => {
    const client = new MeshCoreClient(new MockRadioTransport({ queuedMessages: 3 }))
    await client.connect()
    await client.deviceQuery()
    const got = []
    for (let m = await client.syncNextMessage(); m; m = await client.syncNextMessage()) got.push(m)
    expect(got).toHaveLength(3)
    expect(got.every((m) => m.text.length > 0)).toBe(true)
    expect(await client.syncNextMessage()).toBeNull()
    await client.disconnect()
  })

  it('returns the expected ACK for a DM, and the delivery push carries it', async () => {
    const client = new MeshCoreClient(new MockRadioTransport({ ackRate: 1, ackDelayMs: [50, 60] }))
    const acks: number[] = []
    client.on('push', (f) => f[0] === Push.SendConfirmed && acks.push(new DataView(f.buffer, f.byteOffset).getUint32(1, true)))
    await client.connect()
    const { contacts } = await client.getContacts()
    const sam = contacts.find((c) => c.name === 'Sam')!
    const sent = await client.sendText(sam.publicKey, 'hello')
    expect(sent.flood).toBe(true) // Sam has no known path
    expect(sent.expectedAck).not.toBe(0)
    await expect(client.sendText('ff'.repeat(32), 'nobody')).rejects.toMatchObject({ code: ErrCode.NotFound })
    await vi.waitFor(() => expect(acks).toContain(sent.expectedAck))
    await client.disconnect()
  })

  it('refuses to move the radio clock backwards', async () => {
    const client = new MeshCoreClient(new MockRadioTransport({ clockBehindSecs: -3600 })) // an hour ahead
    await client.connect()
    await expect(client.setDeviceTime()).rejects.toMatchObject({ code: ErrCode.IllegalArg })
    await client.disconnect()
  })

  it('moves a lagging clock forward', async () => {
    const client = new MeshCoreClient(new MockRadioTransport({ clockBehindSecs: 7200 }))
    await client.connect()
    expect(Date.now() / 1000 - (await client.getDeviceTime())).toBeGreaterThan(7000)
    await client.setDeviceTime()
    expect(Math.abs(Date.now() / 1000 - (await client.getDeviceTime()))).toBeLessThan(2)
    await client.disconnect()
  })

  it('writes radio params and reads them back', async () => {
    const client = new MeshCoreClient(new MockRadioTransport())
    await client.connect()
    await client.setRadioParams({ freqMHz: 869.618, bwKHz: 62.5, sf: 8, cr: 8 }, false)
    expect((await client.appStart()).radio).toEqual({ freqMHz: 869.618, bwKHz: 62.5, sf: 8, cr: 8 })
    await expect(client.setRadioParams({ freqMHz: 869.618, bwKHz: 62.5, sf: 13, cr: 8 }, false)).rejects.toMatchObject({ code: ErrCode.IllegalArg })
    await client.disconnect()
  })

  it('treats a CLI reply other than OK as a failed write', async () => {
    const client = new MeshCoreClient(new MockRadioTransport())
    await client.connect()
    expect(await client.runCliExpectOk('set txdelay 0.7')).toBe('OK')
    await expect(client.runCliExpectOk('set radio.fem.rxgain on')).rejects.toThrow('Error: unsupported')
    await client.disconnect()
  })
})
