import { useMemo, useRef } from 'react'
import type { ChannelKey } from '../protocol/crypto.ts'
import { analyzePacket, type AnalyzeContext, type KnownNode, type PacketAnalysis } from '../protocol/packets.ts'
import type { RadioState, RxEvent } from './useRadio.ts'

export interface AnalyzedPacket {
  e: RxEvent
  a: PacketAnalysis
  /** copies of this packet in the log: the same packet hash, heard through different repeaters */
  heard: number
}

/** The RX log, decoded with every key the console has. Each packet is decoded once per set of keys and contacts. */
export function useAnalyzedPackets(state: RadioState, keys: ChannelKey[]): AnalyzedPacket[] {
  const selfKey = state.self?.publicKey
  const selfName = state.self?.name
  const nodes = useMemo(() => {
    const out: KnownNode[] = (state.contacts ?? []).map((c) => ({ publicKey: c.publicKey, name: c.name }))
    if (selfKey) out.push({ publicKey: selfKey, name: `${selfName ?? 'this radio'} (you)` })
    return out
  }, [state.contacts, selfKey, selfName])
  const ctx = useMemo<AnalyzeContext>(() => ({ keys, nodes, selfKey }), [keys, nodes, selfKey])
  const cache = useRef(new WeakMap<RxEvent, { ctx: AnalyzeContext; a: PacketAnalysis }>())

  return useMemo(() => {
    const analyses = state.rx.map((e) => {
      let hit = cache.current.get(e)
      if (hit?.ctx !== ctx) {
        hit = { ctx, a: analyzePacket(e.raw, ctx) }
        cache.current.set(e, hit)
      }
      return hit.a
    })
    const copies = new Map<string, number>()
    for (const a of analyses) if (a.hash) copies.set(a.hash, (copies.get(a.hash) ?? 0) + 1)
    return state.rx.map((e, i) => {
      const a = analyses[i]
      return { e, a, heard: a.hash ? (copies.get(a.hash) ?? 1) : 1 }
    })
  }, [state.rx, ctx])
}
