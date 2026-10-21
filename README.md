# MeshCore Console

A browser console for MeshCore companion radios over USB: messages (channels and direct), device status, editable
settings, contacts, channels, a live log of received packets, and a shell that runs commands on the radio's CLI.

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
| `pnpm probe [port] --write-same` | also write every setting back with the value it already has, then compare |

`pnpm probe` finds the radio by USB vendor id, or takes a port such as `/dev/ttyACM0`. The read-only run changes
nothing; `--write-same` exercises every write command without changing a setting (the clock moves forward 1 s). It
never syncs messages, since that takes them off the radio. Only one program can hold the serial port, so disconnect the
browser first.

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
