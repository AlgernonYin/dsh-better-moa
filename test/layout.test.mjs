import assert from 'node:assert/strict'
import test from 'node:test'
import { createMoaAdapter } from '../adapter.js'
import { createAdvicePlacement, layoutAdviceForAggregator } from '../layout.js'
import { makeAdviceMessage } from '../transcript.js'
import { replaceAdviceInSurface } from '../surface.js'

const preset = { id: 'layout-test', aggregator: { provider: 'native', model: 'claude-tui/test' } }
const text = (id, value = id) => ({ id, role: 'user', content: [{ type: 'text', text: value }], source: { kind: 'user' } })
const enter = (...messages) => ({ kind: 'enter', messages })
const opinion = value => makeAdviceMessage(value, { preset: preset.id })
const isOpinion = message => message.source?.kind === 'plugin:moa'

function fixture() {
  const events = []
  const surface = { nodes: [] }
  const session = {
    events, surface,
    eventAt(seq) { return events[seq] },
    deriveEventMessage(event) { return event.type === 'user/message' ? event.data : event.data.message },
    deriveMessages() { return surface.nodes.map(seq => session.deriveEventMessage(events[seq])) },
    append(type, data, options) {
      const event = { type, data, seq: events.length }
      events.push(event)
      if (options.surfaceOp === 'append') surface.nodes.push(event.seq)
      else {
        const index = surface.nodes.indexOf(options.surfaceOp.startSeq)
        assert.ok(index >= 0)
        assert.equal(options.surfaceOp.startSeq, options.surfaceOp.endSeq)
        assert.deepEqual(options.sourceEventSeqs, [options.surfaceOp.startSeq])
        surface.nodes[index] = event.seq
      }
      return event
    },
  }
  const append = message => session.append(message.role === 'tool' ? 'tool/result' : message.role === 'assistant' ? 'assistant/message' : 'user/message', message.role === 'user' ? message : { message }, { surfaceOp: 'append' })
  const commit = decision => decision.messages.forEach(append)
  const advise = value => commit(replaceAdviceInSurface(session, enter(opinion(value))))
  return { session, append, commit, advise }
}

function toolPair(n, replayState) {
  return [
    { id: `a-${n}`, role: 'assistant', source: { kind: 'model', provider: 'moa', model: preset.id, replayState }, content: [
      { type: 'reasoning', text: `reasoning-${n}`, signature: `signature-${n}` },
      { type: 'tool-call', id: `call-${n}`, name: 'probe', arguments: JSON.stringify({ seq: n }) },
    ] },
    { id: `t-${n}`, role: 'tool', toolCallId: `call-${n}`, source: { kind: 'tool', callId: `call-${n}` }, content: [{ type: 'text', text: `receipt-${n}` }] },
  ]
}

async function collect(iterable) { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks }

 test('anchored request layout moves only on changed opinions and keeps every tool/replay body', async () => {
  const { session, append, advise } = fixture()
  append(text('human', 'A large immutable fixture'))
  const calls = []
  const runtime = {
    adapterStream(options) { return this.stream(options) },
    async *stream(options) {
      calls.push(options)
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: `native-${calls.length}` } } }
    },
  }
  const adapter = createMoaAdapter({ runtime, presets: new Map([[preset.id, preset]]), config: { adviceHistory: 'latest' } })
  const work = session.deriveMessages()
  const positions = []
  const sessions = []
  for (let step = 1; step <= 8; step++) {
    if ([1, 4, 7].includes(step)) advise(`REVIEW-${Math.ceil(step / 3)}`)
    const chunks = await collect(adapter.stream({ provider: 'moa', model: preset.id, sessionId: 'host-layout', messages: session.deriveMessages(), system: 'fixed system', tools: [] }))
    const forwarded = calls.at(-1)
    const index = forwarded.messages.findIndex(isOpinion)
    positions.push(index)
    sessions.push(forwarded.sessionId)
    assert.equal(forwarded.messages.filter(isOpinion).length, 1)
    assert.match(forwarded.messages[index].content[0].text, new RegExp(`^REVIEW-${Math.ceil(step / 3)}$`))
    const providerWork = forwarded.messages.filter(message => !isOpinion(message))
    assert.equal(providerWork.length, work.length)
    for (let i = 0; i < work.length; i++) {
      assert.equal(providerWork[i].content, work[i].content)
      if (work[i].role === 'tool') assert.equal(providerWork[i], work[i])
    }
    if (step < 8) {
      const pair = toolPair(step, chunks.at(-1).replayState)
      pair.forEach(append)
      work.push(...pair)
    }
  }
  assert.deepEqual(positions, [1, 1, 1, 7, 7, 7, 13, 13])
  assert.equal(sessions[0], sessions[1])
  assert.equal(sessions[1], sessions[2])
  assert.notEqual(sessions[2], sessions[3], 'genuine guidance rewrite still needs a native generation')
  assert.equal(sessions[3], sessions[4])
  assert.equal(sessions[4], sessions[5])
  assert.notEqual(sessions[5], sessions[6])
  assert.equal(sessions[6], sessions[7])
  assert.equal(session.deriveMessages().findIndex(isOpinion), 1, 'canonical surface keeps its single physical opinion slot')
  assert.equal(session.deriveMessages().filter(isOpinion).length, 1)
})

test('late Host system headers preserve an initial work boundary without excluding ordinary user work', () => {
  const human = text('first-human')
  const context = { ...text('runtime-context'), source: { kind: 'runtime/context' } }
  const header = { role: 'system', content: [{ type: 'text', text: 'Host system' }], source: { kind: 'system-prompt' } }
  const later = { ...text('hindsight'), source: { kind: 'plugin:hindsight' } }
  const advice = opinion('current')
  advice.source.logicalPlacement = createAdvicePlacement([human, context])
  const canonical = [header, human, advice, context, later]
  const selected = layoutAdviceForAggregator(canonical, preset)
  assert.deepEqual(selected, [header, human, context, advice, later])
  assert.equal(selected[0], header)
  assert.equal(selected[4], later)
  assert.deepEqual(layoutAdviceForAggregator(JSON.parse(JSON.stringify(canonical)), preset), selected)
  const changed = [header, { ...human, content: [{ type: 'text', text: 'edited actual user work' }] }, advice, context, later]
  assert.deepEqual(layoutAdviceForAggregator(changed, preset), changed)
  const unknownPrefix = [text('unverified-leading-user'), human, advice, context, later]
  assert.deepEqual(layoutAdviceForAggregator(unknownPrefix, preset), unknownPrefix)
})

test('legacy v1 metadata still validates its complete original work prefix', () => {
  const human = text('legacy-human')
  const advice = opinion('legacy-current')
  const original = createAdvicePlacement([human])
  advice.source.logicalPlacement = { ...original, version: 1 }
  assert.deepEqual(layoutAdviceForAggregator([advice, human], preset), [human, advice])
})

test('persisted source metadata reconstructs the same request after serialization and more work', () => {
  const { session, append, advise } = fixture()
  append(text('human'))
  advise('old')
  toolPair(1).forEach(append)
  advise('new')
  toolPair(2).forEach(append)
  const history = session.deriveMessages()
  const before = JSON.stringify(layoutAdviceForAggregator(history, preset))
  const restored = JSON.parse(JSON.stringify(history))
  assert.equal(JSON.stringify(layoutAdviceForAggregator(restored, preset)), before)
  const forwarded = layoutAdviceForAggregator(restored, preset)
  assert.equal(forwarded.findIndex(isOpinion), 3)
  assert.equal(forwarded[2].toolCallId, 'call-1')
  assert.equal(forwarded[4].content[1].id, 'call-2')
})

test('identical opinions keep their previous boundary instead of moving after each tool result', () => {
  const { session, append, advise } = fixture()
  append(text('human'))
  advise('same opinion')
  const first = session.deriveMessages().find(isOpinion).source.logicalPlacement
  toolPair(1).forEach(append)
  advise('same opinion')
  const current = session.deriveMessages().find(isOpinion)
  assert.equal(current.source.logicalPlacement, first)
  assert.equal(layoutAdviceForAggregator(session.deriveMessages(), preset).findIndex(isOpinion), 1)
  assert.equal(session.deriveMessages().filter(isOpinion).length, 1)
})

test('a pending human message supplies the new boundary and is not duplicated if already committed', () => {
  const { session, append, commit, advise } = fixture()
  append(text('human'))
  advise('old')
  const pending = text('new-human')
  commit(replaceAdviceInSurface(session, enter(pending, opinion('changed'))))
  const history = session.deriveMessages()
  const selected = layoutAdviceForAggregator(history, preset)
  assert.equal(selected.findIndex(isOpinion), 2)
  assert.equal(selected[1], pending)
  assert.equal(selected.at(-1).source.logicalPlacement.anchor.id, pending.id)
  const decision = replaceAdviceInSurface(session, enter(pending, opinion('changed again')))
  assert.equal(decision.messages[0], pending)
  assert.equal(session.deriveMessages().find(isOpinion).source.logicalPlacement.workCount, 2)
})

test('content occurrences disambiguate id-free repeated messages and ids may disappear in a request adapter', () => {
  const first = text(undefined, 'repeated text')
  const second = text(undefined, 'repeated text')
  const place = createAdvicePlacement([first, second])
  assert.equal(place.anchor.occurrence, 2)
  const advice = opinion('latest')
  advice.source.logicalPlacement = place
  const history = [first, advice, second, text('later')]
  assert.deepEqual(layoutAdviceForAggregator(history, preset), [first, second, advice, history[3]])
  const identified = text('id-present', 'anchor')
  advice.source.logicalPlacement = createAdvicePlacement([identified])
  const withoutId = { ...identified }
  delete withoutId.id
  assert.deepEqual(layoutAdviceForAggregator([advice, withoutId], preset), [withoutId, advice])
})

test('missing, edited, or compacted work boundaries fall back without reordering work', () => {
  const human = text('human')
  const anchor = text('anchor')
  const advice = opinion('current')
  advice.source.logicalPlacement = createAdvicePlacement([human, anchor])
  const cases = [
    [human, advice, text('unrelated')],
    [human, advice, { ...anchor, content: [{ type: 'text', text: 'edited anchor' }] }],
    [text('summary'), advice, anchor],
    [advice, anchor],
  ]
  for (const history of cases) assert.deepEqual(layoutAdviceForAggregator(history, preset), history)
})

test('legacy opinions and malformed placement keep their original position, with other routes excluded', () => {
  const human = text('human')
  const old = opinion('legacy')
  const foreign = makeAdviceMessage('foreign route', { preset: 'different' })
  assert.deepEqual(layoutAdviceForAggregator([human, old, foreign], preset), [human, old])
  old.source.logicalPlacement = { version: 1, anchor: { hash: 'bad', occurrence: 0 } }
  assert.deepEqual(layoutAdviceForAggregator([human, old], preset), [human, old])
})
