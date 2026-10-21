# MeshCore Console

A browser console for MeshCore companion radios over USB: device status, settings, contacts, channels, a live log of
received packets, and a shell that runs commands on the radio's CLI.

It talks the MeshCore companion protocol over WebSerial, so it needs Chrome or Edge on desktop, and a radio running
companion firmware built for USB (for example `heltec_v4_companion_radio_usb`). The shell needs firmware v1.18 or newer
(protocol v14, `CMD_RUN_CLI_COMMAND`).

## Running it

```sh
pnpm install
pnpm dev          # http://localhost:5173, hot reload
```

Click **Connect USB** and pick the radio's serial port, or **Demo radio** to try it without hardware.

| Command | What it does |
| --- | --- |
| `pnpm dev` | dev server with hot reload |
| `pnpm build` | type-check and build into `dist/` |
| `pnpm test` | unit tests (Vitest) |
| `pnpm typecheck` / `pnpm lint` | TypeScript 7 / oxlint |
| `pnpm probe [port]` | run every query the console uses against a real radio from Node, read-only |

`pnpm probe` finds the radio by USB vendor id, or takes a port such as `/dev/ttyACM0`. It changes nothing on the radio.

## Shell

Anything typed goes to the radio's CLI as-is (`get tx`, `set name …`, `ver`, `reboot`). Commands starting with `/` run
in the console: `/help`, `/info`, `/stats`, `/contacts`, `/channels`, `/time`, `/rx on|off` (print received packets),
`/frames on|off` (hex dump of every frame). Tab completes, arrows walk history, and `poweroff` asks for confirmation.
The **edit** buttons on the Settings tab put the matching `set` command on the shell's prompt.

## Layout

```
src/protocol/      companion protocol, no UI or browser dependencies
  codes.ts         command, response and push codes (from firmware v1.18.0)
  framing.ts       '<'/'>' length-prefixed serial frames
  messages.ts      typed parsers and command builders, one per reply layout
  client.ts        request queue matching replies by code, push routing
  transports/      WebSerial, and a simulated radio for demo mode and tests
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
