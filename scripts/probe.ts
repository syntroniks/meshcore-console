// Read-only check of the protocol client against a real radio over USB.
//   pnpm probe [/dev/ttyACM0]
// Runs every query the console uses, plus 'get' CLI commands. Changes nothing on the radio.

import { ADV_TYPE_NAMES } from '../src/protocol/codes.ts'
import { MeshCoreClient, PUSH_NAMES } from '../src/protocol/client.ts'
import { parseRxLog } from '../src/protocol/messages.ts'
import { Push } from '../src/protocol/codes.ts'
import { findRadioPort, NodeSerialTransport } from './node-serial.ts'

const path = process.argv[2] ?? (await findRadioPort())
if (!path) {
  console.error('no radio found; pass the serial port path')
  process.exit(1)
}

const client = new MeshCoreClient(new NodeSerialTransport(path))
client.on('push', (f) => {
  if (f[0] === Push.LogRxData) {
    const e = parseRxLog(f)
    console.log(`  [rx] ${e.packet?.payloadName ?? '?'} via ${e.packet?.routeName ?? '?'} rssi ${e.rssi} snr ${e.snr}`)
  } else {
    console.log(`  [push] ${PUSH_NAMES[f[0]] ?? f[0]}`)
  }
})
client.on('unsolicited', (f) => console.log(`  [unsolicited] code ${f[0]}`))

const section = (title: string, value: unknown) => console.log(`\n${title}:`, value)

await client.connect()
try {
  const device = await client.deviceQuery()
  section('device', device)
  const self = await client.appStart()
  section('self', { ...self, advType: ADV_TYPE_NAMES[self.advType], publicKey: `${self.publicKey.slice(0, 16)}…` })
  section('battery & storage', await client.getBattAndStorage())
  const t = await client.getDeviceTime()
  section('device time', `${new Date(t * 1000).toISOString()} (drift ${t - Math.round(Date.now() / 1000)}s)`)
  section('core stats', await client.getCoreStats())
  section('radio stats', await client.getRadioStats())
  section('packet stats', await client.getPacketStats())
  const { total, contacts } = await client.getContacts()
  section(
    'contacts',
    `${contacts.length} of ${total}: ` +
      contacts.map((c) => `${c.name} (${ADV_TYPE_NAMES[c.type]}, ${c.outPath.known ? `${c.outPath.hops} hops` : 'flood'})`).join(', '),
  )
  const channels = await client.getChannels(device.maxChannels)
  section('channels', channels.map((c) => `#${c.index} ${c.name}`).join(', '))
  section('custom vars', await client.getCustomVars())
  section('tuning', await client.getTuningParams())
  section('auto-add', await client.getAutoaddConfig())
  section('default flood scope', await client.getDefaultFloodScope())
  const cli: Record<string, string | null> = {}
  for (const cmd of ['ver', 'board', 'get radio', 'get tx', 'get af', 'get rxdelay', 'get txdelay', 'get multi.acks', 'get radio.rxgain', 'get radio.fem.rxgain', 'no.such.command']) {
    cli[cmd] = await client.runCli(cmd)
  }
  section('cli', cli)
} finally {
  await client.disconnect()
}
