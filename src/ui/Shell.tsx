import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { CONFIRM_COMMANDS, completeCommand, DEVICE_COMMANDS, LOCAL_COMMANDS } from '../console/cliCommands.ts'
import { LineEditor } from '../console/lineEditor.ts'
import { toHex } from '../protocol/bytes.ts'
import { ADV_TYPE_NAMES, Push } from '../protocol/codes.ts'
import { PUSH_NAMES, type MeshCoreClient } from '../protocol/client.ts'
import { parseRxLog } from '../protocol/messages.ts'
import { ago, batteryPercent, duration } from './format.ts'

export interface ShellHandle {
  /** Put text on the prompt line (eg. a 'set' command to edit) and focus the shell. */
  prefill(text: string): void
}

const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  err: (s: string) => `\x1b[31m${s}\x1b[0m`,
  accent: (s: string) => `\x1b[36m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
}

const PROMPT_IDLE = C.dim('offline') + ' $ '

interface Props {
  client: MeshCoreClient | null
  nodeName?: string
  ref?: Ref<ShellHandle>
}

export function Shell({ client, nodeName, ref }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const editorRef = useRef<LineEditor | null>(null)
  const clientRef = useRef<MeshCoreClient | null>(client)
  const flags = useRef({ rx: false, frames: false, busy: false, confirm: '' })

  useImperativeHandle(ref, () => ({
    prefill(text: string) {
      editorRef.current?.setLine(text)
      termRef.current?.focus()
    },
  }))

  // terminal + line editor, created once
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      theme: { background: '#0b0e12', foreground: '#d6dde6', cursor: '#4fb3a9' },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    fit.fit()
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(host.current!)

    const editor = new LineEditor({
      prompt: PROMPT_IDLE,
      write: (s) => term.write(s),
      complete: completeCommand,
      onSubmit: (line) => void runLine(line),
    })
    termRef.current = term
    editorRef.current = editor
    term.onData((d) => {
      if (!flags.current.busy) editor.handleInput(d)
    })
    term.writeln(C.accent('MeshCore Console') + C.dim(' — /help for commands, Tab completes'))
    editor.showPrompt()

    async function runLine(raw: string) {
      const line = raw.trim()
      const out = (s: string) => editor.print(s)
      if (!line) return editor.showPrompt()
      flags.current.busy = true
      try {
        if (line.startsWith('/') || line === 'help' || line === 'clear') await local(line, out, term)
        else await device(line, out)
      } catch (err) {
        out(C.err(err instanceof Error ? err.message : String(err)))
      } finally {
        flags.current.busy = false
        editor.showPrompt()
      }
    }

    async function device(line: string, out: (s: string) => void) {
      const c = clientRef.current
      if (!c?.isOpen) return out(C.err('not connected (connect a radio, or try the demo)'))
      if (CONFIRM_COMMANDS.has(line) && flags.current.confirm !== line) {
        flags.current.confirm = line
        return out(C.warn(`'${line}' turns the radio off until someone presses its button. Enter it again to confirm.`))
      }
      flags.current.confirm = ''
      const reply = await c.runCli(line)
      if (reply === null) out(C.dim('(no reply)'))
      else if (/^(Error|ERROR)|^Unknown command/.test(reply)) out(C.err(reply))
      else out(reply.startsWith('OK') ? C.ok(reply) : reply)
    }

    async function local(line: string, out: (s: string) => void, t: Terminal) {
      const [cmd, arg] = line.replace(/^\//, '').split(/\s+/, 2)
      const c = clientRef.current
      const needClient = () => {
        if (!c?.isOpen) throw new Error('not connected')
        return c
      }
      switch (cmd) {
        case 'help': {
          const pad = (s: string) => s.padEnd(34)
          out(C.accent('Console commands'))
          for (const h of LOCAL_COMMANDS) out(`  ${pad(h.usage)}${C.dim(h.summary)}`)
          out(C.accent('Radio commands') + C.dim(' (sent to the radio as typed)'))
          for (const h of DEVICE_COMMANDS) out(`  ${pad(h.usage)}${C.dim(h.summary)}`)
          return
        }
        case 'clear':
          t.clear()
          return
        case 'info': {
          const cl = needClient()
          const d = await cl.deviceQuery()
          const s = await cl.appStart()
          out(`${C.accent(s.name)}  ${ADV_TYPE_NAMES[s.advType]}  ${C.dim(s.publicKey)}`)
          out(`firmware ${d.firmwareVersion} (${d.buildDate}), protocol v${d.protocolVersion}, board ${d.manufacturer}`)
          out(`radio ${s.radio.freqMHz} MHz / ${s.radio.bwKHz} kHz / SF${s.radio.sf} / CR${s.radio.cr}, tx ${s.txPowerDbm} dBm (max ${s.maxTxPowerDbm})`)
          return
        }
        case 'stats': {
          const cl = needClient()
          const core = await cl.getCoreStats()
          const r = await cl.getRadioStats()
          const p = await cl.getPacketStats()
          out(`battery ${core.batteryMv} mV (~${batteryPercent(core.batteryMv)}%), uptime ${duration(core.uptimeSecs)}, tx queue ${core.queueLen}`)
          out(`noise floor ${r.noiseFloorDbm} dBm, last rssi ${r.lastRssiDbm} dBm, last snr ${r.lastSnrDb} dB, airtime tx ${r.txAirSecs}s rx ${r.rxAirSecs}s`)
          out(`packets: ${p.received} received (${p.receivedFlood} flood, ${p.receivedDirect} direct, ${p.receiveErrors} errors), ${p.sent} sent (${p.sentFlood} flood, ${p.sentDirect} direct)`)
          return
        }
        case 'contacts': {
          const { total, contacts } = await needClient().getContacts()
          out(C.dim(`${total} contacts`))
          for (const ct of contacts) {
            const path = ct.outPath.known ? `${ct.outPath.hops} hop${ct.outPath.hops === 1 ? '' : 's'}` : 'flood'
            out(`  ${ct.name.padEnd(28)} ${ADV_TYPE_NAMES[ct.type].padEnd(12)} ${path.padEnd(8)} ${C.dim(`advert ${ago(ct.lastAdvert)}`)}`)
          }
          return
        }
        case 'channels': {
          const cl = needClient()
          const d = await cl.deviceQuery()
          for (const ch of await cl.getChannels(d.maxChannels)) out(`  #${ch.index} ${ch.name}`)
          return
        }
        case 'time': {
          const t0 = await needClient().getDeviceTime()
          const drift = t0 - Math.round(Date.now() / 1000)
          out(`radio clock ${new Date(t0 * 1000).toISOString()}  ${drift === 0 ? C.ok('in sync') : C.warn(`${drift > 0 ? '+' : ''}${drift}s vs this computer`)}`)
          return
        }
        case 'synctime': {
          const cl = needClient()
          const before = (await cl.getDeviceTime()) - Math.round(Date.now() / 1000)
          await cl.setDeviceTime()
          out(C.ok(`radio clock set from this computer (was ${before > 0 ? '+' : ''}${before}s)`))
          return
        }
        case 'rx':
        case 'frames': {
          const on = arg === undefined ? !flags.current[cmd] : arg === 'on'
          flags.current[cmd] = on
          out(`${cmd} ${on ? C.ok('on') : 'off'}`)
          return
        }
        default:
          out(C.err(`unknown console command '/${cmd}' (try /help)`))
      }
    }

    return () => {
      observer.disconnect()
      term.dispose()
      termRef.current = null
      editorRef.current = null
    }
  }, [])

  // prompt shows the connected node
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.prompt = client ? `${C.accent(nodeName ?? 'radio')} $ ` : PROMPT_IDLE
    if (!flags.current.busy) editor.showPrompt()
  }, [client, nodeName])

  // radio events print above the prompt
  useEffect(() => {
    clientRef.current = client
    const editor = editorRef.current
    if (!editor || !client) return
    editor.print(C.dim(`connected to ${client.label}`))
    const offs = [
      client.on('push', (f) => {
        if (f[0] === Push.LogRxData) {
          if (!flags.current.rx) return
          const e = parseRxLog(f)
          const p = e.packet
          editor.print(C.dim(`[rx] ${p ? `${p.payloadName} via ${p.routeName}, ${p.hops} hops, ${p.payloadLength}B` : 'unparsed'}  rssi ${e.rssi} snr ${e.snr}`))
        } else if (f[0] === Push.MsgWaiting) {
          editor.print(C.dim('[radio] new message, synced to the Messages tab'))
        } else if (f[0] === Push.SendConfirmed) {
          editor.print(C.dim('[radio] message delivered (ACK)'))
        } else {
          editor.print(C.dim(`[radio] ${PUSH_NAMES[f[0]] ?? `push 0x${f[0].toString(16)}`}`))
        }
      }),
      client.on('frameIn', (f) => flags.current.frames && editor.print(C.dim(`<- ${toHex(f, ' ')}`))),
      client.on('frameOut', (f) => flags.current.frames && editor.print(C.dim(`-> ${toHex(f, ' ')}`))),
      client.on('close', (err) => editor.print(err ? C.err(`disconnected: ${err.message}`) : C.dim('disconnected'))),
    ]
    return () => offs.forEach((off) => off())
  }, [client])

  return <div className="shell" ref={host} />
}
