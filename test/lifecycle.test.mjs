// Independent continuity / async-boundary tests for dsh-better-moa 0.4.
//
// Boundary rule: this suite imports the canonical implementation directly
// (../dsh-better-moa), never the moa-selftest-local mirror. The first test keeps
// that honest by checking every relative specifier resolves inside the canonical
// directory.
//
// Style: every test drives the public contracts (preStep decision.messages,
// DialogueStore.prepare/commit/clear, adapter stream + replayState, aggregator
// transcript) and asserts causal, externally observable effects: which runtime
// calls happened, in what order, what wire each call carried, what was persisted,
// and whether an AbortSignal released the actor. No test re-implements core logic.
//
// Timing: the fake runtime hands out controllable deferred promises, so blocking a
// "provider" is instant regardless of machine speed and no test needs a long sleep.
// Every test closes the engine + store even when an assertion fails.
//
// Run: node --test moa-selftest/lifecycle.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { createAdviceEngine } from '../advice.js'
import {
  SETUP_USER, SETUP_ASSISTANT, QUOTED, NEW_DELTA, SUFFIX,
  createDialogueStore, dialogueIdentity,
} from '../dialogue.js'
import { createMoaAdapter } from '../adapter.js'
import {
  adviceRouteKey, contentToText, makeAdviceMessage, selectAdviceForAggregator,
} from '../transcript.js'

const SELF_FILE = fileURLToPath(import.meta.url)
const SELF_DIR = path.dirname(SELF_FILE)
const CANONICAL_DIR = path.resolve(SELF_DIR, '..')

const FAKE_PROVIDER = 'fake'
const CLAUDE_MODEL = 'fake/claude-advisor' // matches isClaude(): Stop must not abort the sent request
const DEFAULT_USAGE = { inputTokens: 41, outputTokens: 7, totalTokens: 48 }

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function deferred() {
  const box = { settled: false }
  box.promise = new Promise((resolve, reject) => {
    box.resolve = (value) => { box.settled = true; resolve(value) }
    box.reject = (error) => { box.settled = true; reject(error) }
  })
  box.promise.catch(() => {})
  return box
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve))
}

// Flush pending continuations until no queued work can still change the observed
// state. This replaces fixed sleeps when the assertion is "nothing else dispatched".
async function pump(times = 4) {
  for (let index = 0; index < times; index += 1) await tick()
}

async function waitFor(predicate, label, tries = 6000) {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function settledWithin(promise, ms = 2000) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'timeout' }), ms)
    timer.unref?.()
  })
  try {
    const winner = await Promise.race([
      promise.then((value) => ({ state: 'settled', value }), (error) => ({ state: 'rejected', error })),
      timeout,
    ])
    if (winner.state === 'timeout') return winner
    if (winner.state === 'rejected') throw winner.error
    return winner
  } finally {
    clearTimeout(timer)
  }
}

function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function assistantMessage(id, text) {
  return { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: FAKE_PROVIDER, model: 'fake/actor' } }
}

// Host-side session: matches the MoA route, exposes the history the engine reads
// through deriveMessages(), and keeps the same shape across turns.
function makeSession(id, presetId = 'harness') {
  return {
    id,
    history: [],
    header: { id, cwd: 'C:\\fake\\workspace' },
    requestHeader() { return { config: { provider: 'moa', model: presetId } } },
    deriveMessages() { return this.history },
    use(history) { this.history = history; return this },
  }
}

function enterDecision(messages) {
  return { kind: 'enter', messages: [...messages] }
}

function reference(id, overrides = {}) {
  return { id, provider: FAKE_PROVIDER, model: 'fake/model', label: id, maxTokens: 512, ...overrides }
}

function makePreset(overrides = {}) {
  const references = overrides.references ?? [reference('ref-a')]
  return {
    id: 'harness',
    label: 'Harness MoA',
    description: 'lifecycle test preset',
    fanout: 'user_turn',
    aggregator: { provider: FAKE_PROVIDER, model: 'fake/aggregator' },
    referenceMaxTokens: 512,
    referenceTimeoutMs: 8000,
    deadlineMs: 20000,
    ...overrides,
    references,
  }
}

function makeConfig(presetId, overrides = {}) {
  return {
    enabled: true,
    defaultPreset: presetId,
    fanout: 'user_turn',
    referenceSchedule: 'parallel',
    referenceMaxTokens: 512,
    referenceTimeoutMs: 8000,
    deadlineMs: 20000,
    maxTranscriptChars: 1400000,
    maxMessageChars: 24000,
    guardEnabled: false,
    persistentTags: ['*'],
    recordRuns: 20,
    adviceHistory: 'latest',
    ...overrides,
  }
}

// Fake model runtime. Every stream call is recorded and parks on a deferred gate
// until the test releases it. Nothing here sleeps, so blocking is deterministic.
function makeRuntime(respond = () => ({}), { auto = false } = {}) {
  const calls = []

  function emit(payload) {
    return (async function* () {
      if (payload.error) throw payload.error
      if (Array.isArray(payload.chunks)) {
        for (const chunk of payload.chunks) yield chunk
        return
      }
      for (const text of payload.reasoning ?? []) yield { type: 'reasoning-delta', text }
      const texts = payload.texts ?? (payload.text === undefined ? [] : [payload.text])
      for (const text of texts) yield { type: 'text-delta', text }
      if (payload.usage) yield { type: 'usage', usage: payload.usage }
      if (payload.finish === null) return
      const finish = { type: 'finish', reason: payload.finishReason ?? { kind: 'stop' } }
      if (payload.replayState !== undefined) finish.replayState = payload.replayState
      finish.usage = payload.usage ?? DEFAULT_USAGE
      yield finish
    })()
  }

  const runtime = {
    calls,
    stream(options) {
      const call = {
        index: calls.length,
        options,
        released: false,
        aborted: false,
        settled: false,
      }
      const gate = deferred()
      call.gate = gate
      call.release = (payload) => {
        call.released = true
        gate.resolve(payload ?? call.script ?? {})
        return call
      }
      calls.push(call)
      call.script = respond(options, call) ?? {}
      const onAbort = () => {
        call.aborted = true
        gate.reject(new Error('transport aborted'))
      }
      const signal = options.signal
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      if (auto) call.release(call.script)
      return (async function* () {
        try {
          yield* emit(await gate.promise)
        } finally {
          call.settled = true
        }
      })()
    },
  }
  runtime.releaseAll = () => { for (const call of calls) if (!call.released) call.release() }
  return runtime
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function startEngine({ runtime, preset = makePreset(), config: overrides = {}, kv = null }) {
  const config = makeConfig(preset.id, overrides)
  const store = createDialogueStore({ kv, persistentTags: config.persistentTags })
  await store.load()
  const presets = new Map([[preset.id, preset]])
  const engine = createAdviceEngine({ runtime, store, presets, config, log: null, kv })
  await engine.load()
  return { engine, store, config, presets, preset }
}

async function shutdown(context, runtime) {
  runtime.releaseAll()
  await tick()
  const closing = (async () => {
    await context.engine.close()
    await context.store.close()
  })()
  closing.catch(() => {})
  let timer
  const guard = new Promise((resolve) => { timer = setTimeout(resolve, 3000, 'timeout') })
  const winner = await Promise.race([closing.then(() => 'closed'), guard])
  clearTimeout(timer)
  if (winner !== 'closed') throw new Error('engine.close()/store.close() did not settle within 3s')
}

async function runPreStep(engine, session, turn, step, history) {
  const result = await startPreStep(engine, session, turn, step, history)
  assert.equal(result.kind, 'enter', 'preStep must keep the decision kind')
  assert.ok(Array.isArray(result.messages), 'preStep must expose decision.messages')
  return result
}

function startPreStep(engine, session, turn, step, history) {
  session.use(history)
  const controller = new AbortController()
  const decision = enterDecision([])
  return engine.preStep(
    { agent: { session }, turn, step, signal: controller.signal, history },
    async () => decision,
  )
}

function adviceMessages(decision, routeKey) {
  return decision.messages.filter((message) => message.source?.kind === 'plugin:moa' && (!routeKey || message.source.routeKey === routeKey))
}

function wireText(call) {
  return call.options.messages.map((message) => contentToText(message.content, { maxChars: Number.MAX_SAFE_INTEGER })).join('\n')
}

function assertScaffold(call, text, label) {
  const messages = call.options.messages
  assert.equal(messages.length, 3, `${label}: a fresh slot starts from the 3-message setup wire`)
  assert.equal(contentToText(messages[1].content), SETUP_ASSISTANT)
  const quoted = contentToText(messages[0].content, { maxChars: Number.MAX_SAFE_INTEGER })
  assert.ok(quoted.startsWith(SETUP_USER + '\n\n' + QUOTED), `${label}: transcript is seeded before the acknowledgement`)
  assert.equal(contentToText(messages[2].content), SUFFIX, `${label}: live tail contains only the instruction`)
  assert.ok(quoted.includes(`<source id="u1"`), `${label}: the user turn must be quoted with its source id`)
  assert.ok(quoted.includes(text), `${label}: the user turn text must be preserved`)
}

// ---------------------------------------------------------------------------
// 0. import boundary
// ---------------------------------------------------------------------------

test('lifecycle suite imports the canonical ../dsh-better-moa, not the moa mirror', () => {
  const source = readFileSync(SELF_FILE, 'utf8')
  const specifiers = [...source.matchAll(/^\s*import[\s\S]*?from\s+'([^']+)'/gm)].map((match) => match[1])
  const relative = specifiers.filter((specifier) => specifier.startsWith('.'))
  assert.ok(relative.length >= 4, 'expected the suite to import canonical modules')
  for (const specifier of relative) {
    const resolved = fileURLToPath(new URL(specifier, import.meta.url))
    assert.ok(
      resolved.startsWith(CANONICAL_DIR + path.sep),
      `${specifier} resolved to ${resolved}, outside the canonical directory ${CANONICAL_DIR}`,
    )
  }
})

// ---------------------------------------------------------------------------
// 1. per-slot continuity
// ---------------------------------------------------------------------------

test('two slots on one provider/model keep independent histories and runtime session ids', { timeout: 25000 }, async () => {
  const runtime = makeRuntime((options) => ({
    text: String(options.system).includes('slot-a') ? 'advice for slot a' : 'advice for slot b',
  }), { auto: true })
  // Both slots share the SAME provider/model on purpose: only the slot id may separate them.
  const preset = makePreset({
    references: [
      reference('slot-a', { systemSuffix: ' [slot-a]' }),
      reference('slot-b', { systemSuffix: ' [slot-b]' }),
    ],
  })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-slots')
    const history = [userMessage('u1', 'first request')]
    const decision1 = await runPreStep(context.engine, session, 1, 1, history)

    assert.equal(runtime.calls.length, 2, 'each slot must run its own reference dialogue')
    const callA1 = runtime.calls.find((call) => String(call.options.system).includes('slot-a'))
    const callB1 = runtime.calls.find((call) => String(call.options.system).includes('slot-b'))
    assert.ok(callA1 && callB1, 'both slots must dispatch')
    assertScaffold(callA1, 'first request', 'slot-a turn 1')
    assertScaffold(callB1, 'first request', 'slot-b turn 1')
    for (const call of [callA1, callB1]) {
      assert.ok(String(call.options.sessionId).startsWith('moa-ref-'), 'the slot must carry a runtime session id')
    }
    assert.notEqual(callA1.options.sessionId, callB1.options.sessionId, 'slots must not share a runtime session id')

    const guidance1 = adviceMessages(decision1)
    assert.equal(guidance1.length, 1, 'one advice message per preStep')
    assert.match(contentToText(guidance1[0].content), /advice for slot a/)
    assert.match(contentToText(guidance1[0].content), /advice for slot b/)

    // Turn 2: the actor answered and the user asked something new.
    const history2 = [
      ...history,
      ...decision1.messages,
      assistantMessage('a1', 'acting answer for turn one'),
      userMessage('u2', 'second request'),
    ]
    const decision2 = await runPreStep(context.engine, session, 2, 1, history2)

    assert.equal(runtime.calls.length, 4, 'each slot must run again for the new turn')
    const callA2 = runtime.calls.filter((call) => String(call.options.system).includes('slot-a'))[1]
    const callB2 = runtime.calls.filter((call) => String(call.options.system).includes('slot-b'))[1]
    assert.ok(callA2 && callB2)

    for (const [call, own, other] of [[callA2, 'advice for slot a', 'advice for slot b'], [callB2, 'advice for slot b', 'advice for slot a']]) {
      assert.equal(call.options.messages.length, 5, 'turn-2 wire = setup + own anchor + new delta')
      assert.equal(call.options.messages[3].role, 'assistant', 'own previous reply must be the assistant anchor')
      assert.equal(contentToText(call.options.messages[3].content), own)
      assert.ok(!wireText(call).includes(other), 'a slot must never see the other slot reply')
      assert.ok(contentToText(call.options.messages[4].content).startsWith(NEW_DELTA))
      assert.match(contentToText(call.options.messages[4].content), /second request/)
    }

    assert.equal(callA2.options.sessionId, callA1.options.sessionId, 'slot-a keeps its session id across turns')
    assert.equal(callB2.options.sessionId, callB1.options.sessionId, 'slot-b keeps its session id across turns')
    assert.notEqual(callA2.options.sessionId, callB2.options.sessionId)
    assert.equal(adviceMessages(decision2).length, 1)
  } finally {
    await shutdown(context, runtime)
  }
})

test('explicitly duplicated reference ids do not alias one dialogue slot', { timeout: 25000 }, async () => {
  let ordinal = 0
  const runtime = makeRuntime(() => {
    const text = `twin reply ${ordinal}`
    ordinal += 1
    return { text }
  }, { auto: true })
  const preset = makePreset({ references: [reference('twin'), reference('twin')] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-duplicate')
    const history = [userMessage('u1', 'first request')]
    const decision1 = await runPreStep(context.engine, session, 1, 1, history)

    assert.equal(
      runtime.calls.length, 2,
      'two configured slots must each dispatch; a shared slot identity silently replays one reply into both',
    )
    for (const call of runtime.calls) assertScaffold(call, 'first request', 'duplicate-id slot')
    const firstTurn = runtime.calls.slice(0, 2)
    assert.equal(new Set(firstTurn.map((call) => call.options.sessionId)).size, 2, 'duplicate ids must not share a runtime session')
    const firstReplyBySession = new Map(firstTurn.map((call) => [call.options.sessionId, call.script.text]))

    const history2 = [
      ...history,
      ...decision1.messages,
      assistantMessage('a1', 'acting answer for turn one'),
      userMessage('u2', 'second request'),
    ]
    await runPreStep(context.engine, session, 2, 1, history2)

    assert.equal(runtime.calls.length, 4, 'both duplicate-id slots must run again for turn 2')
    const secondTurn = runtime.calls.slice(2)
    assert.deepEqual(
      new Set(secondTurn.map((call) => call.options.sessionId)),
      new Set(firstTurn.map((call) => call.options.sessionId)),
      'each duplicate-id slot must keep its own runtime session',
    )
    for (const call of secondTurn) {
      assert.equal(call.options.messages.length, 5)
      const anchor = contentToText(call.options.messages[3].content)
      assert.equal(anchor, firstReplyBySession.get(call.options.sessionId), 'each duplicate-id slot must anchor its own reply')
    }
    assert.notEqual(contentToText(secondTurn[0].options.messages[3].content), contentToText(secondTurn[1].options.messages[3].content))
  } finally {
    await shutdown(context, runtime)
  }
})

// ---------------------------------------------------------------------------
// 2. Stop releases pre-step; the sent request keeps draining
// ---------------------------------------------------------------------------

test('Stop releases preStep at once and the in-flight request still commits as the next anchor', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  const preset = makePreset({ references: [reference('slow', { model: CLAUDE_MODEL })] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-stop')
    const controller = new AbortController()
    const decision = enterDecision([])
    const pending = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: controller.signal, history: [userMessage('u1', 'first question')] },
      async () => decision,
    )
    session.use([userMessage('u1', 'first question')])
    await waitFor(() => runtime.calls.length === 1, 'reference dispatch')
    const call = runtime.calls[0]
    assert.equal(call.aborted, false)

    controller.abort()
    const released = await settledWithin(pending)
    assert.equal(released.state, 'settled', 'Stop must release the acting agent immediately')
    assert.equal(released.value.messages.length, 0, 'an aborted step must not receive advice')
    assert.equal(call.aborted, false, 'Stop must not abort the already-sent provider request')
    assert.equal(call.settled, false, 'the request must still be draining after Stop')

    const replayState = { vendor: { turn: 1, cache: 'kept' } }
    call.release({
      text: 'late but useful advice',
      reasoning: ['private reasoning kept for the anchor'],
      replayState,
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    })
    await waitFor(() => call.settled, 'transport drain after Stop')
    await waitFor(() => context.store.stats().records >= 1, 'late reply checkpoint')

    // Brand new turn, same session: the late reply must be the slot's anchor.
    const history2 = [userMessage('u1', 'first question'), assistantMessage('a1', 'acting answer'), userMessage('u2', 'second question')]
    const pending2 = startPreStep(context.engine, session, 2, 1, history2)
    await waitFor(() => runtime.calls.length === 2, 'turn-2 reference dispatch')

    const call2 = runtime.calls[1]
    call2.release({ text: 'fresh advice for turn two' })
    const settled2 = await settledWithin(pending2, 4000)
    assert.equal(settled2.state, 'settled', 'turn-2 preStep must settle once its reference replies')
    const decision2 = settled2.value

    assert.equal(call2.options.messages.length, 5, 'turn-2 wire = setup + late anchor + new delta')
    const anchor = call2.options.messages[3]
    assert.equal(anchor.role, 'assistant')
    assert.equal(contentToText(anchor.content), 'late but useful advice')
    assert.deepEqual(anchor.source.replayState, replayState, 'the anchor must keep the replay metadata')
    assert.equal(anchor.source.kind, 'model')
    assert.equal(anchor.source.provider, FAKE_PROVIDER)
    assert.equal(anchor.source.model, CLAUDE_MODEL)
    const reasoning = (anchor.content ?? []).filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
    assert.match(reasoning, /private reasoning kept for the anchor/, 'the anchor must keep the reasoning content')

    const delta = contentToText(call2.options.messages[4].content)
    assert.ok(delta.startsWith(NEW_DELTA), 'the new user turn must arrive as a new delta, not as a replay of the advice')
    assert.match(delta, /second question/)

    // The old reply is an anchor, not advice: it is never injected into the new turn.
    const injected = adviceMessages(decision2)
    assert.equal(injected.length, 1)
    assert.match(contentToText(injected[0].content), /fresh advice for turn two/)
    assert.ok(!contentToText(injected[0].content).includes('late but useful advice'))
    assert.ok(!call2.options.messages.some((message, index) => index !== 3 && contentToText(message.content).includes('late but useful advice')))
  } finally {
    await shutdown(context, runtime)
  }
})

// ---------------------------------------------------------------------------
// 3. queued-but-unsent references are cancelled, never dispatched, no attempt
// ---------------------------------------------------------------------------

test('Stop aborts a non-draining reference transport yet still releases preStep', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  // A plain model is not drained on Stop, unlike Claude routes: its transport must be aborted.
  const preset = makePreset({ references: [reference('plain', { model: 'fake/plain' })] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-nondrain')
    const history = [userMessage('u1', 'question')]
    session.use(history)
    const controller = new AbortController()
    const pending = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: controller.signal, history },
      async () => enterDecision([]),
    )
    await waitFor(() => runtime.calls.length === 1, 'non-draining reference dispatch')
    const call = runtime.calls[0]

    controller.abort(new Error('user pressed stop'))
    const released = await settledWithin(pending, 1000)
    assert.equal(released.state, 'settled', 'Stop must release preStep even for a non-draining reference')
    assert.equal(released.value.messages.length, 0, 'an aborted step must not receive advice')

    await waitFor(() => call.aborted, 'non-draining transport abort')
    await waitFor(() => call.settled, 'non-draining transport settle')
    await waitFor(() => context.store.stats().lastAttempts >= 1, 'the aborted dispatched slot records an attempt')

    const stats = context.store.stats()
    assert.equal(stats.persistentRecords, 0, 'an aborted reference must not checkpoint a reply')
    assert.equal(stats.lastAttempts, 1, 'a dispatched-but-aborted slot writes exactly one attempt')
  } finally {
    await shutdown(context, runtime)
  }
})

test('a tool-calls finish is rejected: no anchor, no injected advice text', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  const preset = makePreset({ references: [reference('toolish')] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-toolcalls')
    const history = [userMessage('u1', 'question')]
    session.use(history)
    const decision = enterDecision([])
    const pending = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal, history },
      async () => decision,
    )
    await waitFor(() => runtime.calls.length === 1, 'tool-calls reference dispatch')
    runtime.calls[0].release({
      chunks: [
        { type: 'text-delta', text: 'SNEAKY-TOOL-ADVICE' },
        { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
    })
    const result = await settledWithin(pending, 3000)
    assert.equal(result.state, 'settled', 'an illegal tool-calls finish must not hang preStep')
    assert.ok(!JSON.stringify(result.value.messages).includes('SNEAKY-TOOL-ADVICE'), 'tool-calls text must not be injected as advice')
    const stats = context.store.stats()
    assert.equal(stats.persistentRecords, 0, 'a tool-calls reply must not become an anchor')
    assert.equal(stats.lastAttempts, 1, 'a dispatched tool-calls reply is recorded as a failed attempt')
  } finally {
    await shutdown(context, runtime)
  }
})

test('Stop rejects a same-slot reference waiting on the previous transport and writes no attempt', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  const preset = makePreset({ references: [reference('shared', { model: CLAUDE_MODEL })] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-queue-stop')
    const historyOne = [userMessage('u1', 'first question')]
    session.use(historyOne)
    const runOne = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal, history: historyOne },
      async () => enterDecision([]),
    )
    await waitFor(() => runtime.calls.length === 1, 'run one dispatch')

    // Turn 2 resolves to the same persistent slot with the same reference index/id.
    // The new fan-out starts at once, but this slot is held by run one's transport.
    const historyTwo = [...historyOne, assistantMessage('a1', 'answer'), userMessage('u2', 'second question')]
    const controller = new AbortController()
    session.use(historyTwo)
    const runTwo = context.engine.preStep(
      { agent: { session }, turn: 2, step: 1, signal: controller.signal, history: historyTwo },
      async () => enterDecision([]),
    )
    await pump()
    assert.equal(runtime.calls.length, 1, 'a same-slot reference must wait on the persistent slot mutex, never dispatch twice')
    assert.equal(context.store.stats().lastAttempts, 0, 'a waiting reference has not dispatched and must not record an attempt')

    controller.abort()
    const released = await settledWithin(runTwo)
    assert.equal(released.state, 'settled', 'Stop must release preStep while the slot waiter is still queued')
    assert.equal(released.value.messages.length, 0, 'an aborted step must not receive advice')

    runtime.calls[0].release({ text: 'run one late advice' })
    const one = await settledWithin(runOne, 3000)
    assert.equal(one.state, 'settled', 'the superseded run must settle from its own transport, not from the waiter')
    await waitFor(() => context.store.stats().records === 1, 'run one anchor checkpoint')
    await pump()

    assert.equal(runtime.calls.length, 1, 'the Stop-cancelled slot waiter must never reach the provider')
    const stats = context.store.stats()
    assert.equal(stats.records, 1, 'only the dispatched run may persist a checkpoint')
    assert.equal(stats.lastAttempts, 0, 'an undispatched waiter must not write an attempt record')
  } finally {
    await shutdown(context, runtime)
  }
})

test('a newer run waits on one persistent slot while another reference starts in parallel and anchors the late reply', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  // Both references drain on Stop, so the superseded run must finish and checkpoint
  // even while the new run is waiting for the same slots.
  const preset = makePreset({ references: [reference('shared', { model: CLAUDE_MODEL }), reference('other', { model: CLAUDE_MODEL })] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-queue-newrun')
    const historyOne = [userMessage('u1', 'first question')]
    session.use(historyOne)
    const runOne = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal, history: historyOne },
      async () => enterDecision([]),
    )
    await waitFor(() => runtime.calls.length === 2, 'all run-one references dispatch in parallel')

    const historyTwo = [...historyOne, assistantMessage('a1', 'answer'), userMessage('u2', 'second question')]
    const decisionTwo = enterDecision([])
    session.use(historyTwo)
    const runTwo = context.engine.preStep(
      { agent: { session }, turn: 2, step: 1, signal: new AbortController().signal, history: historyTwo },
      async () => decisionTwo,
    )
    await pump()
    assert.equal(runtime.calls.length, 2, 'the new run must wait for the two slots instead of duplicating in-flight calls')

    // Free the "other" slot first: only that waiter may proceed, proving the wait is
    // per slot rather than a global serial queue.
    runtime.calls[1].release({ text: 'run one other advice' })
    await waitFor(() => runtime.calls.length === 3, 'run two other reference dispatch after its own slot frees')
    assert.match(wireText(runtime.calls[2]), /second question/, 'the third call belongs to the new run')
    assert.equal(runtime.calls[2].options.messages.length, 5, 'the freed slot anchors run one reply before the new delta')
    assert.equal(contentToText(runtime.calls[2].options.messages[3].content), 'run one other advice')

    runtime.calls[0].release({ text: 'run one shared advice' })
    const one = await settledWithin(runOne, 3000)
    assert.equal(one.state, 'settled')
    assert.equal(one.value.messages.length, 0, 'the superseded run must not deliver advice')
    await waitFor(() => runtime.calls.length === 4, 'run two shared reference dispatch after the last slot frees')

    const sharedWire = runtime.calls[3].options.messages
    assert.ok(wireText(runtime.calls[3]).includes('second question'), 'the fourth call belongs to the new run')
    assert.equal(sharedWire.length, 5, 'the shared slot wire = setup + late anchor + new delta')
    assert.equal(sharedWire[3].role, 'assistant', 'a superseded run reply may only appear as the slot assistant anchor')
    assert.equal(contentToText(sharedWire[3].content), 'run one shared advice')
    assert.ok(contentToText(sharedWire[4].content).startsWith(NEW_DELTA), 'the anchor must sit right before the new delta')

    runtime.calls[2].release({ text: 'run two other advice' })
    runtime.calls[3].release({ text: 'run two shared advice' })
    const two = await settledWithin(runTwo, 3000)
    assert.equal(two.state, 'settled')
    const delivered = adviceMessages(two.value)
    assert.equal(delivered.length, 1, 'the new run delivers its own advice once')
    assert.match(contentToText(delivered[0].content), /run two other advice/)
    assert.match(contentToText(delivered[0].content), /run two shared advice/)

    await pump()
    const stats = context.store.stats()
    assert.equal(stats.lastAttempts, 0, 'a superseded draining reference must not be recorded as a failed attempt')
    assert.equal(stats.records, 2, `the two slot keys hold the newest turn, got ${stats.records}`)
  } finally {
    await shutdown(context, runtime)
  }
})

// ---------------------------------------------------------------------------
// 4. async references
// ---------------------------------------------------------------------------

test('an async reference joins the delivery of the step it finishes in, never waking preStep alone', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  const preset = makePreset({ references: [reference('sync'), reference('async', { async: true })] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-async')
    const history = [userMessage('u1', 'question one')]
    session.use(history)
    const decision = enterDecision([])
    const pending = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal, history },
      async () => decision,
    )
    await waitFor(() => runtime.calls.length === 2, 'both references dispatch')
    const asyncCall = runtime.calls[1]
    asyncCall.release({ text: 'async advice' })

    // The async reply must not unblock or answer anything by itself.
    let settled = null
    pending.then((value) => { settled = value })
    await delay(60)
    assert.equal(settled, null, 'the async reference must not wake preStep on its own')

    runtime.calls[0].release({ text: 'sync advice' })
    const result = await settledWithin(pending, 3000)
    assert.equal(result.state, 'settled')
    const injected = adviceMessages(result.value)
    assert.equal(injected.length, 1)
    assert.match(contentToText(injected[0].content), /sync advice/)
    assert.match(contentToText(injected[0].content), /async advice/, 'an async reply that arrived mid-step joins that same delivery')
  } finally {
    await shutdown(context, runtime)
  }
})

test('an async-only fan-out returns preStep immediately and delivers nothing', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  const preset = makePreset({ references: [reference('async-only', { async: true })] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-async-only')
    const history = [userMessage('u1', 'question one')]
    session.use(history)
    const decision = enterDecision([])
    const pending = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal, history },
      async () => decision,
    )
    await waitFor(() => runtime.calls.length === 1, 'async reference dispatch')
    const result = await settledWithin(pending, 2000)
    assert.equal(result.state, 'settled', 'an all-async fan-out must not block preStep')
    assert.equal(result.value.messages.length, 0, 'nothing may be delivered before the async reply exists')
    await delay(60)
    assert.equal(decision.messages.length, 0, 'no self-wake may append advice to the already-returned decision')

    runtime.calls[0].release({ text: 'async only advice' })
    await waitFor(() => context.store.stats().records >= 1, 'async checkpoint')

    // Only an admitted preStep may surface it: turn 2 sees it as the slot anchor.
    const history2 = [userMessage('u1', 'question one'), assistantMessage('a1', 'answer'), userMessage('u2', 'question two')]
    const decision2 = await runPreStep(context.engine, session, 2, 1, history2)
    assert.equal(runtime.calls.length, 2)
    assert.equal(contentToText(runtime.calls[1].options.messages[3].content), 'async only advice')
    assert.equal(adviceMessages(decision2).length, 0, 'an all-async fan-out yields no synchronous advice')
  } finally {
    await shutdown(context, runtime)
  }
})

test('a background batch is delivered once, combined, by the next admitted preStep after it seals', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  const preset = makePreset({ delivery: 'background', references: [reference('sync'), reference('async', { async: true })] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-async-harvest')
    const history1 = [userMessage('u1', 'question one')]
    session.use(history1)
    const first = await settledWithin(runPreStep(context.engine, session, 1, 1, history1), 2000)
    assert.equal(first.state, 'settled', 'a background batch must not hold the step')
    assert.equal(adviceMessages(first.value).length, 0, 'nothing is delivered before the batch seals')
    await waitFor(() => runtime.calls.length === 2, 'step one dispatch')

    // One reference answered: the batch is still open, so nothing is delivered.
    runtime.calls[0].release({ text: 'sync advice' })
    await pump()
    const beforeSeal = await runPreStep(context.engine, session, 1, 2, history1)
    assert.equal(adviceMessages(beforeSeal).length, 0, 'a partial batch must not be injected')

    runtime.calls[1].release({ text: 'late async advice' })
    await waitFor(() => context.store.stats().records >= 2, 'both checkpoints')
    await pump()

    // The admitted preStep delivers the sealed batch once, with both opinions.
    const stepThree = await runPreStep(context.engine, session, 1, 3, history1)
    const delivered = adviceMessages(stepThree)
    assert.equal(delivered.length, 1, 'the sealed batch is delivered by the next admitted preStep')
    assert.match(contentToText(delivered[0].content), /sync advice/)
    assert.match(contentToText(delivered[0].content), /late async advice/)
    assert.equal(runtime.calls.length, 2, 'harvesting must not dispatch a new fan-out')

    const history4 = [...history1, ...delivered]
    session.use(history4)
    const stepFour = await runPreStep(context.engine, session, 1, 4, history4)
    assert.equal(adviceMessages(stepFour).length, 0, 'a delivered batch is never injected again')
    assert.equal(runtime.calls.length, 2)
  } finally {
    await shutdown(context, runtime)
  }
})

// ---------------------------------------------------------------------------
// 5. late opinions are suppressed by a newer turn / config change / route change
// ---------------------------------------------------------------------------

test('a newer turn suppresses the previous turn late opinion', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  const preset = makePreset({ references: [reference('late', { model: CLAUDE_MODEL })] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-newturn')
    const history1 = [userMessage('u1', 'first question')]
    session.use(history1)
    const decisionOne = enterDecision([])
    const runOne = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal, history: history1 },
      async () => decisionOne,
    )
    await waitFor(() => runtime.calls.length === 1, 'turn one dispatch')

    const history2 = [userMessage('u1', 'first question'), assistantMessage('a1', 'answer'), userMessage('u2', 'second question')]
    const decisionTwo = enterDecision([])
    session.use(history2)
    const runTwo = context.engine.preStep(
      { agent: { session }, turn: 2, step: 1, signal: new AbortController().signal, history: history2 },
      async () => decisionTwo,
    )
    await delay(20)

    runtime.calls[0].release({ text: 'STALE-ADVICE' })
    const first = await settledWithin(runOne, 3000)
    assert.equal(first.state, 'settled')
    assert.equal(first.value.messages.length, 0, 'the superseded turn must not deliver its late opinion')
    assert.ok(!JSON.stringify(first.value.messages).includes('STALE-ADVICE'))

    await waitFor(() => runtime.calls.length === 2, 'turn two dispatch')
    runtime.calls[1].release({ text: 'FRESH-ADVICE' })
    const second = await settledWithin(runTwo, 3000)
    assert.equal(second.state, 'settled')
    const injected = adviceMessages(second.value)
    assert.equal(injected.length, 1)
    const text = contentToText(injected[0].content)
    assert.match(text, /FRESH-ADVICE/)
    assert.ok(!text.includes('STALE-ADVICE'), 'a late opinion from the previous turn must not leak into the new turn')
  } finally {
    await shutdown(context, runtime)
  }
})

test('a config change suppresses the late opinion of the previous signature', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  const preset = makePreset({ references: [reference('cfg', { model: CLAUDE_MODEL })] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-config')
    const history1 = [userMessage('u1', 'first question')]
    session.use(history1)
    const decisionOne = enterDecision([])
    const runOne = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal, history: history1 },
      async () => decisionOne,
    )
    await waitFor(() => runtime.calls.length === 1, 'turn one dispatch')

    context.config.guardEnabled = !context.config.guardEnabled
    const history2 = [userMessage('u1', 'first question'), assistantMessage('a1', 'answer'), userMessage('u2', 'second question')]
    const decisionTwo = enterDecision([])
    session.use(history2)
    const runTwo = context.engine.preStep(
      { agent: { session }, turn: 2, step: 1, signal: new AbortController().signal, history: history2 },
      async () => decisionTwo,
    )
    await delay(20)

    runtime.calls[0].release({ text: 'OLD-SIGNATURE-ADVICE' })
    const first = await settledWithin(runOne, 3000)
    assert.equal(first.state, 'settled')
    assert.equal(first.value.messages.length, 0)

    await waitFor(() => runtime.calls.length === 2, 'turn two dispatch under the new signature')
    runtime.calls[1].release({ text: 'NEW-SIGNATURE-ADVICE' })
    const second = await settledWithin(runTwo, 3000)
    assert.equal(second.state, 'settled')
    const injected = adviceMessages(second.value)
    assert.equal(injected.length, 1)
    const text = contentToText(injected[0].content)
    assert.match(text, /NEW-SIGNATURE-ADVICE/)
    assert.ok(!text.includes('OLD-SIGNATURE-ADVICE'))
  } finally {
    await shutdown(context, runtime)
  }
})

test('a route change suppresses late advice and only the new route opinion is delivered', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  const preset = makePreset({ references: [reference('route', { model: CLAUDE_MODEL })], aggregator: { provider: FAKE_PROVIDER, model: 'fake/agg-one' } })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-route')
    const routeOne = adviceRouteKey(preset)
    const history1 = [userMessage('u1', 'first question')]
    session.use(history1)
    const decisionOne = enterDecision([])
    const runOne = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal, history: history1 },
      async () => decisionOne,
    )
    await waitFor(() => runtime.calls.length === 1, 'route one dispatch')

    preset.aggregator = { provider: FAKE_PROVIDER, model: 'fake/agg-two' }
    const routeTwo = adviceRouteKey(preset)
    assert.notEqual(routeTwo, routeOne)

    const history2 = [userMessage('u1', 'first question'), assistantMessage('a1', 'answer'), userMessage('u2', 'second question')]
    const decisionTwo = enterDecision([])
    session.use(history2)
    const runTwo = context.engine.preStep(
      { agent: { session }, turn: 2, step: 1, signal: new AbortController().signal, history: history2 },
      async () => decisionTwo,
    )
    await delay(20)

    runtime.calls[0].release({ text: 'OLD-ROUTE-ADVICE' })
    const first = await settledWithin(runOne, 3000)
    assert.equal(first.state, 'settled')
    assert.equal(first.value.messages.length, 0)

    await waitFor(() => runtime.calls.length === 2, 'route two dispatch')
    runtime.calls[1].release({ text: 'NEW-ROUTE-ADVICE' })
    const second = await settledWithin(runTwo, 3000)
    assert.equal(second.state, 'settled')
    const injected = adviceMessages(second.value)
    assert.equal(injected.length, 1)
    assert.equal(injected[0].source.routeKey, routeTwo, 'delivered advice must carry the current route key')
    const text = contentToText(injected[0].content)
    assert.match(text, /NEW-ROUTE-ADVICE/)
    assert.ok(!text.includes('OLD-ROUTE-ADVICE'))
    assert.equal(adviceMessages(second.value, routeOne).length, 0, 'route-one advice must never be re-delivered under route two')
  } finally {
    await shutdown(context, runtime)
  }
})

// ---------------------------------------------------------------------------
// 6. clear() must not let a queued commit resurrect the dialogue
// ---------------------------------------------------------------------------

test('a commit built from a pre-clear snapshot cannot resurrect the dialogue', { timeout: 25000 }, async () => {
  const store = createDialogueStore({ persistentTags: ['*'] })
  await store.load()
  try {
    const input = {
      sessionId: 'sess-race',
      provider: FAKE_PROVIDER,
      model: 'fake/model',
      dialogueKey: 'harness',
      slotId: JSON.stringify([0, 'ref-a']),
      source: '<source id="u1" role="user" kind="user">\nquestion',
      system: 'advisor',
    }
    const plan = store.prepare(input)
    assert.equal(plan.reason, 'initial')
    assert.equal(plan.wire.length, 3)

    // Commit initiated, then clear lands before/while it flushes, then it settles.
    const staleCommit = store.commit(plan, { reply: 'stale reply', complete: true, dispatched: true })
    await store.clear('sess-race')
    await staleCommit
    assert.equal(store.stats().records, 0, 'a stale plan must not write a checkpoint after clear')

    const late = store.commit(plan, { reply: 'later stale reply', complete: true, dispatched: true })
    await late
    assert.equal(store.stats().records, 0, 'a commit issued after clear must not resurrect the dialogue')

    const fresh = store.prepare(input)
    assert.equal(fresh.reason, 'initial', 'after clear the slot must start again')
    assert.equal(fresh.wire.length, 3)
    assert.ok(String(fresh.wire[0].content).startsWith(SETUP_USER + '\n\n' + QUOTED))
  } finally {
    await store.close()
  }
})

test('clear aborts the dispatched transport and the same-slot waiter, leaving no store state', { timeout: 25000 }, async () => {
  const runtime = makeRuntime()
  const preset = makePreset({ references: [reference('live', { model: CLAUDE_MODEL })] })
  const context = await startEngine({ runtime, preset })
  try {
    const session = makeSession('sess-clear')
    const historyOne = [userMessage('u1', 'question')]
    session.use(historyOne)
    const runOne = context.engine.preStep(
      { agent: { session }, turn: 1, step: 1, signal: new AbortController().signal, history: historyOne },
      async () => enterDecision([]),
    )
    await waitFor(() => runtime.calls.length === 1, 'reference dispatch')

    const historyTwo = [...historyOne, assistantMessage('a1', 'answer'), userMessage('u2', 'next question')]
    session.use(historyTwo)
    const runTwo = context.engine.preStep(
      { agent: { session }, turn: 2, step: 1, signal: new AbortController().signal, history: historyTwo },
      async () => enterDecision([]),
    )
    await pump()
    assert.equal(runtime.calls.length, 1, 'the next turn waits on the same persistent slot instead of dispatching twice')

    await context.engine.clear('sess-clear')
    assert.equal(runtime.calls[0].aborted, true, 'clear must abort the dispatched transport, not orphan it')
    const released = await settledWithin(runTwo)
    assert.equal(released.state, 'settled', 'clear must release a preStep waiting on the slot')
    assert.equal(released.value.messages.length, 0, 'a cleared step must not receive advice')
    const one = await settledWithin(runOne, 3000)
    assert.equal(one.state, 'settled')
    assert.equal(one.value.messages.length, 0, 'a cleared in-flight run must not deliver advice')

    await waitFor(() => runtime.calls[0].settled, 'aborted transport settle')
    await pump()
    assert.equal(runtime.calls.length, 1, 'the same-slot waiter must not dispatch after clear')

    const stats = context.store.stats()
    assert.equal(stats.records, 0, 'a reply finishing after clear must not be checkpointed')
    assert.equal(stats.lastAttempts, 0, 'a reply finishing after clear must not leave an attempt')

    // The host may keep talking: the slot restarts from a fresh scaffold.
    const historyThree = [...historyTwo, assistantMessage('a2', 'second answer'), userMessage('u3', 'third question')]
    const follow = startPreStep(context.engine, session, 3, 1, historyThree)
    await waitFor(() => runtime.calls.length === 2, 'post-clear dispatch')
    runtime.calls[1].release({ text: 'fresh advice' })
    const followed = await settledWithin(follow, 4000)
    assert.equal(followed.state, 'settled', 'the post-clear preStep must settle')
    const wire = runtime.calls[1].options.messages
    assert.equal(wire.length, 3, 'the cleared slot must be a fresh scaffold')
    assert.ok(!wireText(runtime.calls[1]).includes('CLEARED-REPLY'), 'a cleared reply must not come back as an anchor')
    assert.match(contentToText(adviceMessages(followed.value)[0].content), /fresh advice/)
  } finally {
    await shutdown(context, runtime)
  }
})

// ---------------------------------------------------------------------------
// 7. adapter: replay-state scoping, route freshness, untouched tool messages
// ---------------------------------------------------------------------------

test('aggregator affinity keeps its scope for an unchanged prefix and drops it across a route switch', { timeout: 25000 }, async () => {
  const runtime = makeRuntime(() => ({ text: 'aggregator reply', replayState: { vendor: { turn: 1 } } }), { auto: true })
  const preset = makePreset({ references: [reference('ref-a')], aggregator: { provider: FAKE_PROVIDER, model: 'fake/agg-one' } })
  const adapter = createMoaAdapter({ runtime, presets: new Map([[preset.id, preset]]), config: makeConfig(preset.id) })

  const messages = [
    userMessage('u1', 'first question'),
    assistantMessage('a1', 'answer'),
    { id: 't1', role: 'tool', content: [{ type: 'tool-result', text: 'tool output' }], source: { kind: 'tool' } },
    userMessage('u2', 'second question'),
  ]
  const snapshot = JSON.parse(JSON.stringify(messages))

  const first = await collect(adapter.stream({ provider: 'moa', model: preset.id, sessionId: 'host-session-1', messages, system: 'sys' }))
  const firstFinish = first.at(-1)
  assert.equal(firstFinish.type, 'finish')
  assert.equal(firstFinish.replayState.response.moa, 1)
  const scopeOne = firstFinish.replayState.response.scope
  assert.ok(scopeOne, 'the aggregator scope must be exposed through the wrapped replay state')
  assert.equal(runtime.calls[0].options.provider, FAKE_PROVIDER, 'the aggregator call must target the aggregator provider')
  assert.equal(runtime.calls[0].options.model, 'fake/agg-one')
  // 0.6: non-native aggregators ride the main session id so billion-context attribution and its tools agree.
  assert.equal(runtime.calls[0].options.sessionId, 'host-session-1', 'a non-native aggregator must carry the main session id')

  // Unchanged prefix + more messages: still one scope.
  const extended = [...messages, userMessage('u3', 'third question')]
  const second = await collect(adapter.stream({
    provider: 'moa', model: preset.id, sessionId: 'host-session-1', messages: extended, system: 'sys',
    replayState: firstFinish.replayState,
  }))
  const scopeTwo = second.at(-1).replayState.response.scope
  assert.equal(scopeTwo, scopeOne, 'an unchanged prefix must keep the aggregator scope')

  // Prefix rewritten (A -> B): the old scope must be refused, the old replay dropped.
  const rewritten = [userMessage('u1', 'first question rewritten'), ...messages.slice(1)]
  const third = await collect(adapter.stream({
    provider: 'moa', model: preset.id, sessionId: 'host-session-1', messages: rewritten, system: 'sys',
    replayState: second.at(-1).replayState,
  }))
  const scopeThree = third.at(-1).replayState.response.scope
  assert.notEqual(scopeThree, scopeTwo, 'a rewritten prefix must start a new aggregator generation')

  // Route switch: the wrapped state from route one must not survive.
  preset.aggregator = { provider: FAKE_PROVIDER, model: 'fake/agg-two' }
  const fourth = await collect(adapter.stream({
    provider: 'moa', model: preset.id, sessionId: 'host-session-1', messages: extended, system: 'sys',
    replayState: third.at(-1).replayState,
  }))
  const scopeFour = fourth.at(-1).replayState.response.scope
  assert.notEqual(scopeFour, scopeThree, 'a route switch must change the aggregator scope')
  const forwarded = runtime.calls.at(-1).options
  assert.equal(forwarded.model, 'fake/agg-two')
  for (const message of forwarded.messages.filter((entry) => entry.role === 'assistant' && entry.source?.provider === 'moa')) {
    assert.equal(Object.prototype.hasOwnProperty.call(message, 'replayState'), false, 'replay state from another route must be stripped')
  }

  // Tool messages and sources must pass through untouched.
  const toolForwarded = forwarded.messages.find((message) => message.role === 'tool')
  assert.deepEqual(toolForwarded.content, snapshot[2].content)
  assert.deepEqual(toolForwarded.source, snapshot[2].source)
  assert.deepEqual(messages, snapshot, 'the adapter must never mutate the host messages')
  assert.notEqual(forwarded.messages, messages)
})

test('aggregator transcript keeps only the current route advice, newest copy, for A-B-A', { timeout: 25000 }, async () => {
  const runtime = makeRuntime(() => ({ text: 'aggregator reply' }), { auto: true })
  const preset = makePreset({ references: [reference('ref-a')], aggregator: { provider: FAKE_PROVIDER, model: 'fake/agg-a' } })
  const routeA = adviceRouteKey(preset)
  preset.aggregator = { provider: FAKE_PROVIDER, model: 'fake/agg-b' }
  const routeB = adviceRouteKey(preset)
  preset.aggregator = { provider: FAKE_PROVIDER, model: 'fake/agg-a' }
  assert.equal(adviceRouteKey(preset), routeA)

  const routeAOld = makeAdviceMessage('route A advice v1', { preset: preset.id, routeKey: routeA })
  const routeADupe = makeAdviceMessage('route A advice v1', { preset: preset.id, routeKey: routeA })
  const routeBAdvice = makeAdviceMessage('route B advice', { preset: preset.id, routeKey: routeB })
  const routeANew = makeAdviceMessage('route A advice v2', { preset: preset.id, routeKey: routeA })
  const history = [
    userMessage('u1', 'question'),
    routeAOld,
    routeADupe,
    assistantMessage('a1', 'answer one'),
    userMessage('u2', 'question two'),
    routeBAdvice,
    assistantMessage('a2', 'answer two'),
    userMessage('u3', 'question three'),
    routeANew,
    { id: 't2', role: 'tool', content: [{ type: 'tool-result', text: 'tool output' }], source: { kind: 'tool' } },
  ]
  const ids = history.map((message) => message.id)

  const selected = selectAdviceForAggregator(history, preset, 'latest')
  const kept = selected.filter((message) => message.source?.kind === 'plugin:moa')
  assert.equal(kept.length, 1, 'only one advice copy may survive into one aggregator turn')
  assert.equal(contentToText(kept[0].content), 'route A advice v2', 'the newest copy of the current route is the one kept')
  assert.equal(selected.filter((message) => message.role === 'tool').length, 1, 'tool messages must survive selection')
  assert.deepEqual(history.map((message) => message.id), ids, 'selection must not mutate the host history')

  // The same selection is what the adapter forwards to the aggregator.
  const adapter = createMoaAdapter({ runtime, presets: new Map([[preset.id, preset]]), config: makeConfig(preset.id) })
  await collect(adapter.stream({ provider: 'moa', model: preset.id, sessionId: 'host-session-2', messages: history, system: 'sys' }))
  const forwarded = runtime.calls[0].options.messages
  const forwardedAdvice = forwarded.filter((message) => message.source?.kind === 'plugin:moa')
  assert.equal(forwardedAdvice.length, 1)
  assert.equal(contentToText(forwardedAdvice[0].content), 'route A advice v2')
  assert.equal(forwarded.filter((message) => message.role === 'tool').length, 1, 'tool messages must reach the aggregator')
  const toolMessage = forwarded.find((message) => message.role === 'tool')
  assert.deepEqual(toolMessage.source, { kind: 'tool' }, 'tool sources must not be rewritten')
})

test('two presets sharing one aggregator provider/model keep the main session id but distinct replay scopes', { timeout: 25000 }, async () => {
  const runtime = makeRuntime(() => ({ text: 'aggregator reply' }), { auto: true })
  const presetOne = makePreset({ id: 'preset-one', aggregator: { provider: FAKE_PROVIDER, model: 'fake/shared' } })
  const presetTwo = makePreset({ id: 'preset-two', aggregator: { provider: FAKE_PROVIDER, model: 'fake/shared' } })
  const adapter = createMoaAdapter({
    runtime,
    presets: new Map([[presetOne.id, presetOne], [presetTwo.id, presetTwo]]),
    config: makeConfig(presetOne.id),
  })
  const messages = [userMessage('u1', 'question')]
  await collect(adapter.stream({ provider: 'moa', model: presetOne.id, sessionId: 'host-1', messages, system: 'sys' }))
  await collect(adapter.stream({ provider: 'moa', model: presetTwo.id, sessionId: 'host-1', messages, system: 'sys' }))
  await collect(adapter.stream({ provider: 'moa', model: presetOne.id, sessionId: 'host-1', messages, system: 'sys' }))
  const [oneA, twoA, oneB] = runtime.calls.map((call) => call.options.sessionId)
  assert.equal(oneA, 'host-1')
  assert.equal(twoA, 'host-1')
  assert.equal(oneB, oneA, 'the same preset must keep a stable aggregator session id')
})

// ---------------------------------------------------------------------------
// 8. identity contract used for slot naming
// ---------------------------------------------------------------------------

test('slot identity is derived from session, provider/model, dialogue and slot id', () => {
  const base = { sessionId: 's', provider: 'p', model: 'm', dialogueKey: 'k', slotId: '0', cacheScope: '' }
  const same = dialogueIdentity({ ...base })
  assert.equal(dialogueIdentity({ ...base }), same, 'identity must be deterministic')
  assert.notEqual(dialogueIdentity({ ...base, slotId: '1' }), same, 'slot index must separate identities')
  assert.notEqual(dialogueIdentity({ ...base, sessionId: 's2' }), same, 'session must separate identities')
  assert.notEqual(dialogueIdentity({ ...base, model: 'm2' }), same, 'model must separate identities')
  assert.notEqual(dialogueIdentity({ ...base, cacheScope: 'x' }), same, 'cache scope must separate identities')
})