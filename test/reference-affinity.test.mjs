import assert from 'node:assert/strict'
import test from 'node:test'

import { createAdviceEngine } from '../advice.js'
import {
  createDialogueStore, SETUP_USER, SETUP_ASSISTANT, QUOTED, NEW_DELTA, SUFFIX,
} from '../dialogue.js'

const TUI = { provider: 'magpie-anthropic', model: 'ai/ai/claude-tui/claude-opus-5-5', capabilities: { nativeSession: true, requestReconciliation: true, adviceBoundary: true } }
const message = (id, text, role = 'user') => ({
  id, role, content: [{ type: 'text', text }],
  source: role === 'user' ? { kind: 'user' } : { kind: 'tool', callId: id },
  ...(role === 'tool' ? { toolCallId: id } : {}),
})
const textOf = entry => entry.content.map(block => block.text ?? '').join('')

function session(id = 'main-affinity-a', presetId = 'affinity') {
  return {
    header: { id }, history: [], presetId,
    requestHeader() { return { config: { provider: 'moa', model: this.presetId } } },
    deriveMessages() { return this.history },
  }
}

async function harness(t, references = [{ id: 'slot-a', ...TUI }]) {
  const calls = []
  const plans = []
  const runtime = {
    async *stream(options) {
      const number = calls.length + 1
      const content = [
        { type: 'reasoning', text: `analysis-${number}`, signature: `signature-${number}` },
        { type: 'text', text: `Advice ${number}: check the current evidence.` },
      ]
      const replayState = { response: { id: `native-${number}` }, blocks: [null, null] }
      calls.push({ options, content, replayState })
      for (const [index, block] of content.entries()) {
        yield { type: 'block-start', index, blockType: block.type }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: 'stop' }, replayState }
    },
  }
  const preset = {
    id: 'affinity', fanout: 'per_iteration', references,
    aggregator: { provider: 'fake', model: 'actor' },
    referenceMaxTokens: 512, referenceTimeoutMs: 10000, deadlineMs: 20000,
  }
  const config = {
    enabled: true, defaultPreset: preset.id, referenceSchedule: 'parallel',
    referenceTimeoutMs: 10000, deadlineMs: 20000,
    maxDialogueChars: 100000, maxTranscriptChars: 50000, maxMessageChars: 20000,
    guardEnabled: false, persistentTags: ['*'], recordRuns: 20,
  }
  const store = createDialogueStore({ persistentTags: ['*'], maxChars: 6000 })
  await store.load()
  const prepare = store.prepare
  store.prepare = input => {
    const plan = prepare(input)
    plans.push(plan)
    return plan
  }
  const presets = new Map([[preset.id, preset]])
  const engine = createAdviceEngine({ runtime, store, presets, config, log: null })
  await engine.load()
  t.after(async () => { await engine.close(); await store.close() })
  let step = 0
  async function run(owner, dispatches = preset.references.length) {
    const before = calls.length
    const decision = await engine.preStep({ agent: { session: owner }, turn: 1, step: ++step,
      signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.kind, 'enter')
    assert.equal(calls.length - before, dispatches)
    return calls.slice(before)
  }
  return { calls, plans, preset, presets, config, run }
}

function assertFresh(call, plans, stale = []) {
  const plan = plans.findLast(entry => call.options.sessionId.startsWith(`moa-ref-${entry.key.slice(0, 32)}`))
  assert.ok(plan, 'the engine must expose the plan used for this reference session')
  const source = plan.source
  assert.deepEqual(call.options.messages, [
    { role: 'user', content: [{ type: 'text', text: SETUP_USER + '\n\n' + QUOTED + source }], source: undefined },
    { role: 'assistant', content: [{ type: 'text', text: SETUP_ASSISTANT }],
      source: { kind: 'model', provider: call.options.provider, model: call.options.model } },
    { role: 'user', content: [{ type: 'text', text: SUFFIX }], source: undefined },
  ], 'reset must send only the fresh setup and full current source')
  for (const entry of call.options.messages) {
    assert.equal(entry.source?.replayState, undefined)
    assert.equal(textOf(entry).includes(NEW_DELTA), false)
  }
  for (const previous of stale) {
    assert.equal(JSON.stringify(call.options.messages).includes(previous.replayState.response.id), false)
    assert.equal(JSON.stringify(call.options.messages).includes(previous.content[1].text), false)
  }
}

const routes = [
  // bareId: the outer id carries no epoch suffix (request-truth TUI). keepsEpoch: a
  // rebuilt request keeps its transport epoch (stateless routes and the verified TUI);
  // a stateful native route that does not verify the request rotates it.
  { label: 'verified Claude TUI', route: TUI, bareId: true, keepsEpoch: true },
  { label: 'other provider with a Claude TUI model', route: { provider: 'other-anthropic', model: TUI.model }, bareId: false, keepsEpoch: false },
  { label: 'magpie-anthropic with a non-TUI model', route: { provider: 'magpie-anthropic', model: 'ai/ai/claude-api/claude-opus-5-5' }, bareId: false, keepsEpoch: true },
  { label: 'deepseek-official Opus', route: { provider: 'deepseek-official', model: 'ai/auto/claude-opus-5-5' }, bareId: false, keepsEpoch: false },
]

for (const { label, route, bareId, keepsEpoch } of routes) {
  test(`${label}: append preserves replay and reset uses a fresh scaffold with ${keepsEpoch ? 'kept' : 'rotated'} outer id`, async t => {
    const h = await harness(t, [{ id: 'slot-a', ...route }])
    const owner = session()
    owner.history.push(message('u-1', 'Inspect the synthetic task.'))
    const [first] = await h.run(owner)
    assert.equal(h.plans.at(-1).reason, 'initial')
    assertFresh(first, h.plans)
    assert.match(first.options.sessionId, bareId ? /^moa-ref-[a-f0-9]{32}$/ : /^moa-ref-[a-f0-9]{32}-[a-f0-9]{12}$/)

    owner.history.push(message('result-1', 'Recorded first tool result.', 'tool'))
    const [append] = await h.run(owner)
    assert.equal(h.plans.at(-1).reason, 'append')
    assert.equal(append.options.sessionId, first.options.sessionId)
    assert.deepEqual(append.options.messages.slice(0, first.options.messages.length), first.options.messages)
    const priorReply = append.options.messages.at(-2)
    assert.equal(priorReply.role, 'assistant')
    assert.deepEqual(priorReply.content, first.content)
    assert.deepEqual(priorReply.source.replayState, first.replayState)
    assert.ok(textOf(append.options.messages.at(-1)).startsWith(NEW_DELTA))

    owner.history.push(message('large-result', 'synthetic result '.repeat(500), 'tool'))
    const [sizeReset] = await h.run(owner)
    assert.ok(h.plans.at(-1).source.startsWith(h.plans.at(-2).source), 'fixture must remain append-only before the dialogue size reset')
    assert.ok(h.plans.at(-1).source.length < h.config.maxTranscriptChars, 'fixture must not exercise source-window truncation')
    assert.equal(h.plans.at(-1).reason, 'size')
    assert.equal(h.plans.at(-1).reset, true)
    assert.equal(h.plans[0].key, h.plans.at(-1).key, 'rotation must exercise the same dialogue key')
    if (keepsEpoch) assert.equal(h.plans[0].transportEpoch, h.plans.at(-1).transportEpoch, 'a stable transport keeps its epoch across a size rebuild')
    else assert.notEqual(h.plans[0].transportEpoch, h.plans.at(-1).transportEpoch)
    if (keepsEpoch) assert.equal(sizeReset.options.sessionId, first.options.sessionId)
    else assert.notEqual(sizeReset.options.sessionId, append.options.sessionId)
    assertFresh(sizeReset, h.plans, [first, append])

    owner.history = [message('compressed-task', 'A rebuilt synthetic transcript replaces the earlier window.')]
    const [rebase] = await h.run(owner)
    assert.equal(h.plans.at(-1).reason, 'rebased')
    if (keepsEpoch) assert.equal(rebase.options.sessionId, first.options.sessionId)
    else assert.notEqual(rebase.options.sessionId, sizeReset.options.sessionId)
    assertFresh(rebase, h.plans, [first, append, sizeReset])
  })
}

test('verified Claude TUI outer id isolates owner, duplicate slots, changed slot id, preset key and cache scope', async t => {
  const h = await harness(t, [{ id: 'slot-a', ...TUI }, { id: 'slot-b', ...TUI }])
  const owner = session()
  owner.history.push(message('task-a', 'Independent affinity fixture.'))
  const first = await h.run(owner)
  assert.notEqual(first[0].options.sessionId, first[1].options.sessionId, 'same-route slots cannot share a provider session')

  const other = session('main-affinity-b')
  other.history.push(message('task-a', 'Independent affinity fixture.'))
  const otherCalls = await h.run(other)
  const ids = new Set(first.map(call => call.options.sessionId))
  for (const call of otherCalls) { assert.equal(ids.has(call.options.sessionId), false); ids.add(call.options.sessionId) }

  h.preset.references[0] = { ...h.preset.references[0], id: 'changed-slot-a' }
  const [changedSlot] = await h.run(owner, 1)
  assert.equal(h.plans.at(-2).reason, 'initial')
  assert.equal(ids.has(changedSlot.options.sessionId), false)
  ids.add(changedSlot.options.sessionId)
  assertFresh(changedSlot, h.plans, first)

  const alternate = { ...h.preset, id: 'alternate-preset' }
  h.presets.set(alternate.id, alternate)
  owner.presetId = alternate.id
  const [changedPreset] = await h.run(owner)
  assert.equal(ids.has(changedPreset.options.sessionId), false)
  ids.add(changedPreset.options.sessionId)
  assertFresh(changedPreset, h.plans, [changedSlot])

  h.preset.references[0] = { ...h.preset.references[0], cacheScope: 'independent-scope' }
  const [changedScope] = await h.run(owner, 1)
  assert.equal(ids.has(changedScope.options.sessionId), false)
  assertFresh(changedScope, h.plans, [changedPreset])
})
