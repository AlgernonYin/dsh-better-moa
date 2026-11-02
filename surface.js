import { randomUUID } from 'node:crypto'
import { createAdvicePlacement, messageFingerprint } from './layout.js'

// End-of-turn QA reviews (form 'review') are ordinary turn context, never the replaceable advice node.
export const isAdviceNode = message => message?.role === 'user' && message.source?.kind === 'plugin:moa' && message.source.form !== 'review'
export const isRetiredAdvice = message => isAdviceNode(message) && message.source.form === 'retired'

/** Inspect the active surface, not every historical append in the event log. */
export function adviceSurfaceEntries(session) {
  if (!Array.isArray(session?.surface?.nodes) || typeof session.eventAt !== 'function') {
    throw new Error('[moa] advice replacement requires the Session surface API')
  }
  const entries = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (!event) continue
    const message = typeof session.deriveEventMessage === 'function'
      ? session.deriveEventMessage(event)
      : event.type === 'user/message' ? event.data : null
    if (isAdviceNode(message)) entries.push({ seq, message })
  }
  return entries
}

/**
 * Keep exactly one nonempty advice node in the live surface. The event log is
 * append-only: a replacement is itself a new event whose surfaceOp shadows one
 * old USER node. No span containing user work, assistant calls or tool results
 * is replaced. Legacy extra nodes become short retired nodes once; their count
 * is constant and their previous text is absent from compaction inputs.
 *
 * On a fresh surface the LOOP commits the first advice through its ordinary
 * pending-message path. Later advice is committed here with an explicit single
 * node replacement and removed from pending, avoiding a second LOOP append.
 */
export function replaceAdviceInSurface(session, decision) {
  if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
  const pending = decision.messages.filter(message => isAdviceNode(message) && !isRetiredAdvice(message))
  if (!pending.length) return decision
  const incoming = pending[pending.length - 1]
  const others = decision.messages.filter(message => !isAdviceNode(message))
  const entries = adviceSurfaceEntries(session)
  const previous = entries[entries.length - 1]?.message
  const unchanged = previous && !isRetiredAdvice(previous)
    && previous.source?.routeKey === incoming.source?.routeKey
    && previous.source?.preset === incoming.source?.preset
    && messageFingerprint(previous) === messageFingerprint(incoming)
  if (typeof session.deriveMessages !== 'function') throw new Error('[moa] advice placement requires Session.deriveMessages')
  const history = session.deriveMessages()
  const work = [...history]
  for (const message of others) {
    const committed = history.some(old => old === message || (typeof message.id === 'string'
      && old?.id === message.id && messageFingerprint(old) === messageFingerprint(message)))
    if (!committed) work.push(message)
  }
  const logicalPlacement = unchanged && [1, 2].includes(previous.source.logicalPlacement?.version)
    ? previous.source.logicalPlacement : createAdvicePlacement(work)
  const latest = { ...incoming, source: { ...incoming.source, logicalPlacement } }
  if (!entries.length) return { ...decision, messages: [...others, latest] }
  if (typeof session.append !== 'function') throw new Error('[moa] advice replacement requires Session.append')

  // Surface positions can be non-monotonic after a replacement. Never sort seqs.
  const anchor = entries[entries.length - 1]
  for (const entry of entries.slice(0, -1)) {
    if (isRetiredAdvice(entry.message)) continue
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: '[Superseded MoA advice]' }],
      source: { kind: 'plugin:moa', form: 'retired' },
    }, {
      surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq },
      sourceEventSeqs: [entry.seq],
    })
  }
  session.append('user/message', latest, {
    surfaceOp: { op: 'replace', startSeq: anchor.seq, endSeq: anchor.seq },
    sourceEventSeqs: [anchor.seq],
  })
  return { ...decision, messages: others }
}
