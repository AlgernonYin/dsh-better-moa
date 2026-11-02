import assert from 'node:assert/strict'
import {
  DIALOGUE_VERSION,
  DIALOGUE_VIEW,
  SETUP_USER,
  SETUP_ASSISTANT,
  QUOTED,
  NEW_DELTA,
  SUFFIX,
  createDialogueStore,
  dialogueIdentity
} from '../dialogue.js'
import { REVIEW_SUFFIX } from '../advice.js'

const tests = []

function test(name, run) {
  tests.push({ name, run })
}

function input(overrides = {}) {
  return {
    sessionId: 'session',
    provider: 'anthropic',
    model: 'claude-opus',
    source: 'alpha',
    system: 'advisor system',
    ...overrides
  }
}

function initialWire(source) {
  return [
    { role: 'user', content: SETUP_USER + '\n\n' + QUOTED + source },
    { role: 'assistant', content: SETUP_ASSISTANT },
    { role: 'user', content: SUFFIX }
  ]
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

class FakeKv {
  constructor(dialogue = {}) {
    this.tables = { dialogue: copy(dialogue) }
    this.global = {}
    this.puts = []
    this.deletes = []
    this.closed = false
    this.failPut = false
  }

  async loadAll() {
    return { tables: this.tables, global: this.global }
  }

  async putRecord(table, key, value) {
    if (this.failPut) throw new Error('put failed')
    this.puts.push({ table, key, value: copy(value) })
    if (!this.tables[table]) this.tables[table] = {}
    this.tables[table][key] = copy(value)
  }

  async deleteRecord(table, key) {
    this.deletes.push(key)
    delete this.tables[table]?.[key]
  }

  async close() {
    this.closed = true
  }
}

class BlockingKv extends FakeKv {
  constructor() {
    super()
    this.blockNext = false
    this.started = new Promise(resolve => { this.notifyStarted = resolve })
  }

  async putRecord(table, key, value) {
    if (this.blockNext) {
      this.blockNext = false
      this.notifyStarted()
      await new Promise(resolve => { this.release = resolve })
    }
    await super.putRecord(table, key, value)
  }
}

function checkpoint(source, ts, overrides = {}) {
  return {
    version: DIALOGUE_VERSION,
    view: DIALOGUE_VIEW,
    system: 'advisor system',
    source,
    reply: 'stored reply',
    wire: initialWire(source),
    ts,
    ...overrides
  }
}

test('first build has exact scaffold, core, and key scope', () => {
  const store = createDialogueStore()
  const plan = store.prepare(input())
  assert.equal(plan.persistent, true)
  assert.equal(plan.replay, null)
  assert.equal(plan.reset, true)
  assert.equal(plan.reason, 'initial')
  assert.deepEqual(plan.wire, initialWire('alpha'))
  assert.equal(plan.core, JSON.stringify({
    system: 'advisor system',
    messages: initialWire('alpha').slice(0, -1)
  }))
  assert.match(plan.key, /^[0-9a-f]{64}$/)
  assert.notEqual(store.prepare(input({ provider: 'other', persistent: true })).key, plan.key)
  assert.notEqual(store.prepare(input({ slotId: 'other' })).key, plan.key)
  assert.notEqual(store.prepare(input({ cacheScope: 'other' })).key, plan.key)
  assert.notEqual(store.prepare(input({ dialogueKey: 'other' })).key, plan.key)
  assert.notEqual(store.prepare(input({ dialogueKey: '' })).key, plan.key)
})

test('same snapshot replays without upstream wire', async () => {
  const store = createDialogueStore()
  const first = store.prepare(input())
  const status = await store.commit(first, { reply: 'complete reply', complete: true })
  assert.equal(status.recorded, 'checkpoint')
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status)
  const retry = store.prepare(input())
  assert.equal(retry.replay, 'complete reply')
  assert.deepEqual(retry.wire, [])
  assert.equal(retry.reset, false)
  assert.equal(retry.reason, 'same_snapshot')
  assert.equal(retry.core, JSON.stringify({ system: 'advisor system', messages: [] }))
  assert.deepEqual(store.stats(), { records: 1, persistentRecords: 1, lastAttempts: 0 })
})

test('append preserves prefix and adds exact reply and delta', async () => {
  const store = createDialogueStore()
  const first = store.prepare(input())
  await store.commit(first, { reply: 'previous reply', complete: true })
  first.wire[0].content = 'mutated after commit'

  const appended = store.prepare(input({ source: 'alpha\nnew event' }))
  assert.equal(appended.reason, 'append')
  assert.equal(appended.reset, false)
  assert.equal(appended.replay, null)
  assert.deepEqual(appended.wire.slice(0, 3), initialWire('alpha'))
  assert.deepEqual(appended.wire.slice(3), [
    { role: 'assistant', content: 'previous reply' },
    { role: 'user', content: NEW_DELTA + '\nnew event' + SUFFIX }
  ])
  assert.equal(appended.core, JSON.stringify({
    system: 'advisor system',
    messages: appended.wire.slice(0, -1)
  }))

  await store.commit(appended, { reply: 'second reply', complete: true })
  appended.wire[0].content = 'mutated returned plan'
  const next = store.prepare(input({ source: 'alpha\nnew event\nmore' }))
  assert.equal(next.wire[0].content, SETUP_USER + '\n\n' + QUOTED + 'alpha')
  assert.equal(next.wire[5].content, 'second reply')
})

test('changed history or system rebuilds from source', async () => {
  const store = createDialogueStore()
  await store.commit(store.prepare(input()), { reply: 'reply', complete: true })
  for (const overrides of [
    { source: 'different history' },
    { system: 'changed system' }
  ]) {
    const plan = store.prepare(input(overrides))
    assert.equal(plan.reset, true)
    assert.equal(plan.reason, 'rebased')
    assert.deepEqual(plan.wire, initialWire(overrides.source ?? 'alpha'))
  }
})

test('compacted or shrunk source rebuilds instead of appending', async () => {
  const store = createDialogueStore()
  await store.commit(store.prepare(input({ source: 'long transcript' })), {
    reply: 'reply',
    complete: true
  })
  const plan = store.prepare(input({ source: 'long' }))
  assert.equal(plan.reset, true)
  assert.equal(plan.reason, 'rebased')
  assert.deepEqual(plan.wire, initialWire('long'))
})

test('oversized append falls back to a fresh scaffold', async () => {
  const store = createDialogueStore({ maxChars: 1 })
  await store.commit(store.prepare(input()), { reply: 'reply', complete: true })
  const plan = store.prepare(input({ source: 'alpha beta' }))
  assert.equal(plan.reset, true)
  assert.equal(plan.reason, 'size')
  assert.deepEqual(plan.wire, initialWire('alpha beta'))
})

test('nonpersistent calls are latest-only and leave no checkpoint', async () => {
  const store = createDialogueStore({ persistentTags: [] })
  const plan = store.prepare(input())
  assert.equal(plan.persistent, false)
  assert.equal(plan.reason, 'latest')
  assert.equal(plan.reset, false)
  assert.equal(plan.replay, null)
  assert.deepEqual(plan.wire, [{ role: 'user', content: QUOTED + 'alpha' + SUFFIX }])
  assert.equal(plan.core, JSON.stringify({ system: 'advisor system', messages: [] }))
  const status = await store.commit(plan, { reply: 'reply', complete: true })
  assert.equal(status.recorded, 'none')
  assert.deepEqual(store.stats(), { records: 0, persistentRecords: 0, lastAttempts: 0 })
})

test('cut attempt retains old checkpoint and records last attempt', async () => {
  const store = createDialogueStore()
  const first = store.prepare(input({ source: 'A' }))
  await store.commit(first, { reply: 'old reply', complete: true })
  const cut = store.prepare(input({ source: 'AB' }))
  const status = await store.commit(cut, {
    reply: 'partial reply',
    complete: false,
    reason: 'deadline'
  })
  assert.equal(status.recorded, 'last_attempt')
  // A thread that already owns a checkpoint keeps its cut on that checkpoint, so the
  // slot-wide attempt marker is only used before the thread's first checkpoint.
  assert.deepEqual(store.stats(), { records: 1, persistentRecords: 1, lastAttempts: 0 })

  const next = store.prepare(input({ source: 'ABC' }))
  assert.equal(next.reason, 'append_after_cut')
  assert.notEqual(next.transportEpoch, first.transportEpoch)
  assert.deepEqual(next.wire.slice(0, 3), initialWire('A'))
  assert.deepEqual(next.wire.slice(3), [
    { role: 'assistant', content: 'old reply' },
    { role: 'user', content: NEW_DELTA + 'BC' + SUFFIX }
  ])
})

test('undispatched abort is a no-op', async () => {
  const store = createDialogueStore()
  await store.commit(store.prepare(input()), { reply: 'reply', complete: true })
  const plan = store.prepare(input({ source: 'alpha beta' }))
  const status = await store.commit(plan, { complete: false, dispatched: false })
  assert.equal(status.recorded, 'none')
  assert.deepEqual(store.stats(), { records: 1, persistentRecords: 1, lastAttempts: 0 })
})

test('fake DSH kv saves and reloads complete checkpoints', async () => {
  const kv = new FakeKv()
  const firstStore = createDialogueStore({ kv, now: () => 12345 })
  await firstStore.load()
  const first = firstStore.prepare(input())
  await firstStore.commit(first, { reply: 'persisted reply', complete: true })
  assert.equal(kv.puts[0].table, 'dialogue')
  assert.equal(kv.puts[0].key, first.key)
  const stored = kv.tables.dialogue[first.key]
  assert.deepEqual(Object.keys(stored.threads), [first.thread], 'the checkpoint is stored under its request thread')
  assert.equal(stored.threads[first.thread].ts, 12345)

  const secondStore = createDialogueStore({ kv, now: () => 12345 })
  await secondStore.load()
  const retry = secondStore.prepare(input())
  assert.equal(retry.reason, 'same_snapshot')
  assert.equal(retry.replay, 'persisted reply')
  assert.deepEqual(secondStore.stats(), { records: 1, persistentRecords: 1, lastAttempts: 0 })
})

test('corrupt and expired records are ignored and pruned', async () => {
  const kv = new FakeKv({
    fresh: checkpoint('fresh', 9901),
    expired: checkpoint('expired', 9899),
    malformed: { version: 3, source: 'missing fields' },
    corrupt: 'not a record',
    badWire: checkpoint('bad', 9999, { wire: [{ role: 'system', content: 'bad' }] }),
    badAttempt: { last_attempt: { source: 'x', reason: 'cut', ts: 'wrong' } }
  })
  const store = createDialogueStore({ kv, ttlMs: 100, now: () => 10000 })
  await store.load()
  assert.deepEqual(store.stats(), { records: 1, persistentRecords: 1, lastAttempts: 0 })
  assert.deepEqual(kv.deletes.sort(), ['badAttempt', 'badWire', 'corrupt', 'expired', 'malformed'].sort())
  assert.deepEqual(Object.keys(kv.tables.dialogue), ['fresh'])
})

test('per-key commit queue cannot overwrite later completion', async () => {
  const kv = new BlockingKv()
  const store = createDialogueStore({ kv })
  await store.load()
  await store.commit(store.prepare(input()), { reply: 'old reply', complete: true })
  const plan = store.prepare(input({ source: 'alpha beta' }))

  kv.blockNext = true
  const aborted = store.commit(plan, { complete: false, reason: 'cut' })
  await kv.started
  const completed = store.commit(plan, { reply: 'later complete', complete: true })
  kv.release()
  await Promise.all([aborted, completed])

  const retry = store.prepare(input({ source: 'alpha beta' }))
  assert.equal(retry.reason, 'same_snapshot')
  assert.equal(retry.replay, 'later complete')
  assert.deepEqual(store.stats(), { records: 1, persistentRecords: 1, lastAttempts: 0 })

  const reloaded = createDialogueStore({ kv })
  await reloaded.load()
  assert.equal(reloaded.prepare(input({ source: 'alpha beta' })).replay, 'later complete')
})

test('tag defaults, explicit opt-out, and wildcard opt-in work', () => {
  const defaults = createDialogueStore()
  assert.equal(defaults.prepare(input({ model: 'Claude-Sonnet' })).persistent, true)
  assert.equal(defaults.prepare(input({ provider: 'CLAUDE-route', model: 'gpt' })).persistent, true)
  assert.equal(defaults.prepare(input({ model: 'gpt' })).persistent, true)
  assert.equal(defaults.prepare(input({ persistent: false })).persistent, false)
  assert.equal(defaults.prepare(input({ model: 'gpt', persistent: true })).persistent, true)

  const wildcard = createDialogueStore({ persistentTags: ['*'] })
  assert.equal(wildcard.prepare(input({ model: 'gpt' })).persistent, true)
  const disabled = createDialogueStore({ persistentTags: [] })
  assert.equal(disabled.prepare(input()).persistent, false)
})

test('clear removes memory and persisted records; close is idempotent', async () => {
  const kv = new FakeKv({ orphan: checkpoint('orphan', 1) })
  const store = createDialogueStore({ kv })
  await store.load()
  await store.commit(store.prepare(input()), { reply: 'reply', complete: true })
  await store.clear()
  assert.deepEqual(store.stats(), { records: 0, persistentRecords: 0, lastAttempts: 0 })
  assert.deepEqual(kv.tables.dialogue, {})
  await store.close()
  await store.close()
  assert.equal(kv.closed, true)
})

test('storage write failures propagate to the caller', async () => {
  const kv = new FakeKv()
  kv.failPut = true
  const store = createDialogueStore({ kv })
  await store.load()
  await assert.rejects(
    store.commit(store.prepare(input()), { reply: 'reply', complete: true }),
    /put failed/
  )
})

test('complete reply blocks and native epoch survive reload without truncating replay metadata', async () => {
  const kv = new FakeKv()
  const store = createDialogueStore({ kv })
  await store.load()
  const first = store.prepare(input())
  const content = [{ type: 'reasoning', text: '' }, { type: 'text', text: 'full reply'.repeat(10000) }]
  const source = { kind: 'model', provider: 'anthropic', model: 'claude-opus', replayState: { response: { opaque: 'native-id' }, blocks: [{ opaque: 'signature' }, null] } }
  await store.commit(first, { reply: content[1].text, content, source, complete: true })
  const expectedContent = copy(content)
  const expectedSource = copy(source)
  content[1].text = 'caller mutation'
  source.replayState.response.opaque = 'caller mutation'
  const reloaded = createDialogueStore({ kv })
  await reloaded.load()
  const next = reloaded.prepare(input({ source: 'alpha beta' }))
  assert.equal(next.transportEpoch, first.transportEpoch)
  assert.deepEqual(next.wire[3], { role: 'assistant', content: expectedContent, source: expectedSource })
})

test('successful appends reuse native epoch while rebase starts a fresh native session', async () => {
  const store = createDialogueStore()
  const first = store.prepare(input())
  await store.commit(first, { reply: 'reply', complete: true })
  assert.equal(store.prepare(input({ source: 'alpha beta' })).transportEpoch, first.transportEpoch)
  const rebase = store.prepare(input({ source: 'edited history' }))
  assert.equal(rebase.reason, 'rebased')
  assert.notEqual(rebase.transportEpoch, first.transportEpoch)
})

test('live persistent tags and dialogue budget take effect without reopening storage', async () => {
  let tags = []
  let maxChars = 100000
  const store = createDialogueStore({ get persistentTags() { return tags }, get maxChars() { return maxChars } })
  assert.equal(store.prepare(input()).persistent, false)
  tags = ['*']
  const first = store.prepare(input())
  assert.equal(first.persistent, true)
  await store.commit(first, { reply: 'reply', complete: true })
  assert.equal(store.prepare(input({ source: 'alpha beta' })).reason, 'append')
  maxChars = 10
  assert.equal(store.prepare(input({ source: 'alpha beta' })).reason, 'size')
})

test('a completion prepared before clearing a session cannot revive its ledger', async () => {
  const kv = new FakeKv()
  const store = createDialogueStore({ kv })
  await store.load()
  const pending = store.prepare(input())
  const other = store.prepare(input({ sessionId: 'unrelated' }))
  await store.commit(other, { reply: 'keep', complete: true })
  await store.clear('session')
  assert.equal((await store.commit(pending, { reply: 'late', complete: true })).recorded, 'none')
  assert.equal(store.prepare(input()).reason, 'initial')
  assert.equal(store.prepare(input({ sessionId: 'unrelated' })).replay, 'keep')
  assert.equal(Object.keys(kv.tables.dialogue).length, 1)
})

// The end-of-turn QA review uses the same slot and the same transcript with a
// different request semantics; these tests pin the per-thread dialogue contract.
function qa(overrides = {}) {
  return { ...input(overrides), kind: 'review', suffix: REVIEW_SUFFIX }
}

test('advice and QA review never share a checkpoint on the same snapshot', async () => {
  const store = createDialogueStore()
  const advice = store.prepare(input())
  await store.commit(advice, { reply: 'advice reply', complete: true })

  const review = store.prepare(qa())
  assert.equal(review.reason, 'initial', 'the review starts its own thread instead of replaying the advice reply')
  assert.equal(review.replay, null)
  assert.notEqual(review.thread, advice.thread)
  assert.deepEqual(review.wire, [
    { role: 'user', content: SETUP_USER + '\n\n' + QUOTED + 'alpha' },
    { role: 'assistant', content: SETUP_ASSISTANT },
    { role: 'user', content: REVIEW_SUFFIX }
  ])
  await store.commit(review, { reply: 'VERDICT: REVISE\nfix it', complete: true })
  assert.deepEqual(store.stats(), { records: 1, persistentRecords: 1, lastAttempts: 0 })

  const backToAdvice = store.prepare(input())
  assert.equal(backToAdvice.reason, 'same_snapshot')
  assert.equal(backToAdvice.replay, 'advice reply', 'switching back replays the advice reply, not the review')
  const backToReview = store.prepare(qa())
  assert.equal(backToReview.reason, 'same_snapshot')
  assert.equal(backToReview.replay, 'VERDICT: REVISE\nfix it')
})

test('each request thread appends only its own reply and delta', async () => {
  const store = createDialogueStore()
  await store.commit(store.prepare(input({ source: 'A' })), { reply: 'advice A', complete: true })
  await store.commit(store.prepare(qa({ source: 'A' })), { reply: 'VERDICT: PASS', complete: true })

  const adviceNext = store.prepare(input({ source: 'AB' }))
  assert.equal(adviceNext.reason, 'append')
  assert.equal(adviceNext.replay, null)
  assert.deepEqual(adviceNext.wire.slice(3), [
    { role: 'assistant', content: 'advice A' },
    { role: 'user', content: NEW_DELTA + 'B' + SUFFIX }
  ])

  const reviewNext = store.prepare(qa({ source: 'ABC' }))
  assert.equal(reviewNext.reason, 'append')
  assert.deepEqual(reviewNext.wire.slice(3), [
    { role: 'assistant', content: 'VERDICT: PASS' },
    { role: 'user', content: NEW_DELTA + 'BC' + REVIEW_SUFFIX }
  ])
})

test('both request threads survive a reload without cross-replaying', async () => {
  const kv = new FakeKv()
  const first = createDialogueStore({ kv, now: () => 1000 })
  await first.load()
  await first.commit(first.prepare(input()), { reply: 'advice reply', complete: true })
  await first.commit(first.prepare(qa()), { reply: 'VERDICT: REVISE', complete: true })

  const second = createDialogueStore({ kv, now: () => 1000 })
  await second.load()
  assert.equal(second.prepare(input()).replay, 'advice reply')
  assert.equal(second.prepare(qa()).replay, 'VERDICT: REVISE')
  assert.equal(second.prepare(input({ source: 'alpha beta' })).reason, 'append')
  assert.equal(second.prepare(qa({ source: 'alpha beta' })).reason, 'append')
})

test('a legacy flat review checkpoint is pruned, a legacy advice checkpoint still replays', async () => {
  const key = dialogueIdentity(input())
  const legacyReview = checkpoint('alpha', 9901, {
    reply: 'VERDICT: PASS',
    wire: [
      { role: 'user', content: SETUP_USER },
      { role: 'assistant', content: SETUP_ASSISTANT },
      { role: 'user', content: QUOTED + 'alpha' + REVIEW_SUFFIX }
    ]
  })
  const reviewKv = new FakeKv({ [key]: legacyReview })
  const reviewStore = createDialogueStore({ kv: reviewKv, now: () => 10000 })
  await reviewStore.load()
  const plan = reviewStore.prepare(input())
  assert.equal(plan.reason, 'initial')
  assert.equal(plan.replay, null, 'a 0.6.0 review checkpoint must not be replayed as advice')
  assert.deepEqual(reviewKv.deletes, [key], 'the unreadable record is pruned instead of trusted')
  assert.deepEqual(reviewStore.stats(), { records: 0, persistentRecords: 0, lastAttempts: 0 })

  const adviceKv = new FakeKv({ [key]: checkpoint('alpha', 9901, { reply: 'legacy advice' }) })
  const adviceStore = createDialogueStore({ kv: adviceKv, now: () => 10000 })
  await adviceStore.load()
  assert.equal(adviceStore.prepare(input()).replay, 'legacy advice', 'a flat advice checkpoint stays usable')
})

test('a cut on one request thread leaves the other thread append-only', async () => {
  const store = createDialogueStore()
  const advice = store.prepare(input({ source: 'A' }))
  await store.commit(advice, { reply: 'advice A', complete: true })
  const review = store.prepare(qa({ source: 'A' }))
  await store.commit(review, { reply: 'VERDICT: PASS', complete: true })
  await store.commit(store.prepare(qa({ source: 'AB' })), { complete: false, reason: 'deadline' })

  const adviceNext = store.prepare(input({ source: 'AB' }))
  assert.equal(adviceNext.reason, 'append')
  assert.equal(adviceNext.transportEpoch, advice.transportEpoch, 'the advice transport series was never cut')
  const reviewNext = store.prepare(qa({ source: 'ABC' }))
  assert.equal(reviewNext.reason, 'append_after_cut')
  assert.notEqual(reviewNext.transportEpoch, review.transportEpoch)
})

test('a completed review does not erase an advice transport cut', async () => {
  const store = createDialogueStore()
  const advice = store.prepare(input({ source: 'A' }))
  await store.commit(advice, { reply: 'advice A', complete: true })
  const review = store.prepare(qa({ source: 'A' }))
  await store.commit(review, { reply: 'VERDICT: PASS', complete: true })

  // The advice transport dies after A, so the advice thread must start a fresh
  // transport series. The review thread finishing afterwards is what used to clear
  // that marker before the advice thread could consume it.
  await store.commit(store.prepare(input({ source: 'AB' })), { complete: false, reason: 'deadline' })
  await store.commit(store.prepare(qa({ source: 'AB' })), { reply: 'VERDICT: PASS', complete: true })

  const adviceNext = store.prepare(input({ source: 'ABC' }))
  assert.equal(adviceNext.reason, 'append_after_cut', 'the advice cut survives an unrelated review completion')
  assert.notEqual(adviceNext.transportEpoch, advice.transportEpoch)
  assert.deepEqual(adviceNext.wire.slice(3), [
    { role: 'assistant', content: 'advice A' },
    { role: 'user', content: NEW_DELTA + 'BC' + SUFFIX }
  ])
})

test('a cut on one request thread survives a cut on the other thread', async () => {
  const kv = new FakeKv()
  const store = createDialogueStore({ kv })
  const adviceFirst = store.prepare(input({ source: 'A' }))
  await store.commit(adviceFirst, { reply: 'advice A', complete: true })
  const reviewFirst = store.prepare(qa({ source: 'A' }))
  await store.commit(reviewFirst, { reply: 'VERDICT: PASS', complete: true })

  // Both transport series die before either thread resumes: the second cut must not
  // overwrite the first, or the advice thread would reuse a dead transport series.
  await store.commit(store.prepare(input({ source: 'AB' })), { complete: false, reason: 'deadline' })
  await store.commit(store.prepare(qa({ source: 'AB' })), { complete: false, reason: 'deadline' })

  const adviceNext = store.prepare(input({ source: 'ABC' }))
  assert.equal(adviceNext.reason, 'append_after_cut', 'the review cut must not erase the advice cut')
  assert.notEqual(adviceNext.transportEpoch, adviceFirst.transportEpoch)
  const reviewNext = store.prepare(qa({ source: 'ABC' }))
  assert.equal(reviewNext.reason, 'append_after_cut', 'the advice cut must not erase the review cut')
  assert.notEqual(reviewNext.transportEpoch, reviewFirst.transportEpoch)

  // A cut belongs to its thread's checkpoint, so it survives a reload too.
  const reloaded = createDialogueStore({ kv })
  await reloaded.load()
  assert.equal(reloaded.prepare(input({ source: 'ABC' })).reason, 'append_after_cut')
  assert.equal(reloaded.prepare(qa({ source: 'ABC' })).reason, 'append_after_cut')
})

test('digest-v2 checkpoints rebase once into seeded history, including an unchanged snapshot', async () => {
  const old = checkpoint('alpha', 9901, {
    view: 'digest-v2', transportEpoch: 'old-native-epoch', reply: 'old advice',
    wire: [
      { role: 'user', content: SETUP_USER },
      { role: 'assistant', content: SETUP_ASSISTANT },
      { role: 'user', content: QUOTED + 'alpha' + SUFFIX }
    ]
  })
  const kv = new FakeKv({ [dialogueIdentity(input())]: old })
  const store = createDialogueStore({ kv, now: () => 10000 })
  await store.load()
  const rebuilt = store.prepare(input())
  assert.equal(rebuilt.reason, 'rebased')
  assert.equal(rebuilt.replay, null, 'an unchanged old snapshot must still migrate')
  assert.notEqual(rebuilt.transportEpoch, 'old-native-epoch')
  assert.deepEqual(rebuilt.wire, initialWire('alpha'))
  assert.ok(rebuilt.wire[0].content.includes(QUOTED + 'alpha'))
  assert.equal(rebuilt.wire[2].content, SUFFIX, 'the wrapped live tail contains only the short instruction')
  await store.commit(rebuilt, { reply: 'fresh advice', complete: true })
  const next = store.prepare(input({ source: 'alpha delta' }))
  assert.equal(next.reason, 'append')
  assert.equal(next.transportEpoch, rebuilt.transportEpoch)
  assert.deepEqual(next.wire.slice(0, 3), rebuilt.wire)
  const reloaded = createDialogueStore({ kv, now: () => 10000 })
  await reloaded.load()
  assert.equal(reloaded.prepare(input()).reason, 'same_snapshot')
  assert.equal(reloaded.prepare(input()).replay, 'fresh advice')
})

let passed = 0
let failed = 0
for (const { name, run } of tests) {
  try {
    await run()
    passed++
    console.log(`ok ${passed} - ${name}`)
  } catch (error) {
    failed++
    console.error(`not ok - ${name}`)
    console.error(error?.stack ?? error)
  }
}

console.log(`\n${passed}/${tests.length} tests passed`)
if (failed) process.exitCode = 1
