import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createMoaAdapter } from '../adapter.js'

const MAIN_SESSION = 'main-owning-agent'
const text = (id, role, value) => ({
  id, role, content: [{ type: 'text', text: value }],
  source: { kind: role === 'assistant' ? 'model' : 'user' },
})
const human = text('human', 'user', 'original request')

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

// Model the Host waterfall's ALS entry around the entire asynchronous stream.
// A second runtime.stream call installs its options.sessionId as attribution;
// adapterStream reaches the underlying provider without installing a new store.
function harness(aggregator) {
  const als = new AsyncLocalStorage()
  const waterfallCalls = []
  const adapterCalls = []
  const providerCalls = []
  const warnings = []
  const preset = { id: 'attribution', aggregator }
  let adapter

  async function* dispatch(options) {
    const number = providerCalls.length + 1
    const replayState = { response: { opaque: `response-${number}` }, blocks: [`block-${number}`] }
    const call = { options, receiver: this, stores: [als.getStore()], replayState }
    providerCalls.push(call)
    await Promise.resolve()
    call.stores.push(als.getStore())
    yield { type: 'text-delta', text: `answer-${number}` }
    await new Promise(resolve => setImmediate(resolve))
    call.stores.push(als.getStore())
    yield { type: 'finish', reason: { kind: 'stop' }, replayState }
  }

  const runtime = {
    async *stream(options) {
      const store = { sessionId: options.sessionId, provider: options.provider, model: options.model }
      waterfallCalls.push({ options, receiver: this, store })
      const chunks = await als.run(store, async () => {
        await Promise.resolve()
        return collect(options.provider === 'moa' ? adapter.stream(options) : dispatch.call(this, options))
      })
      for (const chunk of chunks) yield chunk
    },
    adapterStream(options) {
      adapterCalls.push({ options, receiver: this, store: als.getStore() })
      return dispatch.call(this, options)
    },
  }
  adapter = createMoaAdapter({
    runtime, presets: new Map([[preset.id, preset]]),
    log: { warn: message => warnings.push(message) },
  })

  return {
    als, runtime, waterfallCalls, adapterCalls, providerCalls, warnings,
    run: options => collect(runtime.stream({
      provider: 'moa', model: preset.id, sessionId: MAIN_SESSION,
      system: 'unchanged system', tools: [], ...options,
    })),
  }
}

function replayFrom(chunks) {
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].type, 'text-delta')
  assert.equal(chunks[1].type, 'finish')
  assert.deepEqual(chunks[1].reason, { kind: 'stop' })
  return chunks[1].replayState
}

function assistant(id, replayState) {
  return {
    ...text(id, 'assistant', 'previous answer'),
    source: { kind: 'model', provider: 'moa', model: 'attribution', replayState },
  }
}

function assertNativeAttribution(h) {
  assert.equal(h.waterfallCalls.length, h.providerCalls.length, 'native dispatch must not re-enter llm/stream')
  assert.equal(h.adapterCalls.length, h.providerCalls.length)
  h.providerCalls.forEach((call, index) => {
    const outer = h.waterfallCalls[index]
    const direct = h.adapterCalls[index]
    assert.equal(outer.options.provider, 'moa')
    assert.equal(outer.receiver, h.runtime, 'outer runtime method must retain this')
    assert.equal(direct.receiver, h.runtime, 'adapterStream must retain the runtime this')
    assert.equal(call.receiver, h.runtime, 'provider dispatch must retain this')
    assert.equal(direct.options, call.options)
    assert.notEqual(call.options.sessionId, outer.options.sessionId, 'native transport uses a private session')
    assert.equal(direct.store, outer.store)
    assert.equal(outer.store.sessionId, MAIN_SESSION)
    for (const store of call.stores) {
      assert.equal(store, outer.store, 'main attribution must survive await, yield and an event-loop turn')
    }
  })
  assert.equal(h.als.getStore(), undefined, 'request context must not leak to the caller')
  assert.deepEqual(h.warnings, [])
}

for (const aggregator of [
  { provider: 'deepseek-official', model: 'ai/auto/claude-opus-5-5' },
  { provider: 'other-anthropic', model: 'ai/ai/claude-tui/claude-sonnet-5-5' },
  { provider: 'other', model: 'gateway/session/test' },
]) {
  test(`native ${aggregator.provider}/${aggregator.model}: main ALS survives g0/g1 transport and replay filtering`, async () => {
    const h = harness(aggregator)
    const firstReplay = replayFrom(await h.run({ messages: [human] }))
    const firstCall = h.providerCalls[0]
    assert.equal(firstCall.options.provider, aggregator.provider)
    assert.equal(firstCall.options.model, aggregator.model)
    assert.match(firstCall.options.sessionId, /^moa-agg-[a-f0-9]{36}-[a-f0-9]{10}-g0$/)
    assert.match(firstReplay.response.scope, /:g0$/)
    assert.equal(firstReplay.response.provider, aggregator.provider)
    assert.equal(firstReplay.response.model, aggregator.model)
    assert.deepEqual(firstReplay.response.inner, firstCall.replayState.response)
    assert.deepEqual(firstReplay.blocks, firstCall.replayState.blocks)

    const previous = assistant('previous', firstReplay)
    const followup = text('followup', 'user', 'continue')
    const extended = [human, previous, followup]
    const original = structuredClone(extended)
    const secondReplay = replayFrom(await h.run({ messages: extended }))
    const secondCall = h.providerCalls[1]
    assert.equal(secondCall.options.sessionId, firstCall.options.sessionId, 'append-only work reuses g0')
    assert.equal(secondReplay.response.scope, firstReplay.response.scope)
    const accepted = secondCall.options.messages.find(message => message.id === 'previous')
    assert.equal(accepted.source.provider, aggregator.provider)
    assert.equal(accepted.source.model, aggregator.model)
    assert.deepEqual(accepted.source.replayState, firstCall.replayState)
    assert.deepEqual(extended, original, 'forwarding must not mutate stored MoA replay')

    const rewritten = [text('human', 'user', 'edited request'), previous, followup]
    const thirdReplay = replayFrom(await h.run({ messages: rewritten }))
    const thirdCall = h.providerCalls[2]
    assert.equal(thirdCall.options.sessionId, firstCall.options.sessionId.replace(/-g0$/, '-g1'))
    assert.equal(thirdReplay.response.scope, firstReplay.response.scope.replace(/:g0$/, ':g1'))
    const rejected = thirdCall.options.messages.find(message => message.id === 'previous')
    assert.equal(Object.hasOwn(rejected.source, 'replayState'), false, 'a g0 envelope cannot resume g1')
    assert.equal(previous.source.replayState, firstReplay, 'filtering must keep the canonical envelope')

    const current = assistant('current', thirdReplay)
    const fourthReplay = replayFrom(await h.run({ messages: [...rewritten, current] }))
    const fourthCall = h.providerCalls[3]
    assert.equal(fourthCall.options.sessionId, thirdCall.options.sessionId)
    assert.equal(fourthReplay.response.scope, thirdReplay.response.scope)
    assert.equal(Object.hasOwn(fourthCall.options.messages.find(message => message.id === 'previous').source, 'replayState'), false)
    assert.deepEqual(fourthCall.options.messages.find(message => message.id === 'current').source.replayState, thirdCall.replayState)
    assertNativeAttribution(h)
  })
}

test('verified Claude TUI retains its workspace transport while replay generation changes under main ALS', async () => {
  const h = harness({ provider: 'magpie-anthropic', model: 'ai/ai/claude-tui/claude-sonnet-5-5', capabilities: { nativeSession: true, requestReconciliation: true, adviceBoundary: true } })
  const firstReplay = replayFrom(await h.run({ messages: [human] }))
  const previous = assistant('previous', firstReplay)
  replayFrom(await h.run({ messages: [human, previous] }))
  const changedReplay = replayFrom(await h.run({ messages: [text('human', 'user', 'rewritten request'), previous] }))
  assert.match(h.providerCalls[0].options.sessionId, /^moa-agg-[a-f0-9]{36}-[a-f0-9]{10}$/)
  assert.equal(h.providerCalls[1].options.sessionId, h.providerCalls[0].options.sessionId)
  assert.equal(h.providerCalls[2].options.sessionId, h.providerCalls[0].options.sessionId, 'the TUI project identity must remain stable')
  assert.match(firstReplay.response.scope, /:g0$/)
  assert.equal(changedReplay.response.scope, firstReplay.response.scope.replace(/:g0$/, ':g1'))
  assert.deepEqual(h.providerCalls[1].options.messages.find(message => message.id === 'previous').source.replayState, h.providerCalls[0].replayState)
  assert.equal(Object.hasOwn(h.providerCalls[2].options.messages.find(message => message.id === 'previous').source, 'replayState'), false)
  assertNativeAttribution(h)
})

for (const available of [true, false]) {
  test(`non-native routes retain runtime.stream and main session (${available ? 'with' : 'without'} adapterStream)`, async () => {
    const h = harness({ provider: 'ordinary-provider', model: 'stateless-model' })
    if (!available) delete h.runtime.adapterStream
    replayFrom(await h.run({ messages: [human] }))
    assert.equal(h.waterfallCalls.length, 2)
    assert.deepEqual(h.waterfallCalls.map(call => call.options.provider), ['moa', 'ordinary-provider'])
    assert.equal(h.adapterCalls.length, 0)
    assert.equal(h.providerCalls.length, 1)
    assert.equal(h.providerCalls[0].options.sessionId, MAIN_SESSION)
    for (const call of h.waterfallCalls) {
      assert.equal(call.receiver, h.runtime, 'runtime.stream must keep this on the forwarded call')
      assert.equal(call.store.sessionId, MAIN_SESSION)
    }
    assert.equal(h.providerCalls[0].receiver, h.runtime)
    for (const store of h.providerCalls[0].stores) assert.equal(store, h.waterfallCalls[1].store)
    assert.equal(h.als.getStore(), undefined)
    assert.deepEqual(h.warnings, [])
  })
}

for (const unavailable of [undefined, null]) {
  test(`native routes fail clearly without adapterStream (${String(unavailable)}) and never re-enter the waterfall`, async () => {
    const h = harness({ provider: 'deepseek-official', model: 'native-model' })
    if (unavailable === undefined) delete h.runtime.adapterStream
    else h.runtime.adapterStream = unavailable
    const chunks = await h.run({ messages: [human] })
    assert.deepEqual(chunks, [{
      type: 'finish', reason: { kind: 'error', failure: {
        code: 'moa/aggregator-failed',
        message: '[moa] aggregator call failed: native MoA transport requires LlmRuntime.adapterStream for correct context attribution',
      } },
    }])
    assert.equal(h.waterfallCalls.length, 1, 'missing direct support must not fall back to a private-id waterfall')
    assert.equal(h.adapterCalls.length, 0)
    assert.equal(h.providerCalls.length, 0)
    assert.deepEqual(h.warnings, ['[moa] aggregator call failed: native MoA transport requires LlmRuntime.adapterStream for correct context attribution'])
    assert.equal(h.als.getStore(), undefined)
  })
}

test('a native route without a session has no private transport and keeps runtime.stream available', async () => {
  const h = harness({ provider: 'deepseek-official', model: 'native-model' })
  delete h.runtime.adapterStream
  const replay = replayFrom(await h.run({ sessionId: undefined, messages: [human] }))
  assert.equal(h.waterfallCalls.length, 2)
  assert.equal(h.adapterCalls.length, 0)
  assert.equal(h.providerCalls.length, 1)
  assert.equal(h.providerCalls[0].options.sessionId, undefined)
  assert.equal(Object.hasOwn(replay.response, 'scope'), false)
  assert.deepEqual(h.warnings, [])
})

test('interleaved native owners preserve their own main ALS across asynchronous provider chunks', async () => {
  const h = harness({ provider: 'deepseek-official', model: 'native-model' })
  const owners = ['owner-one', 'owner-two']
  const results = await Promise.all(owners.map(sessionId => h.run({ sessionId, messages: [human] })))
  results.forEach(replayFrom)
  assert.equal(h.waterfallCalls.length, 2)
  assert.equal(h.adapterCalls.length, 2)
  assert.equal(h.providerCalls.length, 2)
  assert.notEqual(h.providerCalls[0].options.sessionId, h.providerCalls[1].options.sessionId)
  h.providerCalls.forEach((call, index) => {
    assert.equal(call.receiver, h.runtime)
    assert.equal(h.adapterCalls[index].receiver, h.runtime)
    assert.equal(h.adapterCalls[index].store, h.waterfallCalls[index].store)
    assert.match(call.options.sessionId, /-g0$/)
    for (const store of call.stores) {
      assert.equal(store, h.waterfallCalls[index].store)
      assert.equal(store.sessionId, owners[index])
    }
  })
  assert.equal(h.als.getStore(), undefined)
  assert.deepEqual(h.warnings, [])
})
