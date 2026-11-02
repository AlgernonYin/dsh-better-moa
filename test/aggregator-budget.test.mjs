import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createMoaAdapter } from '../adapter.js'

for (const provider of ['deepseek-official', 'ordinary']) {
  test(`explicit preset cap scopes ${provider} iteration without marking Host defaults`, async () => {
    const budget = new AsyncLocalStorage()
    const main = new AsyncLocalStorage()
    const calls = []
    const intents = []
    const scope = { wrap(intent, factory) {
      intents.push(intent)
      return { [Symbol.asyncIterator]() {
        const iterator = budget.run(intent, () => factory()[Symbol.asyncIterator]())
        return { next: () => budget.run(intent, () => iterator.next()),
          return: () => budget.run(intent, () => iterator.return?.() ?? Promise.resolve({ done: true })),
        }
      } }
    } }
    const runtime = {
      async resolveModelInfo() { return { defaultMaxTokens: 128000 } },
      async *stream(options) {
        calls.push({ options, budget: budget.getStore(), main: main.getStore() })
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(budget.getStore(), calls.at(-1).budget)
        assert.equal(main.getStore(), 'main-owner')
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      adapterStream(options) { assert.equal(this, runtime); return this.stream(options) },
    }
    const aggregator = { provider, model: 'synthetic', maxTokens: 1024 }
    const adapter = createMoaAdapter({ runtime, presets: new Map([['capped', { id: 'capped', aggregator }],
      ['default', { id: 'default', aggregator: { provider, model: 'synthetic' } }]]), getBudgetScope: () => scope })
    assert.equal((await adapter.resolveModel('moa', 'capped')).defaultMaxTokens, 1024)
    assert.equal((await adapter.resolveModel('moa', 'default')).defaultMaxTokens, 128000)
    const base = { provider: 'moa', sessionId: 'main-owner', messages: [], tools: [{ name: 'synthetic_tool' }] }
    for (const [model, maxTokens] of [['capped', 128000], ['capped', 512], ['default', 128000]]) {
      await main.run('main-owner', async () => { for await (const chunk of adapter.stream({ ...base, model, maxTokens })) assert.equal(chunk.type, 'finish') })
      assert.equal(budget.getStore(), undefined, 'budget never leaks into the caller')
    }
    assert.deepEqual(calls.map(call => call.options.maxTokens), [1024, 1024, 128000])
    assert.deepEqual(intents, [{ owner: 'better-moa', maxTokens: 1024 }, { owner: 'better-moa', maxTokens: 1024 }])
    assert.equal(calls[2].budget, undefined)
    assert.equal(budget.getStore(), undefined)
  })
}

test('an explicit 32K preset replaces an ambiguous lower Host default', async () => {
  let forwarded, intent
  const runtime = { async *stream(options) { forwarded = options; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const scope = { wrap(value, dispatch) { intent = value; return dispatch() } }
  const adapter = createMoaAdapter({ runtime, getBudgetScope: () => scope,
    presets: new Map([['cap', { id: 'cap', aggregator: { provider: 'ordinary', model: 'synthetic', maxTokens: 32000 } }]]) })
  for await (const _ of adapter.stream({ model: 'cap', messages: [], maxTokens: 1024 })) {}
  assert.equal(forwarded.maxTokens, 32000)
  assert.deepEqual(intent, { owner: 'better-moa', maxTokens: 32000 })
})

test('explicit preset ceiling is sent when the optional compatibility service is absent', async () => {
  let forwarded
  const runtime = { async *stream(options) { forwarded = options; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const adapter = createMoaAdapter({ runtime, presets: new Map([['cap', { id: 'cap', aggregator: { provider: 'ordinary', model: 'synthetic', maxTokens: 1024 } }]]) })
  for await (const _ of adapter.stream({ model: 'cap', messages: [], maxTokens: 128000 })) {}
  assert.equal(forwarded.maxTokens, 1024)
})
