import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRouteCapabilities, normalizeRouteCapabilities, stableReferenceTransport, referenceTransportId } from '../capabilities.js'
import { normalizeConfig, buildPresetTable } from '../config.js'
import { createMoaAdapter } from '../adapter.js'
import { usesAdviceBoundary, BOUNDARY_KIND } from '../boundary.js'
import { createAdviceEngine } from '../advice.js'
import { createDialogueStore } from '../dialogue.js'

const verified = { nativeSession: true, requestReconciliation: true, adviceBoundary: true }
const renamed = { provider: 'my-renamed-provider', model: 'my-renamed-model', capabilities: verified }
const human = text => ({ id: 'human', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const collect = async iterable => { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks }

test('explicit capabilities survive both config normalization passes, including false; invalid values never opt in', () => {
  const input = { ...verified, nativeSession: false, unknown: true }
  const config = normalizeConfig({ presetOverrides: { portable: {
    aggregator: { ...renamed, capabilities: input },
    references: [{ id: 'r', ...renamed, capabilities: { ...input, adviceBoundary: 'true' } }],
  } } })
  const preset = buildPresetTable(config).get('portable')
  assert.deepEqual(preset.aggregator.capabilities, { nativeSession: false, requestReconciliation: true, adviceBoundary: true })
  assert.deepEqual(preset.references[0].capabilities, { nativeSession: false, requestReconciliation: true })
  assert.deepEqual(normalizeRouteCapabilities(['nativeSession']), {})
  assert.deepEqual(normalizeRouteCapabilities({ nativeSession: 1, requestReconciliation: 'true', adviceBoundary: null }), {})
  assert.deepEqual(normalizeRouteCapabilities(Object.create(verified)), {})
})

test('generic native naming only enables conservative rotation; renamed routes use explicit guarantees', () => {
  for (const route of [
    { provider: 'deepseek-official', model: 'any' },
    { provider: 'unverified', model: 'claude-tui/model' },
    { provider: 'unverified', model: 'some/session/model' },
  ]) {
    assert.deepEqual(resolveRouteCapabilities(route), { nativeSession: true, requestReconciliation: false, adviceBoundary: false })
    assert.equal(stableReferenceTransport(route), false)
  }
  assert.deepEqual(resolveRouteCapabilities(renamed), verified)
  assert.equal(usesAdviceBoundary(renamed), true)
  assert.equal(stableReferenceTransport(renamed), true)
  assert.equal(usesAdviceBoundary({ ...renamed, capabilities: { ...verified, adviceBoundary: false } }), false)
  const plan = { key: 'a'.repeat(64), transportEpoch: 'b'.repeat(32) }
  assert.equal(referenceTransportId(plan, renamed), `moa-ref-${'a'.repeat(32)}`)
  const rotate = { ...renamed, sessionPolicy: 'rotate' }
  assert.equal(stableReferenceTransport(rotate), false)
  assert.equal(referenceTransportId(plan, rotate), `moa-ref-${'a'.repeat(32)}-${'b'.repeat(12)}`)
  assert.equal(stableReferenceTransport({ provider: 'deepseek-official', model: 'm', sessionPolicy: 'stable' }), true)
})

for (const reconciles of [true, false]) {
  test(`renamed aggregator ${reconciles ? 'keeps' : 'rotates'} native transport on rewrite, but always rejects old replay`, async () => {
    const calls = []
    const aggregator = { ...renamed, capabilities: { ...verified, requestReconciliation: reconciles } }
    const preset = { id: 'portable', aggregator }
    const runtime = {
      stream() { throw new Error('native transport must preserve outer runtime attribution') },
      async *adapterStream(options) {
        calls.push(options)
        yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: calls.length } } }
      },
    }
    const adapter = createMoaAdapter({ runtime, presets: new Map([[preset.id, preset]]) })
    const run = messages => collect(adapter.stream({ provider: 'moa', model: preset.id, sessionId: 'owner', messages, system: 'sys', tools: [] }))
    const advice = { id: 'advice', role: 'user', content: [{ type: 'text', text: 'Advice.' }], source: { kind: 'plugin:moa', preset: preset.id } }
    const first = await run([human('original'), advice])
    const previous = { id: 'previous', role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'moa', model: preset.id, replayState: first[0].replayState } }
    await run([human('original'), advice, previous])
    assert.equal(calls[1].sessionId, calls[0].sessionId)
    assert.deepEqual(calls[1].messages.find(m => m.id === 'previous').source.replayState, { response: { id: 1 } })
    const rewritten = await run([human('rewritten'), advice, previous])
    assert.equal(calls[2].sessionId === calls[0].sessionId, reconciles)
    assert.equal(calls[2].messages.find(m => m.id === 'previous').source.replayState, undefined)
    assert.notEqual(rewritten[0].replayState.response.scope, first[0].replayState.response.scope)
    assert.equal(calls[2].messages.filter(m => m.source?.kind === BOUNDARY_KIND).length, 1)
  })
}

test('explicit non-native override retains owning session and waterfall even for heuristic-native names', async () => {
  const calls = []
  const aggregator = { provider: 'custom', model: 'claude-tui/model', capabilities: { nativeSession: false } }
  const runtime = { async *stream(options) { calls.push(options); yield { type: 'finish' } } }
  const adapter = createMoaAdapter({ runtime, presets: new Map([['p', { id: 'p', aggregator }]]) })
  await collect(adapter.stream({ model: 'p', sessionId: 'owner', messages: [human('task')] }))
  assert.equal(calls[0].sessionId, 'owner')
})

for (const policy of [undefined, 'rotate']) {
  test(`renamed reference integration: full rebase drops replay with ${policy || 'automatic stable'} transport`, async t => {
    const calls = []
    const store = createDialogueStore({ persistentTags: ['*'], maxChars: 100000 })
    const runtime = { async *stream(options) {
      calls.push(options)
      yield { type: 'text-delta', text: 'Check the evidence.' }
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: `opaque-${calls.length}` } } }
    } }
    const preset = { id: 'p', fanout: 'per_iteration', aggregator: { provider: 'fake', model: 'actor' }, references: [{ id: 'r', ...renamed, sessionPolicy: policy }], referenceMaxTokens: 512 }
    const config = { enabled: true, defaultPreset: 'p', referenceTimeoutMs: 10000, deadlineMs: 20000, maxTranscriptChars: 50000, maxMessageChars: 20000, guardEnabled: false, persistentTags: ['*'], recordRuns: 10 }
    const engine = createAdviceEngine({ runtime, store, presets: new Map([['p', preset]]), config })
    await store.load(); await engine.load()
    t.after(async () => { await engine.close(); await store.close() })
    const owner = { header: { id: 'owner' }, history: [human('original')], requestHeader() { return { config: { provider: 'moa', model: 'p' } } }, deriveMessages() { return this.history } }
    const run = step => engine.preStep({ agent: { session: owner }, turn: 1, step, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    await run(1)
    owner.history.push({ ...human('followup'), id: 'next' })
    await run(2)
    assert.equal(calls[1].sessionId, calls[0].sessionId)
    assert.ok(calls[1].messages.some(m => m.source?.replayState?.response?.id === 'opaque-1'))
    owner.history = [human('replacement transcript')]
    await run(3)
    assert.equal(calls[2].sessionId === calls[0].sessionId, policy !== 'rotate')
    assert.ok(calls[2].messages.every(m => !m.source?.replayState))
    assert.equal(JSON.stringify(calls[2].messages).includes('opaque-1'), false)
  })
}
