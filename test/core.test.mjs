// Run from the workspace root: node moa-selftest/core.test.mjs
import assert from 'node:assert/strict'
import { PROVIDER_ID, resolveMoaPreset, resolveSessionRoute } from '../route.js'
import { adviceRouteKey, buildAdvisorTranscript, contentToText, makeAdviceMessage, selectAdviceForAggregator, sha256 } from '../transcript.js'
import {
  createMoaAdapter,
  rewriteMessagesForAggregator,
  unwrapReplayState,
  wrapReplayState,
} from '../adapter.js'

const checks = []
const check = (name, fn) => checks.push([name, fn])
const AGG = {
  provider: 'real-provider',
  model: 'real-model',
  reasoningEffort: 'medium',
  temperature: 0.25,
  maxTokens: 2048,
}
const CAPS = {
  context: { contextWindow: 123456 },
  defaultMaxTokens: 4096,
  reasoning: { efforts: ['low', 'medium', 'high'] },
  inputModalities: ['text', 'image'],
  systemPromptUpdate: 'append',
  toolUpdate: 'reload',
}
const presets = new Map([
  ['easy', { id: 'easy', label: 'Easy MoA', description: 'test preset', aggregator: AGG }],
])

function textMessage(id, role, text, kind) {
  return {
    ...(id === undefined ? {} : { id }),
    role,
    content: [{ type: 'text', text }],
    source: { kind: kind || role },
  }
}

function sessionWith(events) {
  return { seq: events.length, eventAt: (index) => events[index] }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function runtimeFor(chunks) {
  const calls = []
  return {
    calls,
    async resolveModelInfo() {
      return CAPS
    },
    adapterStream(options) { return this.stream(options) },
    async *stream(options) {
      calls.push(options)
      for (const chunk of chunks) yield chunk
    },
  }
}

check('route: latest selection beats an older header', () => {
  const session = sessionWith([
    { type: 'request/header', data: { header: { config: { provider: 'old', model: 'header-model' } } } },
    { type: 'model/selection', data: { provider: 'moa', model: 'easy', reasoningEffort: 'high', maxTokens: 777 } },
  ])
  assert.deepEqual(resolveSessionRoute(session), {
    provider: 'moa',
    model: 'easy',
    reasoningEffort: 'high',
    maxTokens: 777,
    source: 'selection',
  })
})

check('route: latest header beats an older selection', () => {
  const session = sessionWith([
    { type: 'model/selection', data: { provider: 'old', model: 'selected' } },
    { type: 'request/header', data: { header: { config: { provider: 'moa', model: 'easy' } } } },
  ])
  assert.deepEqual(resolveSessionRoute(session), { provider: 'moa', model: 'easy', source: 'header' })
})

check('route: descriptor and request-header fallbacks', () => {
  const descriptor = sessionWith([
    { type: 'subagent/descriptor', data: { agentProvider: 'moa', agentModel: 'easy' } },
  ])
  assert.deepEqual(resolveSessionRoute(descriptor), { provider: 'moa', model: 'easy', source: 'descriptor' })
  const header = {
    seq: 0,
    eventAt() {
      throw new Error('unavailable')
    },
    requestHeader() {
      return { config: { provider: 'header-provider', model: 'header-model' } }
    },
  }
  assert.deepEqual(resolveSessionRoute(header), {
    provider: 'header-provider',
    model: 'header-model',
    source: 'header',
  })
  assert.doesNotThrow(() => resolveSessionRoute(null))
})

check('route: preset resolution accepts only known MoA routes', () => {
  const moaSession = sessionWith([
    { type: 'model/selection', data: { provider: 'moa', model: 'easy' } },
  ])
  assert.equal(PROVIDER_ID, 'moa')
  assert.deepEqual(resolveMoaPreset(moaSession, presets), {
    route: { provider: 'moa', model: 'easy', source: 'selection' },
    preset: presets.get('easy'),
  })
  const otherSession = sessionWith([
    { type: 'model/selection', data: { provider: 'other', model: 'easy' } },
  ])
  assert.equal(resolveMoaPreset(otherSession, presets), null)
  const missingSession = sessionWith([
    { type: 'model/selection', data: { provider: 'moa', model: 'missing' } },
  ])
  assert.equal(resolveMoaPreset(missingSession, presets), null)
})

check('transcript: turnSource ends at the last real user', () => {
  const history = [
    textMessage('u1', 'user', 'first'),
    textMessage('a1', 'assistant', 'answer one', 'model'),
    textMessage('u2', 'user', 'current request'),
    textMessage('a2', 'assistant', 'pending answer', 'model'),
  ]
  const result = buildAdvisorTranscript(history)
  const expected = buildAdvisorTranscript(history.slice(0, 3)).source
  assert.equal(result.turnSource, expected)
  assert.ok(result.source.includes('pending answer'))
  assert.ok(!result.turnSource.includes('pending answer'))
})

check('transcript: real-user detection ignores synthetic user kinds', () => {
  const history = [
    textMessage('u1', 'user', 'real'),
    textMessage('synthetic', 'user', 'notice', 'webhook'),
    textMessage('a1', 'assistant', 'answer', 'model'),
  ]
  const result = buildAdvisorTranscript(history)
  assert.equal(result.turnSource, buildAdvisorTranscript(history.slice(0, 1)).source)
  assert.ok(result.source.includes('notice'))
})

check('transcript: own advice and excluded user kinds never feed back', () => {
  const advice = makeAdviceMessage('private advisor output', { runId: 'r1' })
  assert.equal(advice.role, 'user')
  assert.equal(advice.source.kind, 'plugin:moa')
  assert.equal(advice.source.form, 'advice')
  assert.equal(advice.source.runId, 'r1')
  assert.ok(advice.id)
  const history = [
    textMessage('u1', 'user', 'visible'),
    advice,
    textMessage('time', 'user', 'clock', 'time-context'),
    textMessage('a1', 'assistant', 'visible answer', 'model'),
  ]
  const result = buildAdvisorTranscript(history)
  assert.ok(!result.source.includes('private advisor output'))
  assert.ok(!result.source.includes('clock'))
  assert.equal(result.messageCount, 2)
})

check('transcript: pending messages are deduped by id', () => {
  const original = textMessage('u1', 'user', 'original')
  const duplicate = textMessage('u1', 'user', 'duplicate')
  const pending = [duplicate, textMessage('u2', 'user', 'new')]
  const result = buildAdvisorTranscript([original], pending)
  assert.ok(result.source.includes('original'))
  assert.ok(!result.source.includes('duplicate'))
  assert.ok(result.source.includes('new'))
  assert.equal(result.messageCount, 2)
})

check('transcript: serialization is stable and append-only', () => {
  const history = [
    textMessage('u1', 'user', 'first'),
    textMessage('a1', 'assistant', 'answer', 'model'),
  ]
  const before = buildAdvisorTranscript(history)
  const repeated = buildAdvisorTranscript(history)
  const after = buildAdvisorTranscript(history, [textMessage('u2', 'user', 'next')])
  assert.equal(repeated.source, before.source)
  assert.ok(after.source.startsWith(before.source))
  assert.equal(before.windowed, false)
  assert.equal(after.messageCount, 3)
})

check('transcript: fallback ids are deterministic and attributes are escaped', () => {
  const anonymous = textMessage(undefined, 'user', 'hello')
  const result = buildAdvisorTranscript([anonymous])
  const id = sha256('user\0user\0hello').slice(0, 16)
  assert.ok(result.source.includes(`<source id="${id}" role="user" kind="user">`))
  const escaped = buildAdvisorTranscript([textMessage('x"&<', 'assistant', 'text', 'model')])
  assert.ok(escaped.source.includes('id="x&quot;&amp;&lt;"'))
})

check('transcript: content blocks retain text and omit reasoning', () => {
  const text = contentToText([
    { type: 'reasoning', text: 'hidden' },
    { type: 'text', text: ' visible ' },
    { type: 'tool-call', name: 'read', arguments: '{"x":1}' },
    { type: 'image' },
    { type: 'file', attachment: { name: 'a.txt' } },
    { type: 'tool-result', content: [{ type: 'text', text: 'tool body' }] },
  ])
  assert.equal(text, ' visible \n[tool-call read {"x":1}]\n[image]\n[file a.txt]\ntool body')
  assert.equal(contentToText('verbatim'), 'verbatim')
})

check('transcript: per-message truncation is deterministic head plus tail', () => {
  const raw = '0123456789'.repeat(10)
  const first = contentToText(raw, { maxChars: 40 })
  const second = contentToText(raw, { maxChars: 40 })
  assert.equal(first, second)
  assert.equal(first.length, 40)
  assert.ok(first.startsWith('012345'))
  assert.ok(first.endsWith('456789'))
  assert.ok(first.includes('[truncated]'))
  const result = buildAdvisorTranscript([textMessage('u1', 'user', raw)], [], { maxMessageChars: 40 })
  assert.equal(result.truncated, true)
})

check('transcript: total window rebases to latest complete messages', () => {
  const history = [
    textMessage('w1', 'user', `first-${'x'.repeat(40)}`),
    textMessage('a1', 'assistant', `second-${'y'.repeat(40)}`, 'model'),
    textMessage('w2', 'user', `third-${'z'.repeat(40)}`),
    textMessage('a2', 'assistant', 'latest complete answer', 'model'),
  ]
  const full = buildAdvisorTranscript(history)
  const maxTotalChars = full.source.length - 1
  const result = buildAdvisorTranscript(history, [], { maxTotalChars })
  const latest = buildAdvisorTranscript([history.at(-1)]).source
  assert.equal(result.windowed, true)
  assert.equal(result.turnSource, full.turnSource)
  assert.ok(result.source.length <= maxTotalChars)
  assert.ok(result.source.endsWith(latest))
  assert.ok(!result.source.includes('first-'))
  assert.ok(result.source.includes('earlier messages omitted'))
  assert.equal(result.messageCount, (result.source.match(/<source /g) || []).length)
})

check('adapter: capability mirror is complete and cached', async () => {
  let resolveCount = 0
  const runtime = {
    async resolveModelInfo(provider, model) {
      resolveCount += 1
      assert.equal(provider, AGG.provider)
      assert.equal(model, AGG.model)
      return CAPS
    },
    async *stream() {},
  }
  const adapter = createMoaAdapter({ runtime, presets })
  const resolved = await adapter.resolveModel('moa', 'easy')
  assert.equal(resolved.provider, 'moa')
  assert.equal(resolved.id, 'easy')
  assert.equal(resolved.name, 'Easy MoA')
  assert.deepEqual(resolved.context, CAPS.context)
  assert.equal(resolved.defaultMaxTokens, AGG.maxTokens)
  assert.deepEqual(resolved.reasoning, CAPS.reasoning)
  assert.deepEqual(resolved.inputModalities, CAPS.inputModalities)
  assert.equal(resolved.systemPromptUpdate, CAPS.systemPromptUpdate)
  assert.equal(resolved.toolUpdate, CAPS.toolUpdate)
  const listed = await adapter.listModels()
  assert.equal(listed.length, 1)
  assert.deepEqual(listed[0], resolved)
  await adapter.resolveModel('moa', 'easy')
  assert.equal(resolveCount, 1)
  const prepared = await adapter.prepareCall('moa', 'easy')
  assert.equal(prepared.model, resolved)
  assert.equal(typeof prepared.stream, 'function')
  assert.deepEqual(adapter.providerInfo(), { id: 'moa', name: 'Better MoA' })
  assert.deepEqual(adapter.imageRequestTarget(), { width: 1568, height: 1568, maxBytes: 5 * 1024 * 1024 })
  assert.equal(adapter.providerRetryPolicy(), undefined)
  assert.equal(adapter.imageRequestPricing(), undefined)
  await assert.rejects(adapter.resolveModel('moa', 'unknown'), (error) => {
    assert.ok(error.message.startsWith('[moa] unknown MoA preset'))
    return true
  })
})

check('adapter: call options and non-reasoning aggregator defaults are forwarded', async () => {
  const finish = { type: 'finish', reason: { kind: 'stop' } }
  const runtime = runtimeFor([finish])
  const adapter = createMoaAdapter({ runtime, presets })
  const tools = [{ name: 'read' }]
  const toolHistory = [{ callId: 'c1', status: 'done' }]
  const stop = ['STOP']
  const signal = new AbortController().signal
  const messages = [textMessage('u1', 'user', 'request')]
  const chunks = await collect(adapter.stream({
    provider: 'moa',
    model: 'easy',
    messages,
    system: 'system prompt',
    tools,
    toolHistory,
    stop,
    signal,
    sessionId: 'session-1',
    purpose: 'compaction',
    reasoningEffort: 'high',
    temperature: 0.9,
    maxTokens: 8192,
  }))
  assert.equal(runtime.calls.length, 1)
  const options = runtime.calls[0]
  assert.equal(options.provider, AGG.provider)
  assert.equal(options.model, AGG.model)
  assert.notEqual(options.messages, messages)
  assert.deepEqual(options.messages, messages)
  assert.equal(options.system, 'system prompt')
  assert.equal(options.tools, tools)
  assert.equal(options.toolHistory, toolHistory)
  assert.equal(options.stop, stop)
  assert.equal(options.signal, signal)
  assert.equal(options.sessionId, 'session-1', 'non-native aggregators carry the main session id (billion-context attribution)')
  assert.equal(options.purpose, 'compaction')
  assert.equal(options.reasoningEffort, 'high')
  assert.equal(options.temperature, 0.9)
  assert.equal(options.maxTokens, AGG.maxTokens)
  assert.equal(chunks[0], finish)

  await collect(adapter.stream({ provider: 'moa', model: 'easy', messages }))
  const defaults = runtime.calls[1]
  assert.equal(defaults.reasoningEffort, undefined)
  assert.equal(defaults.temperature, AGG.temperature)
  assert.equal(defaults.maxTokens, AGG.maxTokens)
  assert.equal(runtime.calls.length, 2)
})

check('adapter: MoA sources rewrite without mutating history', async () => {
  const runtime = runtimeFor([{ type: 'finish', reason: { kind: 'stop' } }])
  const adapter = createMoaAdapter({ runtime, presets })
  const envelope = { response: { id: 'response-1' }, blocks: ['block'], extra: 'kept' }
  const wrapped = wrapReplayState(envelope, AGG)
  const moaMessage = {
    id: 'a1',
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
    source: { kind: 'model', provider: 'moa', model: 'easy', replayState: wrapped },
  }
  const originalSource = { ...moaMessage.source }
  const nonMoa = {
    id: 'a0',
    role: 'assistant',
    content: [{ type: 'text', text: 'other' }],
    source: { kind: 'model', provider: 'other', model: 'other-model', replayState: { response: 1 } },
  }
  await collect(adapter.stream({ provider: 'moa', model: 'easy', messages: [moaMessage, nonMoa] }))
  const rewritten = runtime.calls[0].messages
  assert.notEqual(rewritten[0], moaMessage)
  assert.notEqual(rewritten[0].source, moaMessage.source)
  assert.equal(rewritten[0].source.provider, AGG.provider)
  assert.equal(rewritten[0].source.model, AGG.model)
  assert.deepEqual(rewritten[0].source.replayState, envelope)
  assert.deepEqual(moaMessage.source, originalSource)
  assert.equal(rewritten[1], nonMoa)
  assert.deepEqual(nonMoa.source.replayState, { response: 1 })
})

check('adapter: replay unwrap requires the same aggregator', () => {
  const envelope = { response: { opaque: true }, blocks: ['b'], requestId: 'r1' }
  const wrapped = wrapReplayState(envelope, AGG)
  assert.deepEqual(wrapped.response, {
    moa: 1,
    provider: AGG.provider,
    model: AGG.model,
    inner: envelope.response,
  })
  assert.deepEqual(wrapped.blocks, envelope.blocks)
  assert.equal(wrapped.requestId, 'r1')
  assert.deepEqual(unwrapReplayState(wrapped, AGG), envelope)
  assert.equal(unwrapReplayState(wrapped, { ...AGG, model: 'different' }), undefined)
  assert.equal(unwrapReplayState(null, AGG), undefined)
  assert.equal(wrapReplayState(null, AGG), null)

  const message = {
    id: 'a1',
    role: 'assistant',
    content: [],
    source: { kind: 'model', provider: 'moa', model: 'easy', replayState: wrapped },
  }
  const [rewritten] = rewriteMessagesForAggregator([message], { ...AGG, model: 'different' })
  assert.equal(rewritten.source.provider, AGG.provider)
  assert.equal(rewritten.source.model, 'different')
  assert.ok(!Object.prototype.hasOwnProperty.call(rewritten.source, 'replayState'))
  assert.equal(message.source.replayState, wrapped)
})

check('adapter: finish replay state is wrapped once at the boundary', async () => {
  const replayState = { response: { id: 'r1' }, blocks: ['b'], extra: 1 }
  const finish = { type: 'finish', reason: { kind: 'stop' }, replayState }
  const runtime = runtimeFor([finish])
  const adapter = createMoaAdapter({ runtime, presets })
  const chunks = await collect(adapter.stream({ provider: 'moa', model: 'easy', messages: [] }))
  assert.equal(chunks.length, 1)
  assert.notEqual(chunks[0], finish)
  assert.equal(chunks[0].reason, finish.reason)
  assert.deepEqual(chunks[0].replayState, wrapReplayState(replayState, AGG))
  assert.deepEqual(finish.replayState, replayState)
  assert.deepEqual(unwrapReplayState(chunks[0].replayState, AGG), replayState)
})

check('adapter: usage passes unchanged without reference token merging', async () => {
  const usage = {
    type: 'usage',
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadTokens: 3 },
  }
  const runtime = runtimeFor([usage])
  const adapter = createMoaAdapter({ runtime, presets })
  const chunks = await collect(adapter.stream({ provider: 'moa', model: 'easy', messages: [] }))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], usage)
  assert.deepEqual(chunks[0], {
    type: 'usage',
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadTokens: 3 },
  })
})

check('adapter: ordinary finish errors pass through unchanged', async () => {
  const finish = {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'upstream', code: 'upstream/error' } },
  }
  const runtime = runtimeFor([finish])
  const adapter = createMoaAdapter({ runtime, presets })
  const chunks = await collect(adapter.stream({ provider: 'moa', model: 'easy', messages: [] }))
  assert.equal(chunks[0], finish)
})

check('adapter: unknown preset becomes a finish error without a call', async () => {
  const runtime = runtimeFor([])
  const adapter = createMoaAdapter({ runtime, presets })
  const chunks = await collect(adapter.stream({ provider: 'moa', model: 'unknown', messages: [] }))
  assert.equal(runtime.calls.length, 0)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'moa/unknown-preset')
  assert.ok(chunks[0].reason.failure.message.startsWith('[moa] unknown MoA preset'))
})

check('adapter: thrown aggregator errors become a finish error', async () => {
  const runtime = {
    async *stream() {
      throw new Error('boom')
    },
  }
  const adapter = createMoaAdapter({ runtime, presets })
  const chunks = await collect(adapter.stream({ provider: 'moa', model: 'easy', messages: [] }))
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0], {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: '[moa] aggregator call failed: boom', code: 'moa/aggregator-failed' },
    },
  })
})

check('advice view: latest route advice stays at its first unchanged position and preserves the event log', () => {
  const preset = presets.get('easy')
  const own = text => makeAdviceMessage(text, { preset: 'easy', routeKey: adviceRouteKey(preset) })
  const user = textMessage('u', 'user', 'request', 'user')
  const tool = textMessage('t', 'tool', 'actual tool result', 'tool')
  const answer = textMessage('a', 'assistant', 'actual answer', 'model')
  const old = own('old advice')
  const latest = own('new advice')
  const duplicate = own('new advice')
  const foreign = makeAdviceMessage('foreign', { preset: 'elsewhere', routeKey: 'foreign-route' })
  const log = [user, old, tool, latest, answer, duplicate, foreign]
  const before = structuredClone(log)
  assert.deepEqual(selectAdviceForAggregator(log, preset), [user, tool, latest, answer])
  assert.deepEqual(selectAdviceForAggregator(log, preset, 'all'), [user, old, tool, latest, answer, duplicate])
  assert.deepEqual(log, before)
  const changedBack = own('old advice')
  assert.deepEqual(selectAdviceForAggregator([...log, changedBack], preset), [user, tool, answer, changedBack])
})

check('adapter: verified Claude TUI keeps its outer workspace while changing replay generation', async () => {
  const aggregator = { provider: 'magpie-anthropic', model: 'ai/ai/claude-tui/claude-sonnet-5-5', capabilities: { nativeSession: true, requestReconciliation: true, adviceBoundary: true } }
  const preset = { id: 'native', aggregator }
  const runtime = runtimeFor([{ type: 'finish', reason: { kind: 'stop' }, replayState: { response: 'native-response', blocks: [null] } }])
  const adapter = createMoaAdapter({ runtime, presets: new Map([['native', preset]]) })
  const user = textMessage('u1', 'user', 'request', 'user')
  const adviceA = makeAdviceMessage('advice A', { routeKey: adviceRouteKey(preset) })
  const first = await collect(adapter.stream({ provider: 'moa', model: 'native', sessionId: 'real-session', messages: [user, adviceA] }))
  const assistant = { ...textMessage('a1', 'assistant', 'answer', 'model'), source: { kind: 'model', provider: 'moa', model: 'native', replayState: first[0].replayState } }
  const tool = textMessage('t1', 'tool', 'actual result', 'tool')
  await collect(adapter.stream({ provider: 'moa', model: 'native', sessionId: 'real-session', messages: [user, adviceA, assistant, tool] }))
  assert.equal(runtime.calls[1].sessionId, runtime.calls[0].sessionId)
  assert.deepEqual(runtime.calls[1].messages.find(message => message.id === 'a1').source.replayState, { response: 'native-response', blocks: [null] })
  const adviceB = makeAdviceMessage('advice B', { routeKey: adviceRouteKey(preset) })
  const third = await collect(adapter.stream({ provider: 'moa', model: 'native', sessionId: 'real-session', messages: [user, adviceA, assistant, tool, adviceB] }))
  assert.equal(runtime.calls[2].sessionId, runtime.calls[1].sessionId, 'outer identity must preserve the TUI project directory')
  assert.notEqual(third[0].replayState.response.scope, first[0].replayState.response.scope, 'rewrites still invalidate opaque replay')
  assert.equal(runtime.calls[2].messages.find(message => message.id === 'a1').source.replayState, undefined)
  assert.equal(runtime.calls[2].messages.filter(message => message.source?.kind === 'plugin:moa-cache-boundary').length, 1)
  assert.deepEqual(runtime.calls[2].messages.filter(message => message.source?.kind !== 'plugin:moa-cache-boundary').map(message => message.id), [user.id, assistant.id, tool.id, adviceB.id])
})

check('adapter: unverified native routes retain fresh session identities on a history rewrite', async () => {
  for (const aggregator of [
    { provider: 'deepseek-official', model: 'ai/auto/claude-opus-5-5' },
    { provider: 'other-anthropic', model: 'ai/ai/claude-tui/claude-sonnet-5-5' },
    { provider: 'other', model: 'gateway/session/test' },
  ]) {
    const preset = { id: 'unverified', aggregator }
    const runtime = runtimeFor([{ type: 'finish', reason: { kind: 'stop' }, replayState: { response: 'old-native-response' } }])
    const adapter = createMoaAdapter({ runtime, presets: new Map([[preset.id, preset]]) })
    const user = textMessage('u', 'user', 'request', 'user')
    const first = await collect(adapter.stream({ provider: 'moa', model: preset.id, sessionId: 'host-unverified', messages: [user, makeAdviceMessage('old', { routeKey: adviceRouteKey(preset) })] }))
    const assistant = { ...textMessage('a', 'assistant', 'answer', 'model'), source: { kind: 'model', provider: 'moa', model: preset.id, replayState: first[0].replayState } }
    const second = await collect(adapter.stream({ provider: 'moa', model: preset.id, sessionId: 'host-unverified', messages: [user, assistant, makeAdviceMessage('new', { routeKey: adviceRouteKey(preset) })] }))
    assert.notEqual(runtime.calls[1].sessionId, runtime.calls[0].sessionId)
    assert.notEqual(second[0].replayState.response.scope, first[0].replayState.response.scope)
    assert.equal(runtime.calls[1].messages.find(message => message.id === 'a').source.replayState, undefined)
  }
})

check('adapter: resolving a cached preset applies newly saved model capabilities', async () => {
  let dirty = false
  const table = new Map([['easy', { ...presets.get('easy'), aggregator: { ...AGG } }]])
  const calls = []
  const runtime = { async resolveModelInfo(provider, model) { calls.push([provider, model]); return { context: { contextWindow: model === 'new-model' ? 200000 : 100000 } } } }
  const refresh = () => { const changed = dirty; dirty = false; return changed }
  const adapter = createMoaAdapter({ runtime, presets: table, refresh })
  assert.equal((await adapter.resolveModel('moa', 'easy')).context.contextWindow, 100000)
  table.get('easy').aggregator.model = 'new-model'
  dirty = true
  assert.equal((await adapter.resolveModel('moa', 'easy')).context.contextWindow, 200000)
  assert.deepEqual(calls, [[AGG.provider, AGG.model], [AGG.provider, 'new-model']])
})

let passed = 0
let failed = 0
for (const [name, fn] of checks) {
  try {
    await fn()
    passed += 1
    console.log(`ok ${passed} - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`not ok - ${name}`)
    console.error(error?.stack || error)
  }
}

console.log(`\ncore self-test: ${passed} passed, ${failed} failed (${checks.length} total)`)
if (failed > 0) process.exitCode = 1
