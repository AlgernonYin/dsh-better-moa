/**
 * Append-only advisor history for DSH Better MoA.
 *
 * The advisor transcript must not be rebuilt from the *active surface*: cut/compaction
 * replaces surface nodes, so `session.deriveMessages()` forgets the conversation that came
 * before the replacement. Instead this module contributes a host-only session projection
 * whose state folds the committed session log (the source of truth) once per event and
 * appends the collected messages forever.
 *
 * The projection stores the original event messages (user messages, assistant messages
 * including their real `tool-call` blocks, and real tool results), in log order. Replacing
 * the surface appends the replacement content, annotated with
 * `source.kind = 'context-replacement'`; it never deletes the older prefix and never looks
 * like a fresh user turn (`turnHash` does not move on compaction). Every stored message is
 * detached from the event object and gets an event-derived, stable id, so two messages that
 * share a `message.id` (an edited user message) both survive `buildAdvisorTranscript`'s
 * id de-duplication.
 *
 * Registration (host-only unit; no `wire`, so it never reaches client snapshots):
 *
 *   ctx.inject(['sessionProjections'], (ctx) => {
 *     ctx.effect(() => ctx.sessionProjections.register(createHistoryProjection()))
 *   })
 *
 * Read (never scans the log; the registry keeps the cell materialized):
 *
 *   const { messages, source } = readAdvisorHistory(ctx.get('sessionProjections'), session)
 *
 * @module dsh-better-moa/history
 */

import { z } from 'zod'

/** Key of the host-only history projection. */
export const HISTORY_PROJECTION_KEY = 'moa/advisor-history'

/** Bump together with the state shape; the registry discards stale checkpoint rows. */
const HISTORY_STATE_VERSION = 2

/** `source.kind` used for surface replacement content (cut / compaction / edit). */
const CONTEXT_REPLACEMENT_KIND = 'context-replacement'

/** Synthetic/ambient user messages that are not part of the collaborator's real history. */
const EXCLUDED_SOURCE_KINDS = new Set([
  'plugin:moa',
  'time-context',
  'runtime-context',
  'skill-catalog',
  'model-selection',
])

/** Event type -> role of the message it commits. Everything else is ignored. */
const MESSAGE_ROLES = new Map([
  ['user/message', 'user'],
  ['assistant/message', 'assistant'],
  ['tool/result', 'tool'],
])

const messageSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(['user', 'assistant', 'tool']),
    content: z.unknown(),
    source: z
      .object({ kind: z.string().optional() })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown())

const historyStateSchema = z.object({
  version: z.literal(HISTORY_STATE_VERSION),
  messages: z.array(messageSchema),
  lastEventSeq: z.number(),
})

/** @typedef {{ messages: any[], source: 'projection' | 'deriveMessages', reason?: string }} AdvisorHistory */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Detach a committed message from the log so later consumers can never mutate the event.
 * Messages are plain JSON by contract; the shallow fallback only exists so a pathological
 * value cannot make `apply` throw inside the session event drive.
 */
function detach(message) {
  try {
    return structuredClone(message)
  } catch {
    return { ...message }
  }
}

/** Stable, unique id derived from the log position (deterministic across fork/restore). */
function eventMessageId(event) {
  return `moa:${event.seq}:${event.type}`
}

/**
 * Copy one committed message into advisor history.
 *
 * A `surfaceOp: { op: 'replace' }` event is the *current content of the rewritten surface*.
 * It is appended, never treated as a new independent user task, and its source kind is
 * changed away from `'user'` so `buildAdvisorTranscript` does not treat it as a real user
 * turn when it computes `turnHash`.
 */
function toHistoryMessage(raw, source, event) {
  const annotated = { ...source }
  if (isRecord(event.surfaceOp) && event.surfaceOp.op === 'replace') {
    annotated.originalKind = source.kind ?? raw.role
    annotated.kind = CONTEXT_REPLACEMENT_KIND
    annotated.surfaceOp = 'replace'
    annotated.replacedFrom = event.surfaceOp.startSeq
    annotated.replacedTo = event.surfaceOp.endSeq
  }
  const message = detach(raw)
  message.advisorSourceId = annotated.kind === CONTEXT_REPLACEMENT_KIND ? eventMessageId(event) : raw.id ?? null
  message.id = eventMessageId(event)
  message.source = annotated
  return message
}

/**
 * Pure fold step. Returns the *same* state reference for every ignored event, so the
 * registry's change feed does not wake up on stream deltas, tool schemas, ambient context
 * or system events.
 *
 * @param {{ version: number, messages: any[], lastEventSeq: number }} state
 * @param {any} event committed session event
 */
function apply(state, event) {
  if (!isRecord(state) || !Array.isArray(state.messages)) return state
  if (!isRecord(event)) return state
  const role = MESSAGE_ROLES.get(event.type)
  if (role === undefined) return state
  const seq = event.seq
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return state
  if (seq <= state.lastEventSeq) return state // already folded (replay / restore overlap)
  const data = event.data
  if (!isRecord(data)) return state
  // `user/message` commits the message itself; assistant/tool events wrap it in `.message`.
  const raw = event.type === 'user/message' ? data : data.message
  if (!isRecord(raw) || raw.role !== role) return state
  const source = isRecord(raw.source) ? raw.source : {}
  if (EXCLUDED_SOURCE_KINDS.has(source.kind)) return state
  return {
    version: state.version,
    messages: [...state.messages, toHistoryMessage(raw, source, event)],
    lastEventSeq: seq,
  }
}

/**
 * Host-only projection definition: immutable append-only state, no client `wire` view.
 *
 * @returns {{
 *   key: string,
 *   stateSchema: import('zod').ZodType,
 *   init(header: unknown, inheritedEventCount: number): { version: number, messages: any[], lastEventSeq: number },
 *   apply(state: any, event: any): any,
 *   stateVersion: number,
 * }}
 */
export function createHistoryProjection() {
  return {
    key: HISTORY_PROJECTION_KEY,
    stateSchema: historyStateSchema,
    init() {
      // Fork-inherited events are folded by the registry through `apply` as well, so no
      // prefix seeding is needed here; keeping the parameter out of the state makes a
      // forked session's history identical to replaying the same events from scratch.
      return { version: HISTORY_STATE_VERSION, messages: [], lastEventSeq: -1 }
    },
    apply,
    stateVersion: HISTORY_STATE_VERSION,
  }
}

function derivedMessages(session) {
  try {
    const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
    return Array.isArray(messages) ? messages : []
  } catch {
    return []
  }
}

function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Read the advisor history for one session.
 *
 * Preferred path: the registered host projection's already-materialized state. No log scan,
 * no subscription, no recomputation. If the projection is unavailable (service missing,
 * plugin not registered yet, invalid state) this falls back to `session.deriveMessages()` —
 * the old active-surface behaviour — and reports that through `source`/`reason` so callers
 * can tell a complete history from a degraded one.
 *
 * The returned `messages` array is the live projection state; callers must treat it as
 * read-only.
 *
 * @param {{ stateOf(session: unknown, key: string): unknown } | undefined} projections `ctx.sessionProjections`
 * @param {{ deriveMessages?(): any[] } | undefined} session
 * @returns {AdvisorHistory}
 */
export function readAdvisorHistory(projections, session) {
  const fallback = (reason) => ({
    messages: derivedMessages(session),
    source: 'deriveMessages',
    reason,
  })
  if (!isRecord(projections) || typeof projections.stateOf !== 'function') {
    return fallback('sessionProjections-unavailable')
  }
  if (!isRecord(session)) return fallback('session-unavailable')
  let state
  try {
    state = projections.stateOf(session, HISTORY_PROJECTION_KEY)
  } catch (error) {
    return fallback(`stateOf-failed: ${errorText(error)}`)
  }
  if (state === undefined || state === null) return fallback('projection-not-registered')
  if (!isRecord(state) || !Array.isArray(state.messages)) return fallback('projection-state-invalid')
  return { messages: state.messages, source: 'projection' }
}