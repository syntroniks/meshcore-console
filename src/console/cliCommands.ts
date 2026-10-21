// Commands the companion firmware's CLI accepts (v1.18.0: MyMesh::handleCommand,
// CommonRadioPrefs::handleCommand and board-specific handlers), for shell help and completion.

export interface CommandHelp {
  usage: string
  summary: string
}

export const DEVICE_COMMANDS: CommandHelp[] = [
  { usage: 'ver', summary: 'firmware version and build date' },
  { usage: 'board', summary: 'board name' },
  { usage: 'get name', summary: 'advert name' },
  { usage: 'set name <name>', summary: 'set the advert name' },
  { usage: 'get radio', summary: 'frequency, bandwidth, spreading factor, coding rate' },
  { usage: 'set radio <freq>,<bw>,<sf>,<cr>', summary: 'radio parameters (reboot to apply)' },
  { usage: 'get freq', summary: 'frequency in MHz' },
  { usage: 'get tx', summary: 'transmit power in dBm' },
  { usage: 'set tx <dBm>', summary: 'set transmit power' },
  { usage: 'get af', summary: 'airtime factor' },
  { usage: 'set af <0-9>', summary: 'set airtime factor' },
  { usage: 'get dutycycle', summary: 'transmit duty cycle limit' },
  { usage: 'set dutycycle <1-100>', summary: 'set duty cycle limit, in percent' },
  { usage: 'get rxdelay', summary: 'receive delay base' },
  { usage: 'set rxdelay <0-20>', summary: 'set receive delay base' },
  { usage: 'get txdelay', summary: 'flood retransmit delay factor' },
  { usage: 'set txdelay <0-2>', summary: 'set flood retransmit delay factor' },
  { usage: 'get direct.txdelay', summary: 'direct retransmit delay factor' },
  { usage: 'set direct.txdelay <0-2>', summary: 'set direct retransmit delay factor' },
  { usage: 'get agc.reset.interval', summary: 'AGC reset interval in seconds (0 = off)' },
  { usage: 'set agc.reset.interval <secs>', summary: 'set AGC reset interval (rounded to 4s)' },
  { usage: 'get int.thresh', summary: 'interference threshold above the noise floor (0 = off)' },
  { usage: 'set int.thresh <dB>', summary: 'set interference threshold' },
  { usage: 'get cad', summary: 'channel activity detection before transmitting' },
  { usage: 'set cad on|off', summary: 'turn channel activity detection on or off' },
  { usage: 'get multi.acks', summary: 'extra ACKs per message' },
  { usage: 'set multi.acks <0|1>', summary: 'set extra ACKs' },
  { usage: 'get path.hash.mode', summary: 'path hash size: 0, 1 or 2 means 1, 2 or 3 bytes per hop' },
  { usage: 'set path.hash.mode <0|1|2>', summary: 'set path hash size' },
  { usage: 'get radio.rxgain', summary: 'SX126x boosted receive gain' },
  { usage: 'set radio.rxgain on|off', summary: 'turn boosted receive gain on or off' },
  { usage: 'get radio.fem.rxgain', summary: 'external LNA, on boards that can switch it' },
  { usage: 'set radio.fem.rxgain on|off', summary: 'turn the external LNA on or off' },
  { usage: 'get tz.offset', summary: 'UTC offset for the on-screen clock' },
  { usage: 'set tz.offset <-12..14>', summary: 'set UTC offset' },
  { usage: 'set pin <6 digits>', summary: 'BLE pairing PIN (0 = random each boot)' },
  { usage: 'get wifi.ssid', summary: 'WiFi network (WiFi builds)' },
  { usage: 'set wifi.ssid <ssid>', summary: 'set WiFi network (WiFi builds, reboot to apply)' },
  { usage: 'set wifi.pwd <password>', summary: 'set WiFi password (WiFi builds)' },
  { usage: 'get wifi.status', summary: 'WiFi connection state (WiFi builds)' },
  { usage: 'get wifi.ip', summary: 'WiFi IP address (WiFi builds)' },
  { usage: 'reboot', summary: 'restart the radio (no reply)' },
  { usage: 'poweroff', summary: 'power the radio off; wake it with its button' },
]

export const LOCAL_COMMANDS: CommandHelp[] = [
  { usage: '/help', summary: 'this list' },
  { usage: '/clear', summary: 'clear the terminal' },
  { usage: '/info', summary: 'device and node summary' },
  { usage: '/stats', summary: 'battery, uptime, radio and packet counters' },
  { usage: '/contacts', summary: 'list contacts' },
  { usage: '/channels', summary: 'list channels' },
  { usage: '/time', summary: "radio clock and its drift from this computer's clock" },
  { usage: '/rx on|off', summary: 'print received packets as they arrive' },
  { usage: '/frames on|off', summary: 'print every frame to and from the radio, in hex' },
]

/** The literal part of a usage string: 'set tx <dBm>' -> 'set tx ', 'set cad on|off' -> 'set cad '. */
export function literalPrefix(usage: string): string {
  const words = usage.split(' ')
  const out: string[] = []
  for (const w of words) {
    if (w.startsWith('<') || w.includes('|')) return out.join(' ') + ' '
    out.push(w)
  }
  return out.join(' ')
}

const COMPLETIONS = [...new Set([...DEVICE_COMMANDS, ...LOCAL_COMMANDS].map((c) => literalPrefix(c.usage)))]

export function completeCommand(line: string): string[] {
  return COMPLETIONS.filter((c) => c.startsWith(line) && c !== line)
}

/** Commands that need a second Enter, because undoing them needs someone at the radio. */
export const CONFIRM_COMMANDS = new Set(['poweroff', 'shutdown'])
