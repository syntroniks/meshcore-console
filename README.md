# MeshCore Console

A browser console for MeshCore companion radios over USB or Bluetooth: messages (channels and direct), device status, editable
settings, contacts, channel management, a packet analyzer that decodes and decrypts what the radio hears, and a shell that runs
commands on the radio's CLI.

It talks the MeshCore companion protocol over WebSerial or Web Bluetooth, so it needs Chrome or Edge, and a radio
running companion firmware built for USB or BLE (for example `heltec_v4_companion_radio_usb` or
`heltec_v4_companion_radio_ble`). The shell needs firmware v1.18 or newer (protocol v14, `CMD_RUN_CLI_COMMAND`).

## Running it

The latest `main` is published at <https://syntroniks.github.io/meshcore-console/>. To run it locally:

```sh
pnpm install
pnpm dev          # http://localhost:5173, hot reload
```

Click **Connect USB** and pick the radio's serial port, **Connect Bluetooth** and pick the radio, or **Demo radio** to
try it without hardware.

| Command | What it does |
| --- | --- |
| `pnpm dev` | dev server with hot reload |
| `pnpm build` | type-check and build into `dist/` |
| `pnpm test` | unit tests (Vitest) |
| `pnpm typecheck` / `pnpm lint` | TypeScript 7 / oxlint |
| `pnpm probe [port]` | run every query the console uses against a real radio from Node, read-only |
| `pnpm probe [port] --write-same` | also write every setting back with the value it already has, then compare |

`pnpm probe` finds the radio by USB vendor id, or takes a port such as `/dev/ttyACM0`. The read-only run changes
nothing; `--write-same` exercises every write command without changing a setting (the clock moves forward 1 s). It
never syncs messages, since that takes them off the radio. Only one program can hold the serial port, so disconnect the
browser first.

## Bluetooth

BLE firmware serves the Nordic UART service: the console writes each frame to one characteristic and the radio notifies
each reply on the other, with no serial framing. Both need an encrypted, authenticated link, so the first connection
pairs with the radio's 6-digit PIN: the one on its screen (a new random PIN each boot), or 123456 on a radio without
one, unless a fixed PIN is set under Settings. The console pairs before sending its first command, so the PIN prompt
can't run into a request timeout. After that the computer remembers the radio.

- **Windows**: Chrome asks for the PIN itself. **macOS** and **Android** ask in a system dialog.
- **Linux**: Chrome needs `chrome://flags/#enable-web-bluetooth`, and it can't enter a passkey (Chromium answers BlueZ's
  passkey request with a cancel). Pair the radio once in the system's Bluetooth settings, or with `bluetoothctl`
  (`scan on`, `pair <address>`, then `disconnect <address>` so it advertises again), then connect from the console.
- The radio takes one Bluetooth connection at a time and stops advertising while it has one, so disconnect the
  MeshCore phone app first.
- If the link drops, **Reconnect** connects to the same radio again without the chooser.
- If the radio was erased or reflashed, the computer's stored pairing no longer matches: remove the radio from the
  system's Bluetooth devices and pair again.

## Messages

The radio keeps messages that arrive while no app is connected, and hands each one over once with
`CMD_SYNC_NEXT_MESSAGE`. The console syncs on connect and whenever the radio pushes `PUSH_CODE_MSG_WAITING`, and saves
every message in this browser's localStorage (per node) before doing anything else, so a reload can't lose one.

Direct messages show their delivery state: sending, sent (direct or by flood), delivered with the round-trip time once
the ACK arrives (`PUSH_CODE_SEND_CONFIRMED`), or "no ACK" after the radio's estimated timeout plus some slack, with a
retry that reuses the original timestamp so the recipient can drop duplicates. Channel posts have no delivery
confirmation. The composer counts UTF-8 bytes against the firmware's 160-byte limit; channel posts are sent as
`<your name>: <text>`, so the name counts too.

## Settings and clock

Settings are written with the protocol's own commands (`CMD_SET_*`); a few that only exist in the CLI (duty cycle,
delays, AGC, CAD, gain) go through `set …` on the CLI and must answer `OK`. After each write the console reads the
settings back, so the page shows what the radio stored. Frames that carry several settings (radio params, the
"other params" frame, tuning, auto-add) are sent with the current values for the fields not being edited; radio params
also always carry the client-repeat flag, because the firmware turns repeating off when it's missing.

**sync clock** (Overview, a banner when the radio is over a minute behind, or `/synctime` in the shell) sets the radio's
clock from the computer. The firmware only moves its clock forward, so a clock that runs ahead can't be pulled back.

## Channels

The Channels tab lists the radio's slots (40 on current firmware) and adds, renames and removes channels with
`CMD_SET_CHANNEL`. The radio saves every write to flash. Four ways to add one:

- **Hashtag**: the key is the first 16 bytes of SHA-256 of the name, so anyone who knows the name can read it.
- **New private**: a random key, with a `meshcore://channel/add?name=…&secret=…` link to share (the format the MeshCore
  app and its QR codes use).
- **From a link or key**: a `meshcore://` link, or a key as 32 hex characters or base64.
- **Public**: the well-known key every radio ships with.

Names are at most 31 bytes, and the firmware only takes 16-byte keys. **share** on any row copies its link. Messages files
channel posts by slot number, so a new channel goes in a free slot with no stored messages when there is one. In the
Packets tab, a channel the console can read but the radio can't has an **add to radio** button.

## Packets

The radio pushes every packet it hears (`PUSH_CODE_LOG_RX_DATA`) before it parses or decrypts it, so the Packets tab
sees all traffic in range: posts on channels the radio has no key for, and packets it will drop. Click a row to see the
packet field by field, with its bytes coloured to match.

- **Channel posts** are decrypted with every key the console has: the radio's channel slots, the well-known Public key,
  and hashtag names typed in under **Channels heard** (a hashtag channel's key is the first 16 bytes of SHA-256 of its
  name, `#` included; names are kept in localStorage). Channels heard lists each channel hash with its post count, and
  says whether the radio itself delivers those posts to Messages. The firmware skips a slot that has a key but no name,
  and a key only the console knows is console-only.
- **Adverts** have their Ed25519 signatures checked, as the firmware does before it accepts one.
- **Repeats**: copies of one packet heard through different repeaters share a packet hash. **Heard** counts them, and
  **hide repeats** keeps one row per packet.
- **Malformed packets** say what the firmware does with them.
- Direct messages, requests and responses stay encrypted. Opening them needs the pair's shared secret, and so a private
  key.

The radio only pushes packets that fit its 176-byte frame after a 3-byte header, so packets over 173 bytes never reach
the console. The crypto follows `src/Utils.cpp`: AES-128-ECB with zero padding, then a 2-byte truncated HMAC-SHA256.
`test/packets.test.ts` checks it, the packet hash, framing, advert app data and signatures against vectors generated
from the v1.18.0 C++ (taken from [meshcore-go](https://github.com/meshrunner-dev/meshcore-go), MIT).

## Shell

Anything typed goes to the radio's CLI as-is (`get tx`, `set name …`, `ver`, `reboot`). Commands starting with `/` run
in the console: `/help`, `/info`, `/stats`, `/contacts`, `/channels`, `/time`, `/rx on|off` (print received packets),
`/frames on|off` (hex dump of every frame), `/synctime`. Tab completes, arrows walk history, and `poweroff` asks for
confirmation.

## Layout

```
src/protocol/      companion protocol, no UI or browser dependencies
  codes.ts         command, response and push codes (from firmware v1.18.0)
  framing.ts       '<'/'>' length-prefixed serial frames
  messages.ts      typed parsers and command builders, one per reply layout
  packets.ts       over-the-air packets decoded field by field, for the analyzer
  crypto.ts        channel keys and hashes, AES-128-ECB + truncated HMAC
  channels.ts      meshcore:// channel links, shared keys in hex or base64
  client.ts        request queue matching replies by code, push routing
  transports/      WebSerial, Web Bluetooth, and a simulated radio for demo mode and tests
src/console/       shell line editing and the CLI command catalog
src/ui/            React views, the connection hook, and the xterm shell
scripts/           Node tools (node-serialport transport, probe)
test/              Vitest
```

The protocol has no request ids: the radio answers commands in order with codes below `0x80` and pushes events with
codes `0x80` and up. `MeshCoreClient` runs one request at a time and gives each a matcher for the reply codes it
expects, so a late or stray reply is reported as unsolicited rather than taken as the answer to the next request.

Frame layouts follow `examples/companion_radio/MyMesh.cpp` in the
[MeshCore firmware](https://github.com/meshcore-dev/MeshCore) at v1.18.0. When the firmware changes a layout, update
`messages.ts`, the simulated radio in `transports/mock.ts`, and `test/messages.test.ts` together.
