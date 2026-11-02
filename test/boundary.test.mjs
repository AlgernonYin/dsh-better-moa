import test from 'node:test'
import assert from 'node:assert/strict'
import { withAdviceBoundary, usesAdviceBoundary, BOUNDARY_KIND } from '../boundary.js'
import { createMoaAdapter } from '../adapter.js'

const human = { id: 'u', role: 'user', content: [{ type: 'text', text: 'static fixture' }], source: { kind: 'user' } }
const advice = text => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin:moa', form: 'advice' } })

test('one request-only separator preserves original tool, replay and content objects', () => {
  const assistant = { role: 'assistant', content: [{ type: 'tool-call', id: 't', name: 'counter', arguments: '{"seq":1}' }], source: { kind: 'model', provider: 'moa', replayState: { response: { signature: 'opaque' } } } }
  const tool = { role: 'tool', toolCallId: 't', content: [{ type: 'text', text: 'receipt' }], source: { kind: 'tool', callId: 't' } }
  const input = [human, advice('REVIEW-1'), assistant, tool]
  const before = JSON.stringify(input)
  const output = withAdviceBoundary(input)
  assert.equal(output.length, input.length + 1)
  assert.equal(output[1].source.kind, BOUNDARY_KIND)
  assert.equal(output[1].role, 'assistant')
  assert.match(output[1].content[0].text, /Runtime-generated/)
  assert.equal(output[1].source.replayState, undefined)
  assert.deepEqual(output.filter(message => message.source?.kind !== BOUNDARY_KIND), input)
  input.forEach((message, index) => assert.equal(output[index ? index + 1 : 0], message))
  assert.equal(output[3].content, assistant.content)
  assert.equal(output[4].content, tool.content)
  assert.equal(JSON.stringify(input), before)
  assert.equal(withAdviceBoundary(output), output)
})

test('the separator prefix stays fixed across an opinion update and leading Host header', () => {
  const work = { role: 'assistant', content: [{ type: 'text', text: 'actual work' }], source: { kind: 'model' } }
  const first = withAdviceBoundary([human, advice('REVIEW-1')])
  const later = withAdviceBoundary([human, work, advice('REVIEW-2')])
  assert.deepEqual(later.slice(0, 2), first.slice(0, 2))
  assert.equal(later.filter(message => message.source?.kind === 'plugin:moa').length, 1)
  assert.equal(later.filter(message => message.source?.kind === BOUNDARY_KIND).length, 1)
  assert.equal(JSON.stringify(later).includes('REVIEW-1'), false)
  assert.equal(later[2], work)
  const system = { role: 'system', content: [{ type: 'text', text: 'host header' }], source: { kind: 'system-prompt' } }
  assert.deepEqual(withAdviceBoundary([system, human, advice('REVIEW-1')]).slice(0, 3), [system, human, first[1]])
})

test('missing real user or active opinion never causes guessed placement', () => {
  const noAdvice = [human]
  const syntheticOnly = [{ ...human, source: { kind: 'runtime/context' } }, advice('REVIEW-1')]
  assert.equal(withAdviceBoundary(noAdvice), noAdvice)
  assert.equal(withAdviceBoundary(syntheticOnly), syntheticOnly)
})

test('production adapter applies a separator only to a verified route and leaves the source history intact', async () => {
  const routes = [
    { provider: 'magpie', model: 'bailian/MiniMax/MiniMax-M3.1-Flash', capabilities: { adviceBoundary: true }, expected: true },
    { provider: 'magpie-anthropic', model: 'ai/ai/claude-tui/claude-sonnet-5-5', capabilities: { adviceBoundary: true }, expected: true },
    { provider: 'other-anthropic', model: 'ai/ai/claude-tui/claude-sonnet-5-5', expected: false },
    { provider: 'magpie-responses', model: 'ai/ai/codex/gpt-6.1-sol', expected: false },
  ]
  for (const route of routes) {
    const preset = { id: 'test', aggregator: route }
    let sent
    const runtime = {
      adapterStream(options) { return this.stream(options) },
      async *stream(options) { sent = options; yield { type: 'finish', reason: { kind: 'stop' } } },
    }
    const adapter = createMoaAdapter({ runtime, presets: new Map([['test', preset]]), config: { adviceHistory: 'latest' } })
    const history = [human, advice('REVIEW-1')]
    const before = JSON.stringify(history)
    for await (const chunk of adapter.stream({ provider: 'moa', model: 'test', sessionId: 'isolated', messages: history })) void chunk
    assert.equal(usesAdviceBoundary(route), route.expected)
    assert.equal(sent.messages.filter(message => message.source?.kind === BOUNDARY_KIND).length, route.expected ? 1 : 0)
    assert.equal(sent.messages.filter(message => message.source?.kind === 'plugin:moa').length, 1)
    assert.equal(JSON.stringify(history), before)
  }
})
