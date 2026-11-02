// Regression tests for the 0.9 reference pipeline: per-reference budgets (item 7/12),
// one sealed batch per consultation (item 8) and bounded shutdown.
// Run: node --test moa-selftest/advice-batch.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { createAdviceEngine } from '../advice.js'
import { createDialogueStore } from '../dialogue.js'
import { DEFAULT_CONFIG, normalizeConfig } from '../config.js'
import { windowKey, wireTokens } from '../budget.js'

const message = (id, text, kind = 'user', role = 'user') => ({ id, role, content: [{ type: 'text', text }], source: { kind } })
const tool = (id, text) => ({ id, role: 'tool', toolCallId: id, content: [{ type: 'tool-result', text }], source: { kind: 'tool' } })
const enter = () => ({ kind: 'enter', messages: [] })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function session(history, id = 'batch-session') {
  return {
    header: { id }, seq: 1,
    eventAt() { return { type: 'model/selection', data: { provider: 'moa', model: 'batch' } } },
    deriveMessages() { return history },
  }
}

function preset(overrides = {}) {
  return {
    id: 'batch', label: 'Batch', fanout: 'user_turn',
    references: [{ id: 'a', provider: 'fake', model: 'ref-a', label: 'A' }],
    aggregator: { provider: 'fake', model: 'agg' },
    referenceTimeoutMs: 10000, deadlineMs: 20000,
    ...overrides,
  }
}

// Each call parks until released unless `auto` answers it at once.
function gatedRuntime({ auto = {}, fail = {} } = {}) {
  const calls = []
  return {
    calls,
    stream(options) {
      let release
      const gate = new Promise(resolve => { release = resolve })
      const call = { options, release, bytes: JSON.stringify(options.messages).length }
      calls.push(call)
      const index = calls.length
      return (async function * () {
        const failure = fail[options.model]?.(index)
        if (failure) throw new Error(failure)
        const text = auto[options.model] ?? await gate
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function memoryKv({ failCadenceOnce = false } = {}) {
  const tables = { dialogue: {}, cadence: {}, window: {} }
  let failNext = failCadenceOnce
  return {
    tables,
    async loadAll() { return { tables: structuredClone(tables) } },
    async putRecord(table, key, value) {
      if (table === 'cadence' && failNext) { failNext = false; throw new Error('disk full') }
      tables[table][key] = structuredClone(value)
    },
    async deleteRecord(table, key) { delete tables[table][key] },
  }
}

async function engineFor(runtime, presetValue, { kv = null, config: overrides = {} } = {}) {
  const config = normalizeConfig({ defaultPreset: presetValue.id, referenceSchedule: 'parallel', persistentTags: [], ...overrides })
  const store = createDialogueStore({ kv: null, persistentTags: config.persistentTags })
  await store.load()
  const presets = new Map([[presetValue.id, presetValue]])
  const engine = createAdviceEngine({ runtime, store, presets, config, log: null, kv })
  await engine.load()
  return { engine, store, config }
}

const step = (engine, owner, turn, n) => engine.preStep({ agent: { session: owner }, turn, step: n, signal: new AbortController().signal }, async () => enter())
const adviceOf = decision => decision.messages.filter(entry => entry.source?.kind === 'plugin:moa')
const textOf = entry => entry.content.map(block => block.text ?? '').join('')

test('defaults: char ceilings no longer bind before the per-reference token budget', () => {
  assert.equal(DEFAULT_CONFIG.maxDialogueChars, 4000000)
  assert.equal(DEFAULT_CONFIG.maxTranscriptChars, 4000000)
  const config = normalizeConfig({})
  assert.equal(config.maxDialogueChars, 4000000)
  assert.equal(config.maxTranscriptChars, 4000000)
})

test('a reference whose window cannot hold the request fails locally without dispatching', async () => {
  const runtime = gatedRuntime({ auto: { 'ref-b': 'B advice' } })
  const value = preset({ references: [
    { id: 'a', provider: 'fake', model: 'ref-a', label: 'A', contextWindow: 8192, maxTokens: 6000, systemSuffix: 'huge system '.repeat(2000) },
    { id: 'b', provider: 'fake', model: 'ref-b', label: 'B' },
  ] })
  const { engine } = await engineFor(runtime, value)
  try {
    const decision = await step(engine, session([message('u', 'review the change')]), 1, 1)
    assert.deepEqual(runtime.calls.map(call => call.options.model), ['ref-b'], 'the over-budget reference must not be sent')
    const [card] = adviceOf(decision)
    assert.match(textOf(card), /B advice/)
    assert.match(card.source.displayText, /Unavailable: A:/)
  } finally { await engine.close() }
})

test('each reference reads the transcript through its own window', async () => {
  const runtime = gatedRuntime({ auto: { 'ref-small': 'small advice', 'ref-large': 'large advice' } })
  const value = preset({ references: [
    { id: 's', provider: 'fake', model: 'ref-small', label: 'Small', contextWindow: 20000, maxTokens: 2000 },
    { id: 'l', provider: 'fake', model: 'ref-large', label: 'Large', contextWindow: 1000000, maxTokens: 2000 },
  ] })
  const history = [message('u', 'TASK_ANCHOR: audit every module')]
  for (let index = 0; index < 40; index += 1) history.push(tool(`t${index}`, `module ${index} ${'evidence line '.repeat(400)}`))
  const { engine } = await engineFor(runtime, value)
  try {
    await step(engine, session(history), 1, 1)
    const small = runtime.calls.find(call => call.options.model === 'ref-small')
    const large = runtime.calls.find(call => call.options.model === 'ref-large')
    assert.ok(small.bytes < large.bytes / 4, `small window must get a smaller view (${small.bytes} vs ${large.bytes})`)
    assert.ok(small.bytes / 4 < 18000, 'the small view stays inside its token budget')
    assert.match(JSON.stringify(small.options.messages), /TASK_ANCHOR/, 'the task request stays visible in a windowed view')
    assert.match(JSON.stringify(large.options.messages), /module 0 /, 'the large window sees the whole history')
  } finally { await engine.close() }
})

test('a bili window refusal is learned, persisted and retried once with a smaller request', async () => {
  const refusal = 'preflight_compress_failed: over-window payload was NOT forwarded; request exceeds the model window 30000'
  const runtime = gatedRuntime({
    auto: { 'ref-a': 'fits now' },
    fail: { 'ref-a': index => index === 1 ? refusal : null },
  })
  const kv = memoryKv()
  const history = [message('u', 'TASK: summarize')]
  for (let index = 0; index < 30; index += 1) history.push(tool(`t${index}`, `${index} ${'data '.repeat(800)}`))
  const value = preset({ references: [{ id: 'a', provider: 'fake', model: 'ref-a', label: 'A', maxTokens: 4000 }] })
  const { engine } = await engineFor(runtime, value, { kv })
  try {
    const decision = await step(engine, session(history), 1, 1)
    assert.equal(runtime.calls.length, 2, 'one refusal, one rebuilt request')
    assert.ok(runtime.calls[1].bytes < runtime.calls[0].bytes / 2, `the retry must shrink (${runtime.calls[0].bytes} -> ${runtime.calls[1].bytes})`)
    assert.ok(runtime.calls[1].bytes / 4 < 30000)
    assert.match(textOf(adviceOf(decision)[0]), /fits now/)
    const record = kv.tables.window[windowKey('fake', 'ref-a')]
    assert.equal(record.effectiveLimit, 30000)
    assert.equal(record.reserveAtLearning, 4000)
  } finally { await engine.close() }
})

test('a bili refusal under an explicit contextWindow still bounds the one retry', async () => {
  const refusal = 'preflight_compress_failed: over-window payload was NOT forwarded; request exceeds the model window 184000'
  const runtime = gatedRuntime({
    auto: { 'ref-a': 'fits now' },
    fail: { 'ref-a': index => index === 1 ? refusal : null },
  })
  const kv = memoryKv()
  const history = [message('u', 'TASK: summarize')]
  for (let index = 0; index < 45; index += 1) history.push(tool(`t${index}`, `${index} ${'data '.repeat(4400)}`))
  const value = preset({ references: [{ id: 'a', provider: 'fake', model: 'ref-a', label: 'A', contextWindow: 1000000, maxTokens: 16000 }] })
  const { engine } = await engineFor(runtime, value, { kv })
  try {
    const decision = await step(engine, session(history), 1, 1)
    assert.equal(runtime.calls.length, 2, 'one refusal, one rebuilt request')
    const [first, second] = runtime.calls.map(call => wireTokens(call.options))
    assert.ok(first > 184000, `the first request must exceed the refused limit (${first})`)
    assert.ok(second < first && second <= 174800, `the retry must fit 174800 tokens (${second})`)
    assert.deepEqual(runtime.calls.map(call => call.options.maxTokens), [16000, 16000], 'the configured output cap is kept')
    assert.equal(kv.tables.window[windowKey('fake', 'ref-a')].effectiveLimit, 184000, 'persist the raw refusal, not its 95% budget')
    assert.match(textOf(adviceOf(decision)[0]), /fits now/)
  } finally { await engine.close() }
})

test('a second bili refusal stops after two dispatches', async () => {
  const refusal = 'preflight_compress_failed: over-window payload was NOT forwarded; request exceeds the model window 184000'
  const runtime = gatedRuntime({ fail: { 'ref-a': () => refusal } })
  const kv = memoryKv()
  const history = [message('u', 'TASK: summarize')]
  for (let index = 0; index < 45; index += 1) history.push(tool(`t${index}`, `${index} ${'data '.repeat(4400)}`))
  const value = preset({ references: [{ id: 'a', provider: 'fake', model: 'ref-a', label: 'A', contextWindow: 1000000, maxTokens: 16000 }] })
  const { engine } = await engineFor(runtime, value, { kv })
  try {
    const decision = await step(engine, session(history), 1, 1)
    assert.equal(runtime.calls.length, 2)
    assert.ok(wireTokens(runtime.calls[1].options) <= 174800)
    assert.deepEqual(runtime.calls.map(call => call.options.maxTokens), [16000, 16000])
    assert.match(adviceOf(decision)[0].source.displayText, /still exceeds bili's model window 184000 after rebuilding/)
    assert.equal(kv.tables.window[windowKey('fake', 'ref-a')].effectiveLimit, 184000)
  } finally { await engine.close() }
})

test('a retry fit failure reports the raw refusal limit rather than its margin budget', async () => {
  const refusal = 'preflight_compress_failed: over-window payload was NOT forwarded; request exceeds the model window 184000'
  const runtime = gatedRuntime({ fail: { 'ref-a': () => refusal } })
  const value = preset({ references: [{ id: 'a', provider: 'fake', model: 'ref-a', label: 'A', contextWindow: 1000000, maxTokens: 16000, systemSuffix: 'x'.repeat(700000) }] })
  const { engine } = await engineFor(runtime, value)
  try {
    const decision = await step(engine, session([message('u', 'TASK: summarize')]), 1, 1)
    assert.equal(runtime.calls.length, 1, 'the rebuilt request fails locally on its system size')
    const display = adviceOf(decision)[0].source.displayText
    assert.match(display, /budget 174800/)
    assert.match(display, /capped by bili's learned model window 184000/)
    assert.doesNotMatch(display, /learned model window 174800/)
  } finally { await engine.close() }
})

test('a bili refusal that cannot shrink the budget is not retried', async () => {
  const refusal = 'preflight_compress_failed: over-window payload was NOT forwarded; request exceeds the model window 30000'
  const runtime = gatedRuntime({ fail: { 'ref-a': () => refusal } })
  const kv = memoryKv()
  const value = preset({ references: [{ id: 'a', provider: 'fake', model: 'ref-a', label: 'A', contextWindow: 20000, maxTokens: 4000 }] })
  const { engine } = await engineFor(runtime, value, { kv })
  try {
    const decision = await step(engine, session([message('u', 'TASK: summarize')]), 1, 1)
    assert.equal(runtime.calls.length, 1, 'the same request would be refused again')
    assert.match(adviceOf(decision)[0].source.displayText, /Unavailable: A:.*does not shrink the request budget/)
    assert.equal(kv.tables.window[windowKey('fake', 'ref-a')].effectiveLimit, 30000, 'the limit is still recorded')
  } finally { await engine.close() }
})

test('a short request is sent even when a small window leaves little transcript share', async () => {
  const runtime = gatedRuntime({ auto: { 'ref-a': 'small advice' } })
  const value = preset({ references: [{ id: 'a', provider: 'fake', model: 'ref-a', label: 'A', contextWindow: 8192, maxTokens: 6000, persistent: true }] })
  const { engine } = await engineFor(runtime, value)
  try {
    const decision = await step(engine, session([message('u', 'review the change'), tool('t', 'LATEST_EVIDENCE: tests passed')]), 1, 1)
    assert.equal(runtime.calls.length, 1, 'a transcript that fits whole is dispatched')
    assert.equal(runtime.calls[0].options.messages.length, 3, 'the actual persistent scaffold also fits')
    assert.ok(wireTokens(runtime.calls[0].options) <= 2082)
    assert.equal(runtime.calls[0].options.maxTokens, 6000)
    assert.match(JSON.stringify(runtime.calls[0].options.messages), /review the change/)
    assert.match(JSON.stringify(runtime.calls[0].options.messages), /LATEST_EVIDENCE: tests passed/)
    assert.match(textOf(adviceOf(decision)[0]), /small advice/)
  } finally { await engine.close() }
})

test('a failed cadence write releases the claim; the sealed batch is delivered once later', async () => {
  const runtime = gatedRuntime({ auto: { 'ref-a': 'A advice', 'ref-b': 'B advice' } })
  const kv = memoryKv({ failCadenceOnce: true })
  const value = preset({ references: [
    { id: 'a', provider: 'fake', model: 'ref-a', label: 'A' },
    { id: 'b', provider: 'fake', model: 'ref-b', label: 'B' },
  ] })
  const history = [message('u', 'task')]
  const owner = session(history)
  const { engine } = await engineFor(runtime, value, { kv })
  try {
    const first = await step(engine, owner, 1, 1)
    assert.equal(adviceOf(first).length, 0, 'the failed write delivers nothing')
    const second = await step(engine, owner, 1, 2)
    const cards = adviceOf(second)
    assert.equal(cards.length, 1, 'the next admitted pre-step delivers the sealed batch')
    assert.match(textOf(cards[0]), /A advice[\s\S]*B advice/)
    assert.equal(runtime.calls.length, 2, 'delivery never re-runs the references')
    history.push(cards[0])
    const third = await step(engine, owner, 1, 3)
    assert.equal(adviceOf(third).length, 0, 'a delivered batch is not injected again')
  } finally { await engine.close() }
})

test('concurrent pre-steps deliver one sealed background batch exactly once', async () => {
  const runtime = gatedRuntime()
  const value = preset({ delivery: 'background', references: [
    { id: 'a', provider: 'fake', model: 'ref-a', label: 'A' },
    { id: 'b', provider: 'fake', model: 'ref-b', label: 'B' },
  ] })
  const owner = session([message('u', 'task')])
  const { engine } = await engineFor(runtime, value)
  try {
    assert.equal(adviceOf(await step(engine, owner, 1, 1)).length, 0)
    runtime.calls[0].release('A advice')
    await sleep(20)
    assert.equal(adviceOf(await step(engine, owner, 1, 2)).length, 0, 'a partial batch is never injected')
    runtime.calls[1].release('B advice')
    await sleep(20)
    const [left, right] = await Promise.all([step(engine, owner, 1, 3), step(engine, owner, 1, 4)])
    const cards = [...adviceOf(left), ...adviceOf(right)]
    assert.equal(cards.length, 1, 'exactly one pre-step injects anything, cached or not')
    assert.equal(cards[0].source.cached, false)
    assert.match(textOf(cards[0]), /A advice[\s\S]*B advice/)
    owner.deriveMessages().push(cards[0])
    assert.equal(adviceOf(await step(engine, owner, 1, 5)).length, 0, 'a committed card is not injected again')
    assert.equal(runtime.calls.length, 2)
  } finally { await engine.close() }
})

test('a reference past its deadline is reported unavailable and its late reply never changes the card', async () => {
  const runtime = gatedRuntime({ auto: { 'ref-fast': 'fast advice' } })
  const value = preset({ references: [
    { id: 'f', provider: 'fake', model: 'ref-fast', label: 'Fast' },
    { id: 's', provider: 'fake', model: 'ref-slow', label: 'Slow', timeoutMs: 1000 },
  ] })
  const history = [message('u', 'task')]
  const owner = session(history)
  const { engine } = await engineFor(runtime, value)
  try {
    const started = Date.now()
    const decision = await step(engine, owner, 1, 1)
    assert.ok(Date.now() - started < 5000, 'the batch seals at the slow reference deadline')
    const [card] = adviceOf(decision)
    assert.match(textOf(card), /fast advice/)
    assert.match(card.source.displayText, /Unavailable: Slow: no reply within 1s/)
    runtime.calls.find(call => call.options.model === 'ref-slow').release('late slow advice')
    await sleep(20)
    history.push(card)
    const next = await step(engine, owner, 1, 2)
    assert.equal(adviceOf(next).length, 0)
    assert.doesNotMatch(JSON.stringify(next.messages), /late slow advice/)
  } finally { await engine.close() }
})

test('the end-of-turn review reads per-reference views as well', async () => {
  const runtime = gatedRuntime({ auto: { 'ref-small': 'VERDICT: PASS', 'ref-large': 'VERDICT: PASS' } })
  const value = preset({ fanout: 'user_turn_end', references: [
    { id: 's', provider: 'fake', model: 'ref-small', label: 'Small', contextWindow: 20000, maxTokens: 2000 },
    { id: 'l', provider: 'fake', model: 'ref-large', label: 'Large', contextWindow: 1000000, maxTokens: 2000 },
  ] })
  const history = [message('u', 'TASK_ANCHOR: audit')]
  for (let index = 0; index < 40; index += 1) history.push(tool(`t${index}`, `module ${index} ${'evidence line '.repeat(400)}`))
  const owner = session(history)
  const { engine } = await engineFor(runtime, value)
  try {
    await step(engine, owner, 1, 1)
    const before = runtime.calls.length
    await engine.turnStopping({ agent: { session: owner, inject() {} }, turn: 1, signal: new AbortController().signal })
    const review = runtime.calls.slice(before)
    const small = review.find(call => call.options.model === 'ref-small')
    const large = review.find(call => call.options.model === 'ref-large')
    assert.ok(small && large, 'both references review')
    assert.ok(small.bytes < large.bytes / 4, `review views follow each window (${small.bytes} vs ${large.bytes})`)
  } finally { await engine.close() }
})

test('close() returns within its grace period even when a transport ignores abort', { timeout: 15000 }, async () => {
  const runtime = {
    stream() {
      return (async function * () {
        await new Promise(() => {})
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const value = preset({ delivery: 'background' })
  const { engine } = await engineFor(runtime, value)
  await step(engine, session([message('u', 'task')]), 1, 1)
  const started = Date.now()
  await engine.close()
  assert.ok(Date.now() - started < 7000, `close took ${Date.now() - started} ms`)
})
