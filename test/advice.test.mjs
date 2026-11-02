import assert from 'node:assert/strict'
import { createAdviceEngine, reviewVerdict } from '../advice.js'
import { createDialogueStore } from '../dialogue.js'
import { normalizeConfig } from '../config.js'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

function message(id, text, kind = 'user', role = 'user') {
  return { id, role, content: [{ type: 'text', text }], source: { kind } }
}

function fakeSession(history, model = 'test') {
  return {
    header: { id: 'session-test' },
    seq: 1,
    eventAt(index) {
      if (index !== 0) throw new Error('missing event')
      return { type: 'model/selection', data: { provider: 'moa', model } }
    },
    deriveMessages() { return history },
  }
}

function preset(overrides = {}) {
  return {
    id: 'test',
    label: 'Test',
    fanout: 'user_turn',
    references: [
      { id: 'a', provider: 'fake', model: 'ref-a', label: 'A', reasoningEffort: 'high', maxTokens: 1000 },
      { id: 'b', provider: 'fake', model: 'ref-b', label: 'B', maxTokens: 1000 },
    ],
    aggregator: { provider: 'fake', model: 'agg', reasoningEffort: 'high' },
    referenceMaxTokens: 1000,
    referenceTimeoutMs: 10000,
    deadlineMs: 20000,
    ...overrides,
  }
}

function runtimeWith(behaviour = {}) {
  const calls = []
  const counts = new Map()
  return {
    calls,
    stream(options) {
      calls.push(options)
      const key = options.model
      const count = (counts.get(key) || 0) + 1
      counts.set(key, count)
      return (async function * () {
        const action = typeof behaviour === 'function'
          ? behaviour(options, count)
          : options.provider === 'moa'
            ? behaviour.agg
            : behaviour[key]
        if (action?.error && (!action.once || count === 1)) throw new Error(action.error)
        const text = typeof action === 'string' ? action : action?.text ?? `answer from ${key}`
        if (text) yield { type: 'text-delta', text }
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

async function engineFor(runtime, presetValue = preset(), configOverrides = {}, kv = null) {
  const config = normalizeConfig({
    defaultPreset: presetValue.id,
    referenceSchedule: 'parallel',
    persistentTags: [],
    ...configOverrides,
  })
  const store = createDialogueStore({ kv: null, persistentTags: config.persistentTags })
  await store.load()
  const presets = new Map([[presetValue.id, presetValue]])
  const engine = createAdviceEngine({ runtime, store, presets, config, log: null, kv })
  await engine.load()
  return { engine, store, config }
}

function payloadFor(session, turn = 1, step = 1) {
  return { agent: { session }, turn, step, signal: new AbortController().signal }
}

function enter(messages = []) { return { kind: 'enter', messages, startsRequestSeries: true } }

test('user_turn injects logged advice once and fans out again for a new user turn', async () => {
  const runtime = runtimeWith({ 'ref-a': 'A advice', 'ref-b': 'B advice' })
  const { engine } = await engineFor(runtime)
  const history = [message('u1', 'solve the task')]
  const session = fakeSession(history)
  const first = await engine.preStep(payloadFor(session), async () => enter())
  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].source.kind, 'plugin:moa')
  assert.equal(first.messages[0].source.turnHash.length, 64)
  assert.match(first.messages[0].content[0].text, /A advice/)
  assert.match(first.messages[0].content[0].text, /B advice/)
  assert.equal(runtime.calls.length, 2)
  assert.equal(first.startsRequestSeries, true)
  assert.ok(runtime.calls.every((call) => call.tools === undefined))

  history.push(first.messages[0])
  const second = await engine.preStep(payloadFor(session, 1, 2), async () => enter())
  assert.equal(second.messages.length, 0)
  assert.equal(runtime.calls.length, 2)

  history.push(message('tool-1', 'real result', 'tool', 'tool'))
  const third = await engine.preStep(payloadFor(session, 1, 3), async () => enter())
  assert.equal(third.messages.length, 0)
  assert.equal(runtime.calls.length, 2)

  history.push(message('u2', 'new request'))
  const fourth = await engine.preStep(payloadFor(session, 2, 1), async () => enter())
  assert.equal(fourth.messages.length, 1)
  assert.equal(fourth.messages[0].source.cached, false)
  assert.equal(runtime.calls.length, 4)
})

test('every_n reuses cached advice off cadence without duplicating logged advice', async () => {
  const runtime = runtimeWith((options, count) => ({ text: `${options.model} advice ${count}` }))
  const { engine } = await engineFor(runtime, preset({ fanout: 'every_n:2' }))
  const history = [message('u1', 'task')]
  const session = fakeSession(history)
  const first = await engine.preStep(payloadFor(session), async () => enter())
  history.push(first.messages[0])
  history.push(message('a1', 'working', 'model', 'assistant'))
  const second = await engine.preStep(payloadFor(session, 1, 2), async () => enter())
  assert.equal(second.messages.length, 0)
  assert.equal(runtime.calls.length, 2)
  history.push(message('tool-1', 'result', 'tool', 'tool'))
  const third = await engine.preStep(payloadFor(session, 1, 3), async () => enter())
  assert.equal(third.messages.length, 1)
  assert.equal(third.messages[0].source.cached, false)
  assert.equal(runtime.calls.length, 4)
})

test('guard quarantines fake execution before advice reaches the acting agent', async () => {
  const runtime = runtimeWith({ 'ref-a': '<tool_call>bash rm -rf x</tool_call>', 'ref-b': '建议：检查真实工具输出' })
  const { engine } = await engineFor(runtime)
  const session = fakeSession([message('u1', 'task')])
  const result = await engine.preStep(payloadFor(session), async () => enter())
  const text = result.messages[0].content[0].text
  assert.doesNotMatch(text, /<tool_call>/)
  assert.match(text, /建议：检查真实工具输出/)
  assert.match(text, /quarantine|quarantined|隔离|failed/)
})

test('empty reference output is reported; maxTokens and effort are never raised or dropped', async () => {
  const runtime = runtimeWith((options) => (options.model === 'ref-a' ? { text: '' } : { text: 'unused' }))
  const base = preset().references[0]
  const { engine } = await engineFor(runtime, preset({ references: [{ ...base, maxTokens: 900 }] }))
  const session = fakeSession([message('u1', 'task')])
  const result = await engine.preStep(payloadFor(session), async () => enter())
  const refCalls = runtime.calls.filter((call) => call.model === 'ref-a')
  assert.equal(refCalls.length, 1, 'no hidden second call with a larger budget')
  assert.equal(refCalls[0].reasoningEffort, 'high')
  assert.equal(refCalls[0].maxTokens, 900)
  assert.match(result.messages[0].content[0].text, /empty response within maxTokens 900/)
})

test('transient reference failure retries once and probe calls the aggregator', async () => {
  const runtime = runtimeWith({
    'ref-a': { text: 'A advice', error: 'overloaded', once: true },
    'ref-b': 'B advice',
    agg: 'synthesised answer',
  })
  const { engine } = await engineFor(runtime)
  const probe = await engine.probe({ preset: 'test', prompt: 'question' })
  assert.equal(probe.ok, true)
  assert.equal(probe.reply, 'synthesised answer')
  assert.equal(probe.references.length, 2)
  assert.equal(runtime.calls.filter((call) => call.model === 'ref-a').length, 2)
  assert.equal(runtime.calls.at(-1).provider, 'moa')
  assert.equal(runtime.calls.at(-1).model, 'test')
  assert.equal(probe.usage.totalTokens, 5)
})

test('persistent advisor wire supplies assistant source metadata required by DSH', async () => {
  const reference = { id: 'claude', provider: 'fake', model: 'claude-tui/ref-a', label: 'Claude', maxTokens: 1000 }
  const runtime = runtimeWith({ 'claude-tui/ref-a': 'persistent advice' })
  const { engine } = await engineFor(runtime, preset({ references: [reference] }), { persistentTags: ['claude'] })
  const session = fakeSession([message('u1', 'task')])
  const result = await engine.preStep(payloadFor(session), async () => enter())
  assert.match(result.messages[0].content[0].text, /persistent advice/)
  const call = runtime.calls.find((item) => item.model === 'claude-tui/ref-a')
  const assistant = call.messages.find((item) => item.role === 'assistant')
  assert.ok(assistant)
  assert.deepEqual(assistant.source, { kind: 'model', provider: 'fake', model: 'claude-tui/ref-a' })
  assert.ok(Array.isArray(assistant.content))
})

test('cancel suppresses late advice from an abandoned generation', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const runtime = {
    calls: [],
    stream(options) {
      runtime.calls.push(options)
      return (async function * () {
        await gate
        yield { type: 'text-delta', text: 'late advice' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const { engine } = await engineFor(runtime)
  const session = fakeSession([message('u1', 'task')])
  const pending = engine.preStep(payloadFor(session), async () => enter())
  for (let i = 0; i < 20 && runtime.calls.length < 2; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runtime.calls.length, 2)
  engine.cancel('session-test', 'test cancellation')
  release()
  const result = await pending
  assert.equal(result.messages.length, 0)
})

test('non-MoA routes are untouched', async () => {
  const runtime = runtimeWith()
  const { engine } = await engineFor(runtime)
  const session = fakeSession([message('u1', 'task')])
  session.eventAt = () => ({ type: 'model/selection', data: { provider: 'other', model: 'test' } })
  const decision = enter([message('pending', 'pending')])
  const result = await engine.preStep(payloadFor(session), async () => decision)
  assert.equal(result, decision)
  assert.equal(runtime.calls.length, 0)
})

test('per_iteration keeps a pending async fan-out and harvests it before starting another', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const runtime = {
    calls: [],
    stream(options) {
      runtime.calls.push(options)
      return (async function * () {
        await gate
        yield { type: 'text-delta', text: 'slow async advice' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const reference = { ...preset().references[0], async: true }
  const { engine, store } = await engineFor(runtime, preset({ fanout: 'per_iteration', references: [reference] }))
  const history = [message('u1', 'task')]
  const session = fakeSession(history)
  try {
    const first = await engine.preStep(payloadFor(session), async () => enter())
    assert.equal(first.messages.length, 0)
    for (let i = 0; i < 20 && !runtime.calls.length; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(runtime.calls.length, 1)
    history.push(message('a1', 'actor continued', 'model', 'assistant'))
    const second = await engine.preStep(payloadFor(session, 1, 2), async () => enter())
    assert.equal(second.messages.length, 0)
    assert.equal(runtime.calls.length, 1, 'a pending same-turn advisor must not be restarted')
    assert.equal(runtime.calls[0].signal.aborted, false)
    release()
    for (let i = 0; i < 20 && engine.stats().backgroundFanouts; i++) await new Promise(resolve => setImmediate(resolve))
    history.push(message('tool-1', 'actual tool result', 'tool', 'tool'))
    const third = await engine.preStep(payloadFor(session, 1, 3), async () => enter())
    assert.equal(third.messages.length, 1)
    assert.match(third.messages[0].content[0].text, /slow async advice/)
    assert.equal(runtime.calls.length, 1, 'completed advice must be harvested before its token is replaced')
  } finally {
    release()
    await engine.close()
    await store.close()
  }
})

test('an empty reply is final; a transient failure gets one retry', async () => {
  for (const [failures, expected] of [[['empty', 'overloaded'], 1], [['overloaded', 'empty'], 2]]) {
    const runtime = {
      calls: [],
      stream(options) {
        const index = runtime.calls.push(options) - 1
        return (async function * () {
          const failure = failures[index]
          if (failure === 'overloaded') throw new Error(failure)
          if (failure !== 'empty') yield { type: 'text-delta', text: 'unexpected third request' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const { engine, store } = await engineFor(runtime, preset({ references: [preset().references[0]] }))
    try {
      await engine.preStep(payloadFor(fakeSession([message('u1', 'task')])), async () => enter())
      assert.equal(runtime.calls.length, expected, failures.join(' then '))
      const reference = engine.recentRuns().find(run => run.references?.length)?.references[0]
      assert.equal(reference.ok, false)
      assert.equal(reference.attempts, expected)
      assert.equal(store.stats().persistentRecords, 0)
    } finally {
      await engine.close()
      await store.close()
    }
  }
})

function strictCadenceKv() {
  const records = {}
  const keyCheck = (table, key) => {
    assert.equal(table, 'cadence')
    assert.match(key, /^[a-zA-Z0-9_-]+$/, 'backend keys must be path-safe')
  }
  return {
    records,
    async loadAll() { return { tables: { cadence: structuredClone(records) } } },
    async putRecord(table, key, value) { keyCheck(table, key); records[key] = structuredClone(value) },
    async deleteRecord(table, key) { keyCheck(table, key); delete records[key] },
  }
}

test('opaque session ids persist and reload cadence without losing delivered advice', async () => {
  const kv = strictCadenceKv()
  const runtime = runtimeWith()
  const session = fakeSession([message('u1', 'task')])
  session.header.id = 'cache-moa:claude/opaque-session'
  const first = await engineFor(runtime, preset(), {}, kv)
  const decision = await first.engine.preStep(payloadFor(session), async () => enter())
  assert.equal(decision.messages.length, 1, 'successful references must reach the actor with a filesystem KV backend')
  const keys = Object.keys(kv.records)
  assert.equal(keys.length, 1)
  assert.match(keys[0], /^[a-f0-9]{64}$/)
  assert.equal(kv.records[keys[0]].sessionId, session.header.id)
  session.deriveMessages().push(decision.messages[0])
  await first.engine.close()
  await first.store.close()
  const restored = await engineFor(runtime, preset(), {}, kv)
  try {
    const repeated = await restored.engine.preStep(payloadFor(session, 1, 2), async () => enter())
    assert.equal(repeated.messages.length, 0)
    assert.equal(runtime.calls.length, 2, 'reloaded cadence must reuse the completed fan-out')
    await restored.engine.clear(session.header.id)
    assert.deepEqual(kv.records, {})
  } finally {
    await restored.engine.close()
    await restored.store.close()
  }
})

test('legacy raw session cadence loads, migrates on write and clears through physical keys', async () => {
  const kv = strictCadenceKv()
  const runtime = runtimeWith()
  const history = [message('u1', 'task')]
  const session = fakeSession(history)
  const initial = await engineFor(runtime, preset(), {}, kv)
  const first = await initial.engine.preStep(payloadFor(session), async () => enter())
  history.push(first.messages[0])
  const [hashed] = Object.keys(kv.records)
  const legacy = { ...kv.records[hashed] }
  delete legacy.sessionId
  delete kv.records[hashed]
  kv.records[session.header.id] = legacy
  await initial.engine.close()
  await initial.store.close()
  const restored = await engineFor(runtime, preset(), {}, kv)
  try {
    const cached = await restored.engine.preStep(payloadFor(session, 1, 2), async () => enter())
    assert.equal(cached.messages.length, 0)
    assert.equal(runtime.calls.length, 2)
    assert.equal(kv.records[session.header.id], undefined, 'old physical key must be removed after migration')
    assert.equal(Object.keys(kv.records).length, 1)
    assert.match(Object.keys(kv.records)[0], /^[a-f0-9]{64}$/)
    await restored.engine.clear()
    assert.deepEqual(kv.records, {})
  } finally {
    await restored.engine.close()
    await restored.store.close()
  }
})

// ---------------------------------------------------------------------------
// 0.6: smart scheduling and end-of-turn review

function growingSession(id = 'session-test') {
  const history = [message('u1', 'task')]
  const session = fakeSession(history)
  session.header.id = id
  return { session, history }
}

async function schedulerEngine(verdicts, schedulerConfig = {}) {
  const runtime = runtimeWith({ 'ref-a': 'A advice', 'ref-b': 'B advice' })
  const asked = []
  const scheduler = {
    async decide(input) {
      asked.push(input)
      const due = verdicts.shift() ?? false
      return { due, reason: due ? 'smart-model-boundary' : 'smart-model-continue', score: due ? 0.9 : 0.1, ms: 1 }
    },
  }
  const value = preset({ fanout: 'smart', scheduler: { kind: 'model', provider: 'fake', model: 'small', threshold: 0.6, minGap: 2, maxGap: 4, timeoutMs: 1000, stateChars: 6000, ...schedulerConfig } })
  const config = normalizeConfig({ defaultPreset: value.id, referenceSchedule: 'parallel', persistentTags: [] })
  const store = createDialogueStore({ kv: null, persistentTags: [] })
  await store.load()
  const engine = createAdviceEngine({ runtime, store, presets: new Map([[value.id, value]]), config, log: null, kv: null, scheduler })
  await engine.load()
  return { runtime, engine, asked }
}

test('smart: consults at turn start, respects minGap, asks the scheduler, forces at maxGap', async () => {
  const { runtime, engine, asked } = await schedulerEngine([false, true, false, false])
  const { session, history } = growingSession()
  const refCalls = () => runtime.calls.filter(call => call.model === 'ref-a').length
  await engine.preStep(payloadFor(session, 1, 1), async () => enter())
  assert.equal(refCalls(), 1, 'turn start consults')
  const step = async (n) => {
    history.push(message(`t${n}`, `tool output ${n}`, 'tool', 'tool'))
    await engine.preStep(payloadFor(session, 1, n), async () => enter())
  }
  await step(2) // sinceLast 1 < minGap 2 → no ask
  assert.equal(asked.length, 0)
  await step(3) // sinceLast 2 → ask → false
  assert.equal(asked.length, 1)
  assert.equal(refCalls(), 1)
  await step(4) // ask → true → consult
  assert.equal(asked.length, 2)
  assert.equal(refCalls(), 2)
  assert.ok(!asked[0].state.text.includes('\u0000'))
  await step(5); await step(6) // sinceLast 1 then 2 → ask false
  await step(7) // ask false (sinceLast 3)
  await step(8) // sinceLast 4 = maxGap → forced without asking
  assert.equal(refCalls(), 3, 'maxGap forces a consultation')
  assert.equal(asked.length, 4)
  const schedules = engine.recentRuns().filter(run => run.kind === 'schedule')
  assert.equal(schedules.length, 4)
  await engine.close()
})

test('smart: a failing scheduler means "not now", never an exception', async () => {
  const runtime = runtimeWith({ 'ref-a': 'A advice', 'ref-b': 'B advice' })
  const value = preset({ fanout: 'smart', scheduler: { kind: 'jev', apiKeyEnv: 'MOA_TEST_MISSING_KEY', threshold: 0.6, minGap: 1, maxGap: 50, timeoutMs: 1000, stateChars: 6000 } })
  const config = normalizeConfig({ defaultPreset: value.id, referenceSchedule: 'parallel', persistentTags: [] })
  const store = createDialogueStore({ kv: null, persistentTags: [] })
  await store.load()
  const engine = createAdviceEngine({ runtime, store, presets: new Map([[value.id, value]]), config, log: null, kv: null, env: {} })
  const { session, history } = growingSession()
  await engine.preStep(payloadFor(session, 1, 1), async () => enter())
  history.push(message('t2', 'tool output', 'tool', 'tool'))
  const result = await engine.preStep(payloadFor(session, 1, 2), async () => enter())
  assert.equal(result.kind, 'enter')
  const run = engine.recentRuns().find(entry => entry.kind === 'schedule')
  assert.equal(run.reason, 'smart-scheduler-error')
  assert.match(run.error, /MOA_TEST_MISSING_KEY is not set/)
  assert.equal(runtime.calls.filter(call => call.model === 'ref-a').length, 1)
  await engine.close()
})

async function reviewEngine(replies) {
  const runtime = runtimeWith((options) => ({ text: replies[options.model] }))
  const value = preset({ fanout: 'user_turn_end' })
  const config = normalizeConfig({ defaultPreset: value.id, referenceSchedule: 'parallel', persistentTags: [] })
  const store = createDialogueStore({ kv: null, persistentTags: [] })
  await store.load()
  const engine = createAdviceEngine({ runtime, store, presets: new Map([[value.id, value]]), config, log: null, kv: null })
  return { runtime, engine }
}

test('user_turn_end: REVISE review is injected once per turn into the same turn', async () => {
  const { runtime, engine } = await reviewEngine({ 'ref-a': 'VERDICT: REVISE\n- the test was not run', 'ref-b': 'VERDICT: PASS' })
  const { session } = growingSession()
  const injected = []
  const agent = { session, inject(message) { injected.push(message) } }
  await engine.turnStopping({ agent, turn: 3, signal: new AbortController().signal })
  assert.equal(injected.length, 1)
  const review = injected[0]
  assert.equal(review.role, 'user')
  assert.equal(review.source.kind, 'plugin:moa')
  assert.equal(review.source.form, 'review')
  assert.match(review.content[0].text, /Final QA review/)
  assert.match(review.content[0].text, /the test was not run/)
  assert.doesNotMatch(review.content[0].text, /VERDICT: PASS/, 'only REVISE opinions are forwarded')
  const prompts = runtime.calls.map(call => JSON.stringify(call.messages))
  assert.ok(prompts.every(text => text.includes('VERDICT: PASS')), 'review suffix asks for a verdict')
  await engine.turnStopping({ agent, turn: 3, signal: new AbortController().signal })
  assert.equal(injected.length, 1, 'one review per turn, so the revision step can close the turn')
  assert.equal(engine.recentRuns().filter(run => run.kind === 'review').length, 1)
  await engine.close()
})

test('user_turn_end: all PASS lets the turn close; other cadences never review', async () => {
  const { engine } = await reviewEngine({ 'ref-a': 'VERDICT: PASS', 'ref-b': 'verdict: pass — fine' })
  const { session } = growingSession()
  const injected = []
  await engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 1, signal: new AbortController().signal })
  assert.equal(injected.length, 0)
  assert.equal(engine.recentRuns().find(run => run.kind === 'review').verdict, 'pass')
  await engine.close()

  const runtime = runtimeWith({})
  const { engine: plain } = await engineFor(runtime)
  await plain.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 1, signal: new AbortController().signal })
  assert.equal(runtime.calls.length, 0)
  await plain.close()
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('review verdict parser: only the first content line decides, markdown wrappers included', () => {
  assert.equal(reviewVerdict('VERDICT: PASS'), 'PASS')
  assert.equal(reviewVerdict('**VERDICT: PASS**'), 'PASS', 'emphasis around the whole line is not a REVISE')
  assert.equal(reviewVerdict('```\nVERDICT: PASS\n```'), 'PASS', 'a fenced verdict still counts')
  assert.equal(reviewVerdict('### VERDICT: REVISE\n- fix the failing test'), 'REVISE')
  assert.equal(reviewVerdict('> **Verdict:** pass — nothing important'), 'PASS')
  assert.equal(reviewVerdict('VERDICT：PASS'), 'PASS', 'a fullwidth colon is a colon')
  assert.equal(reviewVerdict('- VERDICT: PASS'), 'PASS')
  assert.equal(reviewVerdict('-verdict: revise'), 'REVISE')
  // A later quote of PASS is not this review's conclusion.
  assert.equal(reviewVerdict('VERDICT: REVISE\nThe earlier draft said "VERDICT: PASS", but tests fail'), 'REVISE')
  assert.equal(reviewVerdict('VERDICT: PASS\nThe earlier draft said VERDICT: REVISE'), 'PASS')
  // Prose that merely mentions a verdict is unreadable, never an approval.
  assert.equal(reviewVerdict('I would say VERDICT: PASS, but check line 3'), null)
  assert.equal(reviewVerdict(''), null)
  assert.equal(reviewVerdict('   \n\t'), null)
})

test('user_turn_end: a markdown-wrapped PASS closes the turn without injecting', async () => {
  const { engine } = await reviewEngine({ 'ref-a': '**VERDICT: PASS**', 'ref-b': '```\nVERDICT: PASS\n```' })
  const { session } = growingSession()
  const injected = []
  await engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 2, signal: new AbortController().signal })
  assert.equal(injected.length, 0, 'a fenced or emphasized PASS is still a PASS')
  assert.equal(engine.recentRuns().find(run => run.kind === 'review').verdict, 'pass')
  await engine.close()
})

test('user_turn_end: a PASS quoted after the verdict does not cancel a REVISE', async () => {
  const { engine } = await reviewEngine({
    'ref-a': 'VERDICT: REVISE\nThe earlier draft said "VERDICT: PASS", but the test was never run.',
    'ref-b': 'VERDICT: PASS',
  })
  const { session } = growingSession()
  const injected = []
  await engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 2, signal: new AbortController().signal })
  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /never run/)
  const run = engine.recentRuns().find(entry => entry.kind === 'review')
  assert.equal(run.verdict, 'revise')
  assert.equal(run.references.filter(reference => reference.ok).length, 2)
  await engine.close()
})

test('a failing review is unavailable, injects nothing and never blocks the turn', async () => {
  const runtime = runtimeWith(() => ({ error: 'review transport down' }))
  const value = preset({ fanout: 'user_turn_end' })
  const { engine } = await engineFor(runtime, value)
  const { session } = growingSession()
  const injected = []
  await engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 1, signal: new AbortController().signal })
  assert.equal(injected.length, 0, 'a failed review must not be reported as PASS or as advice')
  const run = engine.recentRuns().find(entry => entry.kind === 'review')
  assert.equal(run.verdict, 'unavailable')
  await engine.close()
})

function hangingRuntime() {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function * () {
        // AbortSignal.timeout keeps its timer unref'd, so the fixture holds a live
        // timer of its own: the process would otherwise exit before the deadline.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('reference transport never finished')), 30000)
          const aborted = () => { clearTimeout(timer); reject(new Error('transport aborted')) }
          if (!options.signal) return aborted()
          if (options.signal.aborted) return aborted()
          options.signal.addEventListener('abort', aborted, { once: true })
        })
      })()
    },
  }
}

test('the review gives up at its own short deadline and reports unavailable', async () => {
  const runtime = hangingRuntime()
  const { engine, store } = await engineFor(runtime, preset({ fanout: 'user_turn_end' }), { reviewTimeoutMs: 1000 })
  const { session } = growingSession()
  const injected = []
  const started = Date.now()
  await engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 4, signal: new AbortController().signal })
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 900, `the review ran inside its own budget (${elapsed}ms)`)
  assert.ok(elapsed < 5000, `the review did not inherit the whole-round deadline (${elapsed}ms)`)
  assert.equal(injected.length, 0)
  const run = engine.recentRuns().find(entry => entry.kind === 'review')
  assert.equal(run.verdict, 'unavailable', 'a timed-out review is neither PASS nor advice')
  assert.equal(run.budgetMs, 1000)
  await engine.close()
  await store.close()
})

test('a running async reference and the QA review never share the slot', async () => {
  let open
  const gate = new Promise(resolve => { open = resolve })
  const calls = []
  const runtime = {
    calls,
    stream(options) {
      calls.push(options)
      return (async function * () {
        if (options.model === 'ref-a') await gate
        yield { type: 'text-delta', text: 'VERDICT: PASS' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const value = preset({
    fanout: 'user_turn_end',
    // Background delivery: the pre-step returns while reference A still holds its slot.
    delivery: 'background',
    references: [
      { id: 'a', provider: 'fake', model: 'ref-a', label: 'A', async: true },
      { id: 'b', provider: 'fake', model: 'ref-b', label: 'B' },
    ],
  })
  const { engine } = await engineFor(runtime, value)
  const { session } = growingSession()
  await engine.preStep(payloadFor(session, 1, 1), async () => enter())
  const refACalls = () => calls.filter(call => call.model === 'ref-a').length
  const waitStart = Date.now()
  while (refACalls() === 0 && Date.now() - waitStart < 2000) await sleep(10)
  assert.equal(refACalls(), 1, 'the async advice call holds the slot')

  const injected = []
  const pending = engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 2, signal: new AbortController().signal })
  await sleep(80)
  assert.equal(refACalls(), 1, 'the review waits for the in-flight slot instead of racing the same reference')
  assert.equal(engine.recentRuns().filter(run => run.kind === 'review').length, 0)
  open()
  await pending
  assert.equal(refACalls(), 2, 'the review runs after the async reference releases the slot')
  assert.equal(engine.recentRuns().find(run => run.kind === 'review').verdict, 'pass')
  assert.equal(injected.length, 0)
  await engine.close()
})

test('review dedupe without a turn counter anchors on the last real user message', async () => {
  const { engine, runtime } = await reviewEngine({ 'ref-a': 'VERDICT: PASS', 'ref-b': 'VERDICT: PASS' })
  const { session } = growingSession()
  const agent = { session, inject() {} }
  await engine.turnStopping({ agent, signal: new AbortController().signal })
  assert.equal(runtime.calls.length, 2, 'the anchored review runs once')
  await engine.turnStopping({ agent, signal: new AbortController().signal })
  assert.equal(runtime.calls.length, 2, 'a repeated hook without a turn counter is not a new turn')
  await engine.clear(session.header.id)
  await engine.turnStopping({ agent, signal: new AbortController().signal })
  assert.equal(runtime.calls.length, 4, 'clearing the session starts turn tracking over')
  await engine.close()
})

test('a Stop cancels an in-flight review even on a Claude route, and an aborted hook never reviews', async () => {
  let aborted = 0
  const calls = []
  const runtime = {
    calls,
    stream(options) {
      calls.push(options)
      return (async function * () {
        await new Promise((resolve, reject) => {
          if (options.signal?.aborted) return reject(new Error('transport aborted'))
          options.signal?.addEventListener('abort', () => { aborted += 1; reject(new Error('transport aborted')) }, { once: true })
        })
      })()
    },
  }
  const value = preset({
    fanout: 'user_turn_end',
    references: [{ id: 'a', provider: 'anthropic', model: 'claude-sonnet', label: 'Claude' }],
  })
  const { engine } = await engineFor(runtime, value)
  const { session } = growingSession()
  const controller = new AbortController()
  const injected = []
  const started = Date.now()
  const pending = engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 1, signal: controller.signal })
  await sleep(60)
  controller.abort()
  await pending
  assert.ok(Date.now() - started < 2000, 'Stop releases the turn instead of draining the review')
  assert.equal(aborted, 1, 'the review transport was actually cancelled')
  assert.equal(injected.length, 0)
  assert.equal(engine.recentRuns().filter(run => run.kind === 'review').length, 0, 'an aborted review records no verdict')

  const preAborted = new AbortController()
  preAborted.abort()
  await engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 2, signal: preAborted.signal })
  assert.equal(calls.length, 1, 'an already-aborted hook does not start a review')
  await engine.close()
})

test('the review budget also covers waiting for a slot held by an async reference', async () => {
  let open
  const gate = new Promise(resolve => { open = resolve })
  const calls = []
  // AbortSignal.timeout is unref'd, so the fixture holds a live timer of its own:
  // the process would otherwise drain before the review budget can expire.
  const keepAlive = setTimeout(() => {}, 30000)
  const runtime = {
    calls,
    stream(options) {
      calls.push(options)
      return (async function * () {
        if (options.model === 'ref-a') await gate
        yield { type: 'text-delta', text: 'VERDICT: PASS' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const value = preset({
    fanout: 'user_turn_end',
    references: [{ id: 'a', provider: 'fake', model: 'ref-a', label: 'A', async: true }],
    deadlineMs: 60000,
  })
  const config = normalizeConfig({
    defaultPreset: value.id, referenceSchedule: 'parallel', persistentTags: [], reviewTimeoutMs: 1000,
  })
  const store = createDialogueStore({ kv: null, persistentTags: [] })
  await store.load()
  const engine = createAdviceEngine({ runtime, store, presets: new Map([[value.id, value]]), config, log: null, kv: null })
  const { session } = growingSession()
  await engine.preStep(payloadFor(session, 1, 1), async () => enter())
  const refACalls = () => calls.filter(call => call.model === 'ref-a').length
  assert.equal(refACalls(), 1, 'the async advice call holds the slot')

  const injected = []
  const started = Date.now()
  await engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 2, signal: new AbortController().signal })
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 800, `the review waited for the slot inside its own budget (${elapsed}ms)`)
  assert.ok(elapsed < 5000, `the review did not inherit the whole-round deadline (${elapsed}ms)`)
  assert.equal(injected.length, 0)
  assert.equal(refACalls(), 1, 'the review never dispatched behind the held slot')
  const run = engine.recentRuns().find(entry => entry.kind === 'review')
  assert.equal(run.verdict, 'unavailable', 'a slot that never freed up in budget is not a PASS')
  open()
  await sleep(20)
  clearTimeout(keepAlive)
  await engine.close()
})

test('user_turn_end: one failed reference makes the verdict unavailable, never PASS', async () => {
  const runtime = runtimeWith({ 'ref-a': 'VERDICT: PASS', 'ref-b': { error: 'transport exploded' } })
  const value = preset({ fanout: 'user_turn_end' })
  const config = normalizeConfig({ defaultPreset: value.id, referenceSchedule: 'parallel', persistentTags: [] })
  const store = createDialogueStore({ kv: null, persistentTags: [] })
  await store.load()
  const engine = createAdviceEngine({ runtime, store, presets: new Map([[value.id, value]]), config, log: null, kv: null })
  const { session } = growingSession()
  const injected = []
  await engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 5, signal: new AbortController().signal })
  const run = engine.recentRuns().find(entry => entry.kind === 'review')
  assert.equal(run.verdict, 'unavailable', 'an incomplete panel cannot be reported as PASS')
  assert.equal(injected.length, 0)
  await engine.close()
})

test('a review that finishes after MoA was disabled is not injected', async () => {
  let open
  const gate = new Promise(resolve => { open = resolve })
  const calls = []
  const runtime = {
    calls,
    stream(options) {
      calls.push(options)
      return (async function * () {
        await gate
        yield { type: 'text-delta', text: 'VERDICT: REVISE\n- not verified' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const value = preset({ fanout: 'user_turn_end' })
  const config = normalizeConfig({
    defaultPreset: value.id, referenceSchedule: 'parallel', persistentTags: [], reviewTimeoutMs: 5000,
  })
  const store = createDialogueStore({ kv: null, persistentTags: [] })
  await store.load()
  const engine = createAdviceEngine({ runtime, store, presets: new Map([[value.id, value]]), config, log: null, kv: null })
  const { session } = growingSession()
  const injected = []
  const pending = engine.turnStopping({
    agent: { session, inject: message => injected.push(message) }, turn: 6, signal: new AbortController().signal,
  })
  const waitStart = Date.now()
  while (calls.length < 2 && Date.now() - waitStart < 2000) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(calls.length, 2, 'both references were in flight before the configuration changed')
  config.enabled = false
  open()
  await pending
  const run = engine.recentRuns().find(entry => entry.kind === 'review')
  assert.equal(run.stale, true, 'the run records that its configuration went stale mid-review')
  assert.equal(injected.length, 0, 'a review started before the change cannot inject afterwards')
  await engine.close()
})

test('QA accepts only complete, explicit verdicts', async () => {
  for (const [text, kind] of [['I cannot determine correctness.', 'stop'], ['VERDICT: PASS', 'max-tokens'], ['VERDICT: REVISE\n- fix it', 'max-tokens'], ['VERDICT: PASS', undefined]]) {
    const runtime = { stream: () => (async function* () {
      yield { type: 'text-delta', text }
      if (kind) yield { type: 'finish', reason: { kind } }
    })() }
    const { engine } = await engineFor(runtime, preset({ fanout: 'user_turn_end' }))
    const { session } = growingSession()
    const injected = []
    await engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 1 })
    assert.equal(injected.length, 0)
    assert.equal(engine.recentRuns().find(run => run.kind === 'review').verdict, 'unavailable')
    await engine.close()
  }
})

test('clear and configuration cancellation abort QA and discard late revisions', async () => {
  for (const action of ['clear', 'cancelAll']) {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const calls = []
    const runtime = { stream(options) {
      calls.push(options)
      return (async function* () { await gate; yield { type: 'text-delta', text: 'VERDICT: REVISE\n- late' }; yield { type: 'finish', reason: { kind: 'stop' } } })()
    } }
    const { engine } = await engineFor(runtime, preset({ fanout: 'user_turn_end' }))
    const { session } = growingSession()
    const injected = []
    const pending = engine.turnStopping({ agent: { session, inject: m => injected.push(m) }, turn: 1 })
    while (!calls.length) await sleep(1)
    if (action === 'clear') await engine.clear(session.header.id)
    else engine.cancelAll('configuration changed')
    await pending
    assert.ok(calls.every(call => call.signal.aborted))
    release()
    await engine.close()
    assert.equal(injected.length, 0)
  }
})

test('QA total deadline includes a stalled persistence write', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const tables = { cadence: {} }
  const kv = { loadAll: async () => ({ tables }), putRecord: async (table, key, value) => { await gate; tables[table][key] = value }, deleteRecord: async (table, key) => { delete tables[table][key] } }
  const runtime = runtimeWith({})
  const { engine } = await engineFor(runtime, preset({ fanout: 'user_turn_end' }), { reviewTimeoutMs: 1000 }, kv)
  const { session } = growingSession()
  const keepAlive = setTimeout(() => {}, 5000)
  try {
    const started = Date.now()
    await engine.turnStopping({ agent: { session, inject() { assert.fail('no revision after timeout') } }, turn: 1 })
    assert.ok(Date.now() - started < 2500)
    assert.equal(runtime.calls.length, 0)
    assert.equal(engine.recentRuns().find(run => run.kind === 'review').verdict, 'unavailable')
    release()
    await engine.clear(session.header.id)
    assert.equal(Object.keys(tables.cadence).length, 0)
  } finally { release(); clearTimeout(keepAlive); await engine.close() }
})

test('a persisted review marker prevents reinjection after engine recreation', async () => {
  const tables = { cadence: {} }
  const kv = { loadAll: async () => ({ tables }), putRecord: async (table, key, value) => { tables[table][key] = structuredClone(value) }, deleteRecord: async (table, key) => { delete tables[table][key] } }
  const runtime = runtimeWith({ 'ref-a': 'VERDICT: REVISE\n- check result', 'ref-b': 'VERDICT: PASS' })
  const { session } = growingSession()
  const injected = []
  const agent = { session, inject: m => injected.push(m) }
  for (let i = 0; i < 2; i++) {
    const { engine } = await engineFor(runtime, preset({ fanout: 'user_turn_end' }), {}, kv)
    await engine.turnStopping({ agent, turn: 1 })
    await engine.close()
  }
  assert.equal(injected.length, 1)
  assert.equal(runtime.calls.length, 2)
})

test('bounded reference history reserves dialogue space and appends between window rotations', async () => {
  const runtime = runtimeWith({ 'ref-a': 'short advice' })
  const config = normalizeConfig({ maxDialogueChars: 20000, maxTranscriptChars: 20000, maxMessageChars: 1000, persistentTags: ['*'] })
  const store = createDialogueStore({ maxChars: config.maxDialogueChars, persistentTags: ['*'] })
  const value = preset({ fanout: 'every_n:1', references: [preset().references[0]] })
  const engine = createAdviceEngine({ runtime, store, presets: new Map([[value.id, value]]), config })
  const history = [message('u', 'task'), ...Array.from({ length: 50 }, (_, i) => message(`tool${i}`, 'x'.repeat(800), 'tool', 'tool'))]
  const session = fakeSession(history)
  try {
    await engine.preStep(payloadFor(session, 1, 1), async () => enter())
    history.push(message('new-tool', 'one small new observation', 'tool', 'tool'))
    await engine.preStep(payloadFor(session, 1, 2), async () => enter())
    const runs = engine.recentRuns().filter(run => run.references.length)
    assert.equal(runs.length, 2)
    assert.equal(runs[1].references[0].mode, 'append')
    assert.ok(JSON.stringify(runtime.calls[1].messages).length < config.maxDialogueChars)
    assert.equal(runtime.calls[0].sessionId, runtime.calls[1].sessionId)
  } finally { await engine.close(); await store.close() }
})

test('advisors see recorded tool evidence; English integration instructions stay out of card text', async () => {
  const runtime = runtimeWith({ 'ref-a': 'The test result requires a fix.' })
  const { engine } = await engineFor(runtime, preset({ references: [preset().references[0]] }))
  const history = [message('u', 'fix the failure'), { id: 'result-1', role: 'tool', source: { kind: 'tool' }, content: [{ type: 'tool-result', text: 'ASSERTION_SENTINEL: expected 2, got 3' }] }]
  try {
    const result = await engine.preStep(payloadFor(fakeSession(history)), async () => enter())
    const wire = JSON.stringify(runtime.calls[0].messages)
    assert.match(wire, /ASSERTION_SENTINEL: expected 2, got 3/)
    assert.match(runtime.calls[0].system, /including prior tool calls and their recorded results/)
    assert.doesNotMatch(runtime.calls[0].system, /[\p{Script=Han}]/u)
    const advice = result.messages[0]
    assert.match(advice.content[0].text, /Incorporate supported corrections/)
    assert.equal(advice.source.displayText, '### A\nThe test result requires a fix.')
    assert.doesNotMatch(advice.source.displayText, /Expert consultation|user authorization/)
  } finally { await engine.close() }
})

let passed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    passed += 1
    console.log(`ok ${passed} - ${name}`)
  } catch (error) {
    console.error(`not ok ${passed + 1} - ${name}`)
    console.error(error)
    process.exitCode = 1
    break
  }
}
if (passed === tests.length) console.log(`advice.test: ${passed}/${tests.length} passed`)
