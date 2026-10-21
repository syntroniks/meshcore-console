export function duration(secs: number): string {
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${Math.floor(secs % 60)}s`
  return `${Math.floor(secs)}s`
}

export function ago(unixSecs: number, nowSecs = Date.now() / 1000): string {
  if (!unixSecs) return 'never'
  const diff = nowSecs - unixSecs
  if (diff < -60) return `in ${duration(-diff)} (clock ahead)`
  if (diff < 60) return 'just now'
  return `${duration(diff)} ago`
}

/** Rough single-cell LiPo state of charge from resting voltage. */
export function batteryPercent(mv: number): number {
  const curve: [number, number][] = [
    [4200, 100], [4100, 90], [4000, 78], [3900, 64], [3800, 48], [3700, 30], [3600, 15], [3500, 7], [3400, 3], [3300, 0],
  ]
  if (mv >= curve[0][0]) return 100
  for (let i = 1; i < curve.length; i++) {
    const [v1, p1] = curve[i - 1]
    const [v0, p0] = curve[i]
    if (mv >= v0) return Math.round(p0 + ((mv - v0) / (v1 - v0)) * (p1 - p0))
  }
  return 0
}

export function coords(lat: number, lon: number): string {
  if (!lat && !lon) return 'not set'
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`
}

export function shortKey(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`
}

/** CLI 'get' reply "> value" -> value; errors and missing commands stay readable. */
export function cliValue(reply: string | null | undefined): { text: string; ok: boolean } {
  if (reply === undefined) return { text: '…', ok: false }
  if (reply === null) return { text: 'no reply', ok: false }
  if (reply.startsWith('> ')) return { text: reply.slice(2), ok: true }
  if (reply === 'Unknown command') return { text: 'not in this firmware', ok: false }
  if (reply.startsWith('Error: ')) return { text: reply.slice(7), ok: false }
  return { text: reply, ok: true }
}

export function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false })
}
