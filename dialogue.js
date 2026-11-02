import { createHash, randomUUID } from 'node:crypto'
import { wireTokens } from './budget.js'

export const DIALOGUE_VERSION = 4
export const DIALOGUE_VIEW = 'digest-v3-seeded'
export const SETUP_USER = '[Advisor session setup] This is a persistent advisory dialogue. Future user messages quote the separate acting agent. Give analysis only, citing source ids.'
export const SETUP_ASSISTANT = '[Advisor session acknowledgement] I will provide advisory analysis of the separate acting agent transcript.'
export const QUOTED = '[Quoted transcript of the separate acting agent]\n'
export const NEW_DELTA = '[New acting agent transcript since your previous advice]\n'
export const SUFFIX = '\n\nGive concise advice to the acting agent about its current task. Do not act as the agent or claim tool execution.'

const DAY_MS = 24 * 60 * 60 * 1000
const CHECKPOINT_FIELDS = ['version', 'view', 'system', 'source', 'reply', 'wire', 'ts']

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function validWindowStart(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validContent(content) {
  return typeof content === 'string' || (Array.isArray(content) && content.every(block =>
    isObject(block) && ['text', 'reasoning'].includes(block.type) && typeof block.text === 'string'
  ))
}

function validWire(wire) {
  return Array.isArray(wire) && wire.every(message =>
    isObject(message)
    && (message.role === 'user' || message.role === 'assistant')
    && validContent(message.content)
  )
}

export function dialogueIdentity(input) {
  return createHash('sha256').update(JSON.stringify([
    'moa-dialogue-v4', input.sessionId, input.provider, input.model,
    input.dialogueKey ?? 'default', input.slotId ?? 'default', input.cacheScope ?? '',
  ])).digest('hex')
}

// One slot can carry several request semantics (acting-agent advice and the
// end-of-turn QA review both quote the same transcript). Every semantics owns an
// append-only thread, so a reply produced for one request is never replayed as the
// answer to another, even when both snapshot the exact same source.
export function dialogueThreadKey(kind, suffix) {
  return createHash('sha256').update(JSON.stringify([
    'moa-dialogue-thread-v4', requestKind(kind), typeof suffix === 'string' && suffix ? suffix : SUFFIX,
  ])).digest('hex')
}

function requestKind(value) {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return kind || 'advice'
}

function lastUserText(wire) {
  const last = Array.isArray(wire) ? wire[wire.length - 1] : null
  if (!last || last.role !== 'user') return ''
  if (typeof last.content === 'string') return last.content
  return Array.isArray(last.content)
    ? last.content.filter(block => block.type === 'text').map(block => block.text).join('')
    : ''
}

// 0.6.x kept one flat checkpoint per slot. It can only be reused as advice: a review
// record's newest user turn carries the review suffix, not SUFFIX, so it is dropped.
function legacyThreads(checkpoint) {
  if (!lastUserText(checkpoint.wire).endsWith(SUFFIX)) return {}
  return { [dialogueThreadKey('advice', SUFFIX)]: { ...checkpoint, request: { kind: 'advice', suffix: SUFFIX } } }
}

function parseCheckpoint(record) {
  const present = CHECKPOINT_FIELDS.some(field => hasOwn(record, field))
  if (!present) return { present: false, checkpoint: null }
  const valid = Number.isFinite(record.version)
    && typeof record.view === 'string'
    && typeof record.system === 'string'
    && typeof record.source === 'string'
    && typeof record.reply === 'string'
    && validWire(record.wire)
    && Number.isFinite(record.ts)
    && (!hasOwn(record, 'replyContent') || validContent(record.replyContent))
    && (!hasOwn(record, 'replySource') || isObject(record.replySource))
    && (!hasOwn(record, 'request') || (isObject(record.request)
      && typeof record.request.kind === 'string' && typeof record.request.suffix === 'string'))
    // A cut is kept on the checkpoint of the thread that suffered it, so another
    // thread's failure or completion cannot erase it.
    && (!hasOwn(record, 'cut') || (isObject(record.cut)
      && typeof record.cut.reason === 'string' && Number.isFinite(record.cut.ts)))
  if (!valid) return { present: true, checkpoint: null }
  const checkpoint = {}
  for (const field of [...CHECKPOINT_FIELDS, 'replyContent', 'replySource', 'transportEpoch', 'request', 'cut']) {
    if (hasOwn(record, field)) checkpoint[field] = clone(record[field])
  }
  // An invalid or missing windowStart is dropped (not fatal): the next rebuild
  // then cannot prove "no cut" and rotates the transport epoch, as in 0.8.0.
  if (validWindowStart(record.windowStart)) checkpoint.windowStart = record.windowStart
  return { present: true, checkpoint }
}

function parseAttempt(record) {
  if (!hasOwn(record, 'last_attempt')) return { present: false, attempt: null }
  const attempt = record.last_attempt
  const valid = isObject(attempt)
    && typeof attempt.source === 'string'
    && typeof attempt.reason === 'string'
    && Number.isFinite(attempt.ts)
  return {
    present: true,
    attempt: valid
      ? {
        source: attempt.source, reason: attempt.reason, ts: attempt.ts,
        ...(typeof attempt.thread === 'string' ? { thread: attempt.thread } : {}),
      }
      : null,
  }
}

function parseThreads(record) {
  if (!hasOwn(record, 'threads')) return { present: false, threads: {} }
  if (!isObject(record.threads)) return { present: true, threads: null }
  const threads = {}
  for (const [key, value] of Object.entries(record.threads)) {
    const request = isObject(value) && isObject(value.request) ? value.request : null
    if (!request || dialogueThreadKey(request.kind, request.suffix) !== key) return { present: true, threads: null }
    const parsed = parseCheckpoint(value)
    if (!parsed.present || !parsed.checkpoint) return { present: true, threads: null }
    threads[key] = parsed.checkpoint
  }
  return { present: true, threads }
}

function parseState(record, now, ttlMs) {
  if (!isObject(record)) return null
  const parsedThreads = parseThreads(record)
  const parsedAttempt = parseAttempt(record)
  if (parsedThreads.threads === null || (parsedAttempt.present && !parsedAttempt.attempt)) return null
  let threads = parsedThreads.threads
  if (!parsedThreads.present) {
    const parsedCheckpoint = parseCheckpoint(record)
    if (parsedCheckpoint.present && !parsedCheckpoint.checkpoint) return null
    threads = parsedCheckpoint.checkpoint ? legacyThreads(parsedCheckpoint.checkpoint) : {}
  }
  const kept = {}
  for (const [key, checkpoint] of Object.entries(threads)) {
    if (now - checkpoint.ts <= ttlMs) kept[key] = checkpoint
  }
  const attempt = parsedAttempt.attempt && now - parsedAttempt.attempt.ts <= ttlMs ? parsedAttempt.attempt : null
  if (!Object.keys(kept).length && !attempt) return null
  return {
    threads: kept,
    lastAttempt: attempt,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
  }
}

function persistedState(state) {
  const record = Object.keys(state.threads).length ? { threads: clone(state.threads) } : {}
  if (state.lastAttempt) record.last_attempt = clone(state.lastAttempt)
  if (state.sessionId) record.sessionId = state.sessionId
  return record
}

export function createDialogueStore(options = {}) {
  const kv = options.kv
  const ttlMs = options.ttlMs ?? 7 * DAY_MS
  const now = options.now ?? Date.now
  const states = new Map()
  const queues = new Map()
  const sessionEpochs = new Map()
  let epoch = 0
  let closed = false
  let closePromise = null

  function scaffold(source, suffix = SUFFIX) {
    // Claude TUI wraps the newest user turn with external system instructions,
    // but writes earlier turns as raw history when rebuilding. Seed the large
    // transcript before the acknowledgement on the first call, so it never
    // moves from the wrapped live tail to a different raw-history prefix.
    return [
      { role: 'user', content: SETUP_USER + '\n\n' + QUOTED + source },
      { role: 'assistant', content: SETUP_ASSISTANT },
      { role: 'user', content: suffix },
    ]
  }

  function enqueue(key, operation) {
    const previous = queues.get(key) ?? Promise.resolve()
    const run = previous.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    queues.set(key, tail)
    return run.finally(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
  }

  return {
    async load() {
      states.clear()
      if (!kv) return
      const data = await kv.loadAll()
      const table = isObject(data?.tables?.dialogue) ? data.tables.dialogue : {}
      const stale = []
      for (const [key, record] of Object.entries(table)) {
        const state = parseState(record, now(), ttlMs)
        if (state) states.set(key, state)
        else stale.push(key)
      }
      for (const key of stale) await kv.deleteRecord('dialogue', key)
    },

    prepare(input) {
      const { sessionId, provider, model, source, system } = input
      // A per-call request (e.g. the end-of-turn review) changes the newest user turn
      // and the request semantics. Each semantics owns its own thread, so a review
      // reply can never be replayed as advice (or the other way round).
      const suffix = typeof input.suffix === 'string' && input.suffix ? input.suffix : SUFFIX
      const kind = requestKind(input.kind)
      const thread = dialogueThreadKey(kind, suffix)
      const request = { kind, suffix }
      const key = dialogueIdentity(input)
      const route = `${provider}/${model}`.toLowerCase()
      const persistentTags = (options.persistentTags ?? ['*'])
        .map(tag => String(tag).trim().toLowerCase()).filter(Boolean)
      const persistent = input.persistent === undefined
        ? persistentTags.some(tag => tag === '*' || route.includes(tag))
        : Boolean(input.persistent)
      const previous = states.get(key)
      const checkpoint = previous?.threads?.[thread]
      // A cut invalidates only the transport series of the thread it happened on: the
      // thread either carries the marker on its own checkpoint, or (before its first
      // checkpoint exists) in the slot-wide attempt record.
      const afterCut = Boolean(checkpoint?.cut)
        || Boolean(previous?.lastAttempt)
          && (!previous.lastAttempt.thread || previous.lastAttempt.thread === thread)

      // Transport identity (the epoch that names the upstream session) is decided apart
      // from snapshot validity. With stableTransport a rebuild ('rebased' / 'size') keeps
      // the epoch while the transcript window start is provably unchanged; a moved or
      // unknown window start, or an interrupted call (afterCut), always rotates it.
      const stableTransport = input.stableTransport === true
      const windowStart = validWindowStart(input.windowStart) ? input.windowStart : null
      const previousWindowStart = validWindowStart(checkpoint?.windowStart) ? checkpoint.windowStart : null
      const previousEpoch = typeof checkpoint?.transportEpoch === 'string' ? checkpoint.transportEpoch : null
      const windowKnown = windowStart !== null && previousWindowStart !== null
      const windowCut = windowKnown && windowStart !== previousWindowStart
      const maxChars = options.maxChars ?? 1400000
      // Per-reference token budget (item 7); the char cap stays as a global ceiling.
      const maxWireTokens = Number.isSafeInteger(input.maxWireTokens) && input.maxWireTokens > 0
        ? input.maxWireTokens : null
      const tooLarge = wire => JSON.stringify(wire).length > maxChars
        || (maxWireTokens !== null && wireTokens({ system, messages: wire }) > maxWireTokens)

      function plan(wire, reset, reason, replay = null) {
        const snapshot = clone(wire)
        const rebuild = reason === 'rebased' || reason === 'size'
        // A moved window start (windowCut) rotates on every path, including append and
        // same_snapshot: the transcript head changed, so the old upstream prefix is gone.
        // Only under stableTransport, so stableTransport=false stays byte-for-byte 0.8.0.
        const keep = previousEpoch !== null && !afterCut && !(stableTransport && windowCut)
          && (!reset || (stableTransport && rebuild && windowKnown))
        const transportEpoch = keep ? previousEpoch : randomUUID().replaceAll('-', '')
        const chars = JSON.stringify(snapshot).length
        return {
          key, sessionId, persistent, replay, reset, reason, source, system, transportEpoch,
          thread, request, windowStart,
          epoch, sessionEpoch: sessionEpochs.get(sessionId) ?? 0,
          wire: snapshot,
          core: JSON.stringify({ system, messages: snapshot.slice(0, -1) }),
          diagnostics: {
            reason: reason === 'initial' || reason === 'latest' ? 'fresh'
              : windowCut ? 'cut' : rebuild ? reason : 'append',
            epochKept: previousEpoch !== null && transportEpoch === previousEpoch,
            previousEpoch,
            windowStart,
            previousWindowStart,
            stableTransport,
            afterCut,
            chars,
            maxChars,
            ...(maxWireTokens !== null ? { tokens: wireTokens({ system, messages: snapshot }), maxWireTokens } : {}),
            oversize: tooLarge(snapshot),
          },
        }
      }

      // Every return goes through here so every path gets the same size check. A
      // growing (non-reset) wire that no longer fits falls back to a fresh scaffold; a
      // scaffold cannot shrink further, so it is only flagged (diagnostics.oversize).
      function finish(wire, reset, reason, replay = null) {
        // A same_snapshot replay (replay !== null) sends nothing, so it is never rebuilt.
        if (!reset && persistent && replay === null && tooLarge(wire)) {
          return plan(scaffold(source, suffix), true, 'size')
        }
        return plan(wire, reset, reason, replay)
      }

      if (!persistent) {
        return finish([{ role: 'user', content: QUOTED + source + suffix }], false, 'latest')
      }
      if (!checkpoint) return finish(scaffold(source, suffix), true, 'initial')
      const compatible = checkpoint.version === DIALOGUE_VERSION
        && checkpoint.view === DIALOGUE_VIEW
        && checkpoint.system === system
        && source.startsWith(checkpoint.source)
      if (!compatible) return finish(scaffold(source, suffix), true, 'rebased')
      if (source === checkpoint.source) return finish([], false, 'same_snapshot', checkpoint.reply)

      const assistant = { role: 'assistant', content: clone(checkpoint.replyContent ?? checkpoint.reply) }
      if (checkpoint.replySource) assistant.source = clone(checkpoint.replySource)
      const candidate = [
        ...clone(checkpoint.wire),
        assistant,
        { role: 'user', content: NEW_DELTA + source.slice(checkpoint.source.length) + suffix },
      ]
      return finish(candidate, false, afterCut ? 'append_after_cut' : 'append')
    },

    commit(plan, result = {}) {
      // Capture before any await: caller mutation and a later clear cannot revive stale state.
      const snapshot = clone({
        key: plan.key, sessionId: plan.sessionId, persistent: Boolean(plan.persistent),
        source: plan.source, system: plan.system, wire: plan.wire, transportEpoch: plan.transportEpoch,
        epoch: plan.epoch, sessionEpoch: plan.sessionEpoch, thread: plan.thread, request: plan.request,
        windowStart: validWindowStart(plan.windowStart) ? plan.windowStart : null,
      })
      const complete = result.complete === true
      const dispatched = result.dispatched === undefined ? true : Boolean(result.dispatched)
      const reply = typeof result.reply === 'string' ? result.reply : ''
      const reason = String(result.reason ?? '')
      const replyContent = validContent(result.content) ? clone(result.content) : undefined
      const replySource = isObject(result.source) ? clone(result.source) : undefined
      const status = { key: snapshot.key, persistent: snapshot.persistent, complete, recorded: 'none' }

      return enqueue(snapshot.key, async () => {
        if (!snapshot.persistent || closed || snapshot.epoch !== epoch
          || snapshot.sessionEpoch !== (sessionEpochs.get(snapshot.sessionId) ?? 0)) return status
        let state
        if (complete) {
          const checkpoint = {
            version: DIALOGUE_VERSION, view: DIALOGUE_VIEW,
            system: snapshot.system, source: snapshot.source, reply,
            wire: clone(snapshot.wire), ts: now(), transportEpoch: snapshot.transportEpoch,
            request: clone(snapshot.request),
          }
          if (replyContent !== undefined) checkpoint.replyContent = replyContent
          if (replySource !== undefined) checkpoint.replySource = replySource
          // Persist the window origin this checkpoint was built against; the next rebuild
          // compares against it to decide whether the transport epoch may be kept.
          if (snapshot.windowStart !== null) checkpoint.windowStart = snapshot.windowStart
          const threads = clone(states.get(snapshot.key)?.threads ?? {})
          threads[snapshot.thread] = checkpoint
          // A completed call clears only its own cut marker. A cut on another request
          // thread (advice vs review) must keep forcing that thread onto a fresh transport.
          const previousAttempt = states.get(snapshot.key)?.lastAttempt
          const foreignAttempt = previousAttempt && previousAttempt.thread
            && previousAttempt.thread !== snapshot.thread ? previousAttempt : null
          state = { threads, lastAttempt: foreignAttempt, sessionId: snapshot.sessionId }
          status.recorded = 'checkpoint'
        } else {
          if (!dispatched) return status
          const previous = states.get(snapshot.key)
          const threads = clone(previous?.threads ?? {})
          if (threads[snapshot.thread]) {
            // The thread already owns a checkpoint, so the cut goes with it and stays
            // visible even when another thread fails or completes afterwards.
            threads[snapshot.thread] = { ...threads[snapshot.thread], cut: { reason, ts: now() } }
            const foreign = previous?.lastAttempt && previous.lastAttempt.thread
              && previous.lastAttempt.thread !== snapshot.thread ? previous.lastAttempt : null
            state = { threads, lastAttempt: foreign, sessionId: snapshot.sessionId }
          } else {
            state = {
              threads,
              lastAttempt: { source: snapshot.source, reason, ts: now(), thread: snapshot.thread },
              sessionId: snapshot.sessionId,
            }
          }
          status.recorded = 'last_attempt'
        }
        states.set(snapshot.key, state)
        if (kv) await kv.putRecord('dialogue', snapshot.key, persistedState(state))
        return status
      })
    },

    async clear(sessionId) {
      if (sessionId) sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1)
      else epoch += 1
      await Promise.all([...queues.values()])
      const keys = new Set([...states].filter(([, state]) => !sessionId || state.sessionId === sessionId).map(([key]) => key))
      if (kv) {
        const data = await kv.loadAll()
        for (const [key, record] of Object.entries(data?.tables?.dialogue ?? {})) {
          if (!sessionId || record?.sessionId === sessionId) keys.add(key)
        }
        for (const key of keys) await kv.deleteRecord('dialogue', key)
      }
      for (const key of keys) states.delete(key)
    },

    async close() {
      if (!closePromise) {
        closed = true
        closePromise = (async () => {
          await Promise.all([...queues.values()])
          if (kv) await kv.close()
        })()
      }
      await closePromise
    },

    stats() {
      let persistentRecords = 0
      let lastAttempts = 0
      for (const state of states.values()) {
        if (Object.keys(state.threads).length) persistentRecords++
        if (state.lastAttempt) lastAttempts++
      }
      return { records: states.size, persistentRecords, lastAttempts }
    },
  }
}
