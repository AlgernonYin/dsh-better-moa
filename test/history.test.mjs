// Run from the workspace root:
//   node --test moa-selftest/history.test.mjs   (or: node moa-selftest/history.test.mjs)
//
// Imports the source package (../history.js), not the moa mirror.
// Requires the `zod` dependency that the package manifest must declare (^4.4.3).

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HISTORY_PROJECTION_KEY,
  createHistoryProjection,
  readAdvisorHistory,
} from '../history.js'
import { buildAdvisorTranscript } from '../transcript.js'

const projection = createHistoryProjection()

function fold(events, { header = { id: 'session-test' }, inheritedEventCount = 0 } = {}) {
  let state = projection.init(header, inheritedEventCount)
  for (const event of events) state = projection.apply(state, event)
  return state
}

function sessionEvent(seq, type, data, extra = {}) {
  return { type, seq, time: 1700000000000 + seq, data, ...extra }
}

function userEvent(seq, id, text, { kind = 'user', surface, extra = {} } = {}) {
  return sessionEvent(seq, 'user/message', {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  }, surface ? { ...extra, surfaceOp: surface } : extra)
}

function assistantEvent(seq, id, content) {
  return sessionEvent(seq, 'assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id,
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'fake', model: 'ref' },
    },
    stream: [],
  })
}

function toolEvent(seq, id, callId, text) {
  return sessionEvent(seq, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      id,
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId },
    },
  })
}

function textOf(message) {
  return message.content.map((block) => block.text ?? '').join('\n')
}

test('appends real user, assistant tool-call and tool-result history in log order', () => {
  const call = { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.js"}' }
  const unexecutedCall = { type: 'tool-call', id: 'call-2', name: 'write', arguments: '{"path":"b.js"}' }
  const events = [
    userEvent(0, 'u1', 'inspect the repo'),
    assistantEvent(1, 'a1', [{ type: 'text', text: 'reading' }, call]),
    toolEvent(2, 't1', 'call-1', 'file contents'),
    // The second call was interrupted before any tool/result: history must not invent one.
    assistantEvent(3, 'a2', [{ type: 'text', text: 'truncated' }, unexecutedCall]),
  ]
  const before = structuredClone(events)
  const history = fold(events)

  assert.equal(history.version, 2)
  assert.deepEqual(history.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant'])
  assert.deepEqual(history.messages[1].content, [{ type: 'text', text: 'reading' }, call])
  assert.equal(history.messages[2].toolCallId, 'call-1')
  assert.equal(textOf(history.messages[2]), 'file contents')
  assert.deepEqual(history.messages[3].content, [{ type: 'text', text: 'truncated' }, unexecutedCall])
  assert.equal(history.messages.filter((message) => message.role === 'tool').length, 1)

  // Only the committed messages were stored: no synthetic live tool messages.
  assert.deepEqual(events, before)
  assert.notEqual(history.messages[0], events[0].data)
  assert.equal(new Set(history.messages.map((message) => message.id)).size, 4)
  assert.deepEqual(fold(events), history) // same events, same state (deterministic)
  assert.equal(history.lastEventSeq, 3)
})

test('returns the same state reference for ignored events', () => {
  const state = fold([userEvent(0, 'u1', 'task')])
  const ignored = [
    sessionEvent(100, 'turn/start', { turn: 1 }),
    sessionEvent(101, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    sessionEvent(102, 'step/start', { turn: 1, step: 1 }),
    sessionEvent(103, 'step/end', { turn: 1, step: 1 }),
    sessionEvent(104, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' }),
    sessionEvent(105, 'assistant/attempt', { turn: 1, step: 1, stream: [] }),
    sessionEvent(106, 'system/message', {
      turn: 1,
      step: 1,
      message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'system-prompt' } },
    }),
    sessionEvent(107, 'developer/message', {
      turn: 1,
      step: 1,
      message: { id: 'dev', role: 'developer', content: [{ type: 'text', text: 'policy' }], source: { kind: 'user' } },
    }),
    // Ambient/synthetic user messages: not the collaborator's real history.
    userEvent(108, 'ctx-time', 'now', { kind: 'time-context' }),
    userEvent(109, 'ctx-runtime', 'runtime', { kind: 'runtime-context' }),
    userEvent(110, 'ctx-skills', 'skills', { kind: 'skill-catalog' }),
    userEvent(111, 'ctx-model', 'route', { kind: 'model-selection' }),
    userEvent(112, 'advice', 'MoA advice', { kind: 'plugin:moa' }),
  ]
  for (const event of ignored) {
    assert.equal(projection.apply(state, event), state)
  }
})

test('keeps the complete pre-replacement prefix and annotates the replacement', () => {
  const original = userEvent(0, 'shared-id', 'original request')
  const assistant = assistantEvent(1, 'shared-id', [{ type: 'text', text: 'partial work' }])
  const tool = toolEvent(2, 't1', 'call-1', 'old observation')
  const replacement = userEvent(3, 'shared-id', 'compacted summary of the work so far', {
    surface: { op: 'replace', startSeq: 0, endSeq: 2 },
  })
  const events = [original, assistant, tool, replacement]
  const before = structuredClone(events)
  const history = fold(events)

  // Append-only: the whole replaced prefix is still there, in order.
  assert.equal(history.messages.length, 4)
  assert.deepEqual(history.messages.slice(0, 3).map(textOf), [
    'original request',
    'partial work',
    'old observation',
  ])
  assert.equal(history.messages[3].role, 'user')
  assert.equal(textOf(history.messages[3]), 'compacted summary of the work so far')
  assert.deepEqual(events, before)

  // The replacement is marked as context replacement, never as a fresh user command.
  assert.equal(history.messages[3].source.kind, 'context-replacement')
  assert.equal(history.messages[3].source.originalKind, 'user')
  assert.equal(history.messages[3].source.surfaceOp, 'replace')
  assert.equal(history.messages[3].source.replacedFrom, 0)
  assert.equal(history.messages[3].source.replacedTo, 2)

  // The edited message reuses message.id `shared-id`, yet both copies have distinct,
  // event-derived ids so transcript de-duplication cannot drop either one.
  assert.notEqual(history.messages[3].id, history.messages[0].id)
  assert.deepEqual(history.messages.map((message) => message.id), [
    'moa:0:user/message',
    'moa:1:assistant/message',
    'moa:2:tool/result',
    'moa:3:user/message',
  ])
})

test('a replacement is not a new user turn and survives transcript de-duplication', () => {
  const original = userEvent(0, 'shared-id', 'original request')
  const assistant = assistantEvent(1, 'a1', [{ type: 'text', text: 'work in progress' }])
  const replacementText = 'replacement after compaction'
  const beforeView = buildAdvisorTranscript(fold([original, assistant]).messages)
  const afterView = buildAdvisorTranscript(fold([
    original,
    assistant,
    userEvent(2, 'shared-id', replacementText, {
      surface: { op: 'replace', startSeq: 0, endSeq: 1 },
    }),
  ]).messages)

  // turnHash is computed from turnSource: the replacement must not move the last real user.
  assert.equal(afterView.turnSource, beforeView.turnSource)
  assert.ok(afterView.turnSource.includes('original request'))
  assert.ok(!afterView.turnSource.includes(replacementText))

  // Full history still shows both versions of the edited message.
  assert.equal(afterView.messageCount, 3)
  assert.ok(afterView.source.includes('original request'))
  assert.ok(afterView.source.includes(replacementText))
  assert.ok(afterView.source.includes('kind="context-replacement"'))
})

test('committing a pending message preserves the exact advisor prefix with or without a message id', () => {
  for (const hasMessageId of [true, false]) {
    const first = userEvent(0, 'pending-user', 'first task')
    if (!hasMessageId) delete first.data.id
    const pending = buildAdvisorTranscript([], [first.data])
    const committed = buildAdvisorTranscript(fold([first]).messages)
    assert.equal(committed.source, pending.source, 'log-position ids must not rewrite a pending source already seen by the advisor')
    const next = buildAdvisorTranscript(fold([
      first,
      assistantEvent(1, 'answer-1', [{ type: 'text', text: 'actual answer' }]),
      userEvent(2, 'user-2', 'follow-up'),
    ]).messages)
    assert.ok(next.source.startsWith(pending.source), 'the next turn must be appendable to the advisor ledger')
  }
})

test('committed history recognizes pending copies but preserves edits sharing an original id', () => {
  const event = userEvent(0, 'same-user-id', 'original task')
  const history = fold([event]).messages
  assert.equal(buildAdvisorTranscript(history, [event.data]).messageCount, 1)
  const edit = { ...event.data, content: [{ type: 'text', text: 'edited task' }] }
  const view = buildAdvisorTranscript(history, [edit])
  assert.equal(view.messageCount, 2)
  assert.match(view.source, /original task/)
  assert.match(view.source, /edited task/)
})

test('a bounded advisor transcript remains appendable between window rotations', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `history-${index}`, role: 'tool', source: { kind: 'tool' },
    content: [{ type: 'text', text: `observation ${index}: ` + 'x'.repeat(160) }],
  }))
  const options = { maxTotalChars: 4000 }
  const first = buildAdvisorTranscript(messages, [], options)
  assert.equal(first.windowed, true)
  assert.ok(first.source.length <= options.maxTotalChars)
  assert.ok(!first.source.includes('id="history-0"'))
  const nextMessage = { id: 'next', role: 'assistant', content: [{ type: 'text', text: 'small completed step' }] }
  const next = buildAdvisorTranscript([...messages, nextMessage], [], options)
  assert.ok(next.source.startsWith(first.source), 'a small appended step must not evict the stable cached prefix')
  assert.equal(next.messageCount, first.messageCount + 1)
  assert.ok(next.source.length <= options.maxTotalChars)
  assert.equal(buildAdvisorTranscript([...messages, nextMessage], [], options).source, next.source)
})

test('a transcript cap retains the newest observation even if it exceeds the budget', () => {
  const view = buildAdvisorTranscript([
    { id: 'old', role: 'user', content: 'old request' },
    { id: 'latest', role: 'tool', content: 'IMPORTANT-START' + 'x'.repeat(10000) + 'IMPORTANT-END' },
  ], [], { maxTotalChars: 1000, maxMessageChars: 24000 })
  assert.equal(view.messageCount, 1)
  assert.equal(view.truncated, true)
  assert.match(view.source, /IMPORTANT-START/)
  assert.match(view.source, /IMPORTANT-END/)
  assert.ok(view.source.length <= 1000)
})

test('fork inheritance and full replay produce identical histories', () => {
  const prefix = [
    userEvent(0, 'u1', 'task'),
    assistantEvent(1, 'a1', [{ type: 'text', text: 'answer' }]),
    toolEvent(2, 't1', 'c1', 'result'),
  ]
  const own = [
    userEvent(3, 'u2', 'follow-up'),
    assistantEvent(4, 'a2', [{ type: 'text', text: 'second answer' }]),
  ]
  const parent = fold([...prefix, ...own])
  const replay = fold([...prefix, ...own])
  assert.deepEqual(replay, parent)

  // A forked child inherits the same prefix and appends its own tail. Inherited events are
  // folded through apply by the registry, so `inheritedEventCount` must not fork the state.
  const forked = fold([...prefix, ...own], {
    header: { id: 'child', parentSession: 'session-test' },
    inheritedEventCount: prefix.length,
  })
  assert.deepEqual(forked, parent)
  assert.deepEqual(forked.messages.map((message) => message.id), parent.messages.map((message) => message.id))

  // Re-applying an already folded event is a no-op with the same reference.
  assert.equal(projection.apply(parent, own.at(-1)), parent)
})

test('readAdvisorHistory prefers the projection state and reports its source', () => {
  const history = fold([userEvent(0, 'u1', 'task')])
  const session = {
    id: 'session-test',
    deriveMessages() {
      return [{ id: 'derived' }]
    },
  }
  const projections = {
    stateOf(target, key) {
      assert.equal(target, session)
      assert.equal(key, HISTORY_PROJECTION_KEY)
      return history
    },
  }
  const read = readAdvisorHistory(projections, session)
  assert.equal(read.source, 'projection')
  assert.equal(read.reason, undefined)
  assert.equal(read.messages, history.messages)

  // An empty projection is still a complete (empty) history, not a fallback.
  const empty = readAdvisorHistory({ stateOf: () => projection.init({ id: 's' }, 0) }, session)
  assert.equal(empty.source, 'projection')
  assert.deepEqual(empty.messages, [])
})

test('readAdvisorHistory falls back to deriveMessages and reports why', () => {
  const derived = [{ id: 'derived', role: 'user' }]
  const session = { deriveMessages: () => derived }

  const missing = readAdvisorHistory({ stateOf: () => undefined }, session)
  assert.deepEqual(missing, {
    messages: derived,
    source: 'deriveMessages',
    reason: 'projection-not-registered',
  })

  const noService = readAdvisorHistory(undefined, session)
  assert.equal(noService.source, 'deriveMessages')
  assert.equal(noService.reason, 'sessionProjections-unavailable')

  const thrown = readAdvisorHistory({ stateOf: () => { throw new Error('boom') } }, session)
  assert.equal(thrown.source, 'deriveMessages')
  assert.equal(thrown.reason, 'stateOf-failed: boom')

  const invalid = readAdvisorHistory({ stateOf: () => ({ messages: 'nope' }) }, session)
  assert.equal(invalid.reason, 'projection-state-invalid')

  const brokenSession = { deriveMessages: () => { throw new Error('gone') } }
  assert.deepEqual(readAdvisorHistory(undefined, brokenSession).messages, [])
})

test('the projection definition is host-only and validates its real state schema', () => {
  const definition = createHistoryProjection()
  assert.equal(definition.key, HISTORY_PROJECTION_KEY)
  assert.ok(Number.isInteger(definition.stateVersion))
  assert.equal('wire' in definition, false) // host-only: never exposed to client snapshots
  assert.equal(typeof definition.init, 'function')
  assert.equal(typeof definition.apply, 'function')

  const first = definition.init({ id: 's' }, 0)
  const second = definition.init({ id: 's' }, 4)
  assert.notEqual(first.messages, second.messages)
  assert.deepEqual(first, second)
  assert.equal(definition.stateSchema.safeParse(first).success, true)

  const state = fold([
    userEvent(0, 'u1', 'task'),
    assistantEvent(1, 'a1', [{ type: 'text', text: 'ok' }]),
  ])
  assert.equal(definition.stateSchema.safeParse(state).success, true)
  assert.equal(definition.stateSchema.safeParse({ version: 1, messages: 'nope', lastEventSeq: 0 }).success, false)
  assert.equal(definition.stateSchema.safeParse({ version: 3, messages: [], lastEventSeq: -1 }).success, false)
})

test('encoded transcript budget keeps small escaped appends inside fixed window buckets', () => {
  const history = Array.from({ length: 100 }, (_, index) => ({
    id: `escaped-${index}`, role: 'tool', content: '\\"\n\u0001'.repeat(300),
  }))
  const options = { maxTotalChars: 55904, maxEncodedChars: 55904, maxMessageChars: 24000 }
  let previous = buildAdvisorTranscript(history, [], options)
  assert.ok(previous.windowed)
  for (let index = 0; index < 8; index += 1) {
    history.push({ id: `append-${index}`, role: 'tool', content: 'x'.repeat(65) })
    const next = buildAdvisorTranscript(history, [], options)
    assert.ok(next.source.startsWith(previous.source), `append ${index + 1} keeps the prefix`)
    assert.ok(JSON.stringify(next.source).length <= options.maxEncodedChars)
    previous = next
  }
  const huge = buildAdvisorTranscript([{ role: 'tool', content: '\u0001'.repeat(24000) }], [], {
    maxTotalChars: 1000, maxEncodedChars: 1000,
  })
  assert.ok(JSON.stringify(huge.source).length <= 1000)
})