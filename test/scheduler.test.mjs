import assert from 'node:assert/strict'
import test from 'node:test'
import { createScheduler, gapDecision, normalizeDecision, normalizeScheduler, parseVerdict, JEV_URL } from '../scheduler.js'

test('normalizeScheduler clamps values and never stores a key value', () => {
  const value = normalizeScheduler({ kind: 'jev', apiKey: 'secret', apiKeyEnv: 'bad name', threshold: 3, minGap: 0, maxGap: -1, timeoutMs: 5 })
  assert.equal(value.kind, 'jev')
  assert.equal(value.apiKey, undefined)
  assert.equal(value.apiKeyEnv, 'TYPESAFE_API_KEY')
  assert.equal(value.threshold, 0.95)
  assert.equal(value.minGap, 1)
  assert.equal(value.maxGap, 1)
  assert.equal(value.timeoutMs, 1000)
  assert.equal(normalizeScheduler(undefined).kind, 'model')
})

test('gap rules run before the classifier', () => {
  const s = normalizeScheduler({ minGap: 2, maxGap: 5 })
  assert.deepEqual(gapDecision(s, 1).ask, false)
  assert.equal(gapDecision(s, 1).due, false)
  assert.equal(gapDecision(s, 3).ask, true)
  assert.equal(gapDecision(s, 5).due, true)
})

test('parseVerdict accepts one JSON line and rejects prose', () => {
  assert.deepEqual(parseVerdict('{"intervene": true, "confidence": 0.8, "stage": "tests ran"}'), { intervene: true, confidence: 0.8, stage: 'tests ran' })
  assert.equal(parseVerdict('yes, intervene'), null)
  assert.equal(parseVerdict('{"intervene": "yes"}'), null)
})

test('scheduler capacity migrates legacy settings explicitly to 128000', () => {
  assert.equal(normalizeScheduler({stateChars:6000}).stateChars,128000)
  assert.equal(normalizeScheduler({stateChars:100000}).stateChars,100000)
  assert.equal(normalizeScheduler({stateChars:999999}).stateChars,512000)
})

test('model scheduler: strict JSON, private session id, threshold', async () => {
  const calls = []
  const runtime = {
    stream(options) {
      calls.push(options)
      return (async function * () {
        yield { type: 'text-delta', text: '{"intervene": true, "confidence": 0.7, "stage": "edit batch done"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const scheduler = createScheduler({ runtime })
  const high = await scheduler.decide({ scheduler: normalizeScheduler({ provider: 'p', model: 'm', threshold: 0.8 }), state: 'tail', sessionId: 's1' })
  assert.equal(high.due, false)
  const low = await scheduler.decide({ scheduler: normalizeScheduler({ provider: 'p', model: 'm', threshold: 0.6 }), state: 'tail', sessionId: 's1' })
  assert.equal(low.due, true)
  assert.equal(low.stage, 'edit batch done')
  assert.equal(calls[0].sessionId, 'moa-sched-s1')
  assert.equal(calls[0].tools, undefined)
})

test('JEV scheduler: request shape, key from env only, max(boundary, stuck)', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ answers: { boundary: { type: 'noul', noul: 0.3 }, stuck: { type: 'noul', noul: 0.72 } } }) }
  }
  const scheduler = createScheduler({ runtime: null, fetchImpl, env: { MY_KEY: 'k-123' } })
  const result = await scheduler.decide({ scheduler: normalizeScheduler({ kind: 'jev', apiKeyEnv: 'MY_KEY' }), state: 'tail' })
  assert.equal(result.due, true)
  assert.equal(result.reason, 'smart-jev-stuck')
  assert.equal(requests[0].url, JEV_URL)
  assert.equal(requests[0].init.headers.authorization, 'Bearer k-123')
  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.model, 'jev-latest')
  assert.equal(body.state, 'tail')
  assert.deepEqual(Object.keys(body.questions), ['boundary', 'stuck'])
  assert.equal(body.questions.boundary.type, 'noul')
})

test('no decision model fails closed and smart cadence uses only maxGap', async () => {
  const decision = normalizeDecision({ kind: 'none', minGap: 2, maxGap: 20 })
  assert.deepEqual(gapDecision(decision, 19), { due: false, ask: false, reason: 'smart-no-decision-model' })
  assert.deepEqual(gapDecision(decision, 20), { due: true, ask: false, reason: 'smart-max-gap-20' })
  const scheduler = createScheduler({ runtime: null, fetchImpl: () => { throw new Error('unexpected request') } })
  const result = await scheduler.decide({ scheduler: decision, state: 'tail' })
  assert.equal(result.due, false)
  assert.equal(result.reason, 'smart-no-decision-model')
})

test('credential store wins over environment and environment remains the fallback', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ answers: { boundary: { noul: 0.2 }, stuck: { noul: 0.1 } } }) }
  }
  const store = createScheduler({
    runtime: null, fetchImpl, env: { TEST_KEY: 'test-env-key' },
    credentials: { async resolve(ref) { assert.equal(ref, 'TEST_KEY'); return { value: 'test-store-key', source: 'file' } } },
  })
  await store.decide({ scheduler: normalizeScheduler({ kind: 'jev', apiKeyEnv: 'TEST_KEY' }), state: 'tail' })
  assert.equal(requests[0].init.headers.authorization, 'Bearer test-store-key')
  const fallback = createScheduler({ runtime: null, fetchImpl, env: { TEST_KEY: 'test-env-key' }, credentials: { async resolve() {} } })
  await fallback.decide({ scheduler: normalizeScheduler({ kind: 'jev', apiKeyEnv: 'TEST_KEY' }), state: 'tail' })
  assert.equal(requests[1].init.headers.authorization, 'Bearer test-env-key')
})

test('openai-compatible decisions use the injected transport, configured route and credential store', async () => {
  const requests = []
  const openaiFetchImpl = async (url, init) => {
    requests.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"intervene":true,"confidence":0.9,"stage":"test"}' }] }] }) }
  }
  // The JEV transport must never carry an OpenAI-compatible judge.
  const fetchImpl = () => { throw new Error('JEV transport used for an OpenAI-compatible judge') }
  const scheduler = createScheduler({ runtime: null, fetchImpl, openaiFetchImpl, env: {}, credentials: { async resolve() { return { value: 'test-key' } } } })
  const decision = normalizeDecision({ kind: 'openai-compatible', baseURL: 'https://models.example/v1', credentialRef: 'TEST_KEY', model: 'fake/judge' })
  const result = await scheduler.decide({ scheduler: decision, state: 'tail', sessionId: 'session' })
  assert.equal(result.due, true, JSON.stringify(result))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://models.example/v1/responses')
  assert.equal(JSON.parse(requests[0].init.body).model, 'fake/judge')
  assert.equal(requests[0].init.headers.authorization, 'Bearer test-key')
})

test('JEV uses Host fetch when no transport is injected, as index.js creates it', async () => {
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ answers: { boundary: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.2 } } }) }
  }
  try {
    const scheduler = createScheduler({ runtime: null, env: { MY_KEY: 'k-123' } })
    const result = await scheduler.decide({ scheduler: normalizeScheduler({ kind: 'jev', apiKeyEnv: 'MY_KEY' }), state: 'tail' })
    assert.equal(result.error, undefined, result.error)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, JEV_URL)
    assert.equal(requests[0].init.headers.authorization, 'Bearer k-123')
  } finally {
    globalThis.fetch = original
  }
})

test('an injected JEV fetchImpl wins over Host fetch', async () => {
  const original = globalThis.fetch
  let hostCalls = 0
  globalThis.fetch = async () => { hostCalls++; throw new Error('Host fetch used despite an injected transport') }
  try {
    const requests = []
    const fetchImpl = async (url, init) => {
      requests.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ answers: { boundary: { type: 'noul', noul: 0.1 }, stuck: { type: 'noul', noul: 0.2 } } }) }
    }
    const scheduler = createScheduler({ runtime: null, fetchImpl, env: { MY_KEY: 'k-123' } })
    const result = await scheduler.decide({ scheduler: normalizeScheduler({ kind: 'jev', apiKeyEnv: 'MY_KEY' }), state: 'tail' })
    assert.equal(result.error, undefined, result.error)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, JEV_URL)
    assert.equal(hostCalls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('JEV scheduler: HTTP errors become "not now" with a readable reason', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) })
  const scheduler = createScheduler({ runtime: null, fetchImpl, env: { K: 'x' } })
  const result = await scheduler.decide({ scheduler: normalizeScheduler({ kind: 'jev', apiKeyEnv: 'K' }), state: 'tail' })
  assert.equal(result.due, false)
  assert.match(result.error, /JEV HTTP 401 \(bad API key\)/)
})
