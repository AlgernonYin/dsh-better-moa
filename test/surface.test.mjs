import assert from 'node:assert/strict'
import test from 'node:test'
import { adviceSurfaceEntries, replaceAdviceInSurface, isRetiredAdvice } from '../surface.js'
import { makeAdviceMessage, selectAdviceForAggregator } from '../transcript.js'

const preset = { id: 'surface-test', aggregator: { provider: 'fake', model: 'agg' } }
const user = text => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const enter = (...messages) => ({ kind: 'enter', messages, startsRequestSeries: true })
const textOf = message => (message.content || []).map(block => block.text || '').join('')

function fixture() {
  const events = []
  const surface = { nodes: [], replaceGeneration: 0 }
  const session = {
    surface,
    events,
    eventAt(seq) { return events[seq] },
    deriveEventMessage(event) { return event.type === 'user/message' ? event.data : event.data.message },
    deriveMessages() { return surface.nodes.map(seq => session.deriveEventMessage(events[seq])) },
    append(type, data, options) {
      const event = { type, data, seq: events.length, ...options }
      const op = options.surfaceOp
      if (op === 'append') surface.nodes.push(event.seq)
      else {
        const start = surface.nodes.indexOf(op.startSeq)
        const end = surface.nodes.indexOf(op.endSeq)
        assert.ok(start >= 0 && end >= start, 'replacement must name live surface positions')
        assert.equal(start, end, 'MoA must only replace individual nodes')
        assert.equal(events[op.startSeq].type, 'user/message', 'never replace assistant/tool nodes')
        assert.deepEqual(options.sourceEventSeqs, [op.startSeq], 'replacement must declare every shadowed source node')
        surface.nodes.splice(start, 1, event.seq)
        surface.replaceGeneration++
      }
      events.push(event)
      return event
    },
  }
  function commit(decision) {
    for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
  }
  return { session, commit }
}

function toolPair(session, n) {
  const call = {
    role: 'assistant',
    content: [{ type: 'tool-call', id: `call-${n}`, name: 'probe', arguments: '{}' }],
    source: { kind: 'model', provider: 'fake', model: 'agg', replayState: { response: { id: `r${n}` } } },
  }
  const result = { role: 'tool', toolCallId: `call-${n}`, content: [{ type: 'text', text: `actual result ${n}` }], source: { kind: 'tool', callId: `call-${n}` } }
  session.append('assistant/message', { message: call }, { surfaceOp: 'append' })
  session.append('tool/result', { message: result }, { surfaceOp: 'append' })
  return [call, result]
}

test('100 advice updates retain one active opinion and original tool/replay objects', () => {
  const { session, commit } = fixture()
  session.append('user/message', user('original human task'), { surfaceOp: 'append' })
  const first = makeAdviceMessage('STALE-private-marker-' + 'x'.repeat(10000), { preset: preset.id })
  commit(replaceAdviceInSurface(session, enter(first)))
  const pairs = []
  for (let index = 1; index <= 100; index++) {
    pairs.push(...toolPair(session, index))
    const next = makeAdviceMessage(`CURRENT-${index}`, { preset: preset.id })
    const decision = replaceAdviceInSurface(session, enter(next))
    assert.equal(decision.messages.length, 0, 'LOOP must not append the replacement again')
    assert.equal(decision.startsRequestSeries, true)
    commit(decision)
    const active = adviceSurfaceEntries(session).filter(entry => !isRetiredAdvice(entry.message))
    assert.equal(active.length, 1)
    assert.equal(active[0].message.content, next.content)
    assert.equal(active[0].message.source.logicalPlacement.version, 2)
    assert.equal(next.source.logicalPlacement, undefined, 'input advice must not be mutated')
  }
  const visible = session.deriveMessages()
  assert.equal(visible.length, 202, 'one human, one opinion and 100 real tool pairs')
  const serializedCompactionInput = visible.map(textOf).join('\n')
  assert.doesNotMatch(serializedCompactionInput, /STALE-private-marker/)
  assert.doesNotMatch(serializedCompactionInput, /CURRENT-99\b/)
  assert.match(serializedCompactionInput, /CURRENT-100/)
  assert.ok(session.events.some(event => textOf(session.deriveEventMessage(event)).includes('STALE-private-marker')), 'audit log must preserve the original event')
  for (let index = 0; index < pairs.length; index++) assert.equal(visible[index + 2], pairs[index])
})

test('legacy noncontiguous opinions retire once without replacing any intervening work', () => {
  const { session, commit } = fixture()
  session.append('user/message', makeAdviceMessage('LEGACY-A', { preset: preset.id }), { surfaceOp: 'append' })
  const pair = toolPair(session, 1)
  session.append('user/message', user('second human instruction'), { surfaceOp: 'append' })
  session.append('user/message', makeAdviceMessage('LEGACY-B', { preset: preset.id }), { surfaceOp: 'append' })
  const realWork = session.deriveMessages().filter(message => message.source.kind !== 'plugin:moa')
  commit(replaceAdviceInSurface(session, enter(makeAdviceMessage('CURRENT-C', { preset: preset.id }))))
  const nodes = session.surface.nodes.length
  const changes = session.surface.replaceGeneration
  const entries = adviceSurfaceEntries(session)
  assert.equal(entries.filter(entry => !isRetiredAdvice(entry.message)).length, 1)
  assert.equal(entries.filter(entry => isRetiredAdvice(entry.message)).length, 1)
  assert.doesNotMatch(session.deriveMessages().map(textOf).join('\n'), /LEGACY-[AB]/)
  assert.deepEqual(session.deriveMessages().filter(message => message.source.kind !== 'plugin:moa'), realWork)
  assert.equal(session.deriveMessages()[1], pair[0])
  assert.equal(session.deriveMessages()[2], pair[1])
  commit(replaceAdviceInSurface(session, enter(makeAdviceMessage('CURRENT-D', { preset: preset.id }))))
  assert.equal(session.surface.nodes.length, nodes)
  assert.equal(session.surface.replaceGeneration, changes + 1, 'retired nodes must not be rewritten each step')
  for (const mode of ['latest', 'all']) {
    const forwarded = selectAdviceForAggregator(session.deriveMessages(), preset, mode)
    assert.equal(forwarded.filter(message => message.source.kind === 'plugin:moa').length, 1)
    assert.ok(forwarded.every(message => !isRetiredAdvice(message)))
  }
})

test('a compacted-away opinion gets a fresh ordinary append, never a stale-seq replacement', () => {
  const { session, commit } = fixture()
  commit(replaceAdviceInSurface(session, enter(makeAdviceMessage('before-cut', { preset: preset.id }))))
  session.surface.nodes.length = 0
  session.append('user/message', user('host summary without old opinion'), { surfaceOp: 'append' })
  const before = session.surface.replaceGeneration
  const after = replaceAdviceInSurface(session, enter(makeAdviceMessage('after-cut', { preset: preset.id })))
  assert.equal(after.messages.length, 1)
  commit(after)
  assert.equal(session.surface.replaceGeneration, before)
  assert.equal(adviceSurfaceEntries(session).length, 1)
})

test('cross-preset advice replaces only a MoA node and preserves other plugin and pending messages', () => {
  const { session, commit } = fixture()
  const foreign = { role: 'user', content: [{ type: 'text', text: 'other plugin data' }], source: { kind: 'plugin:other' } }
  session.append('user/message', foreign, { surfaceOp: 'append' })
  commit(replaceAdviceInSurface(session, enter(makeAdviceMessage('route A', { preset: 'A' }))))
  const pendingHuman = user('pending human instruction')
  const newAdvice = makeAdviceMessage('route B', { preset: 'B' })
  const after = replaceAdviceInSurface(session, enter(pendingHuman, newAdvice))
  assert.deepEqual(after.messages, [pendingHuman])
  assert.equal(session.deriveMessages()[0], foreign)
  assert.equal(adviceSurfaceEntries(session).filter(entry => !isRetiredAdvice(entry.message)).length, 1)
  assert.equal(adviceSurfaceEntries(session).at(-1).message.content, newAdvice.content)
  assert.equal(adviceSurfaceEntries(session).at(-1).message.source.logicalPlacement.version, 2)
  assert.equal(newAdvice.source.logicalPlacement, undefined)
})

test('reject and advice-free decisions never mutate the surface', () => {
  const { session } = fixture()
  const rejected = { kind: 'reject' }
  assert.equal(replaceAdviceInSurface(session, rejected), rejected)
  const unchanged = enter(user('ordinary pending user'))
  assert.equal(replaceAdviceInSurface(session, unchanged), unchanged)
  assert.equal(session.events.length, 0)
})
