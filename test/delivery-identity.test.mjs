import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdviceEngine } from '../advice.js'
import { createDialogueStore } from '../dialogue.js'
import { normalizeConfig } from '../config.js'

const msg = (id, text, kind = 'user') => ({ id, role: kind === 'user' ? 'user' : 'assistant', content: [{ type: 'text', text }], source: { kind } })
async function fixture(saved) {
  const tables = saved ?? { cadence: {}, dialogue: {}, window: {} }
  const kv = { async loadAll() { return { tables: structuredClone(tables) } }, async putRecord(t, k, v) { tables[t][k] = structuredClone(v) }, async deleteRecord(t, k) { delete tables[t][k] } }
  let calls = 0
  const runtime = { async *stream() { calls++; yield { type: 'text-delta', text: `advice ${calls}` }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const preset = { id: 'test', fanout: 'every_n:3', references: [{ id: 'a', provider: 'fake', model: 'ref' }], aggregator: { provider: 'fake', model: 'agg' }, referenceTimeoutMs: 1000, deadlineMs: 2000 }
  const config = normalizeConfig({ defaultPreset: 'test', persistentTags: [] })
  const store = createDialogueStore({ kv: null, persistentTags: [] }); await store.load()
  const engine = createAdviceEngine({ runtime, store, presets: new Map([['test', preset]]), config, kv }); await engine.load()
  const history = [msg('u', 'review task')]
  const session = { header: { id: 'identity-session' }, seq: 1, deriveMessages: () => history, eventAt: () => ({ type: 'model/selection', data: { provider: 'moa', model: 'test' } }) }
  const step = n => engine.preStep({ agent: { session }, turn: 1, step: n, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  return { engine, history, tables, step, calls: () => calls }
}

test('returned advice is not redelivered before history commitment; cadence still advances', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.step(1)).messages.length, 1)
    assert.equal((await f.step(2)).messages.length, 0)
    f.history.push(msg('a1', 'progress one', 'model'))
    assert.equal((await f.step(3)).messages.length, 0)
    f.history.push(msg('a2', 'progress two', 'model'))
    assert.equal((await f.step(4)).messages.length, 0)
    f.history.push(msg('a3', 'progress three', 'model'))
    assert.equal((await f.step(5)).messages.length, 1)
    assert.equal(f.calls(), 2)
  } finally { await f.engine.close() }
})

test('persisted cached advice can be restored only once with overlapping uncommitted steps', async () => {
  const first = await fixture()
  await first.step(1)
  const saved = structuredClone(first.tables)
  await first.engine.close()
  const f = await fixture(saved)
  try {
    const decisions = await Promise.all([f.step(2), f.step(3)])
    const cards = decisions.flatMap(x => x.messages)
    assert.equal(cards.length, 1)
    assert.equal(cards[0].source.cached, true)
    assert.equal((await f.step(4)).messages.length, 0)
    assert.equal(f.calls(), 0)
  } finally { await f.engine.close() }
})
