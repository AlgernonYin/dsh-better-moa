import { isRouteAdvice, selectAdviceForAggregator, sha256 } from './transcript.js'

const ownAdvice = message => message?.role === 'user' && message.source?.kind === 'plugin:moa' && message.source.form !== 'review'
const HEADER_POLICY = 'leading-host-system-v1'

/** Provider-independent identity; replay envelopes and route rewrites are not prompt content. */
export function messageFingerprint(message) {
  return sha256(JSON.stringify([message?.role, message?.content, message?.toolCallId ?? null]))
}

/** The Host may prepend its system message only after admitting the first step. */
export function workForPlacement(messages, version = 2) {
  const all = (messages || []).filter(message => !ownAdvice(message))
  let offset = 0
  if (version === 2) {
    while (all[offset]?.role === 'system' && all[offset].source?.kind === 'system-prompt') offset++
  }
  return { headers: all.slice(0, offset), work: all.slice(offset) }
}

/** Persist the exact work boundary at which a new opinion became available. */
export function createAdvicePlacement(messages) {
  const { work } = workForPlacement(messages)
  const hashes = work.map(messageFingerprint)
  const prefix = { version: 2, headerPolicy: HEADER_POLICY, workCount: work.length, prefixHash: sha256(JSON.stringify(hashes)) }
  if (!work.length) return { ...prefix, anchor: null }
  const last = work[work.length - 1]
  const hash = hashes[hashes.length - 1]
  return {
    ...prefix,
    anchor: {
      ...(typeof last.id === 'string' ? { id: last.id } : {}),
      hash,
      occurrence: hashes.reduce((count, candidate) => count + (candidate === hash ? 1 : 0), 0),
    },
  }
}

/**
 * One replaceable physical opinion; only its request view uses this recorded
 * boundary. Never move unchanged advice on every tool step. Edited/missing/cut
 * work falls back to canonical order. V1 retains its full-prefix validation;
 * V2 ignores only leading Host-owned system headers, never ordinary messages.
 */
export function layoutAdviceForAggregator(messages, preset, mode = 'latest') {
  const selected = selectAdviceForAggregator(messages, preset, mode)
  if (!Array.isArray(selected) || mode === 'all') return selected
  const opinion = selected.find(message => isRouteAdvice(message, preset))
  const placement = opinion?.source?.logicalPlacement
  if (!opinion || ![1, 2].includes(placement?.version)) return selected
  if (placement.version === 2 && placement.headerPolicy !== HEADER_POLICY) return selected
  const { headers, work } = workForPlacement(selected, placement.version)
  if (placement.anchor === null) return placement.workCount === 0 && placement.prefixHash === sha256('[]') ? [...headers, opinion, ...work] : selected
  const anchor = placement.anchor
  if (!anchor || typeof anchor.hash !== 'string' || !Number.isSafeInteger(anchor.occurrence) || anchor.occurrence < 1) return selected
  let index = -1
  if (typeof anchor.id === 'string') {
    index = work.findIndex(message => message?.id === anchor.id)
    if (index >= 0 && messageFingerprint(work[index]) !== anchor.hash) return selected
  }
  if (index < 0) {
    let occurrence = 0
    index = work.findIndex(message => messageFingerprint(message) === anchor.hash && ++occurrence === anchor.occurrence)
  }
  if (index < 0 || placement.workCount !== index + 1
    || placement.prefixHash !== sha256(JSON.stringify(work.slice(0, index + 1).map(messageFingerprint)))) return selected
  return [...headers, ...work.slice(0, index + 1), opinion, ...work.slice(index + 1)]
}
