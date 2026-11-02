// Run from the workspace root: node moa-selftest/budget.test.mjs
// Per-reference context budget (Better MoA 0.9 item 7) and the transcript
// window it drives (item 9 stride, windowStart).

import assert from 'node:assert/strict'
import {
  LEARNED_WINDOW_TTL_MS,
  MIN_REFERENCE_BUDGET,
  biliTokens,
  budgetFitMessage,
  contextOverflowMessage,
  fallbackWindow,
  fitCheck,
  freshLearnedWindow,
  isContextOverflow,
  learnedWindowRecord,
  parseWindowRefusal,
  referenceBudget,
  tokenCost,
  windowKey,
  wireTokens,
} from '../budget.js'
import { buildAdvisorTranscript } from '../transcript.js'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

const REFUSAL = 'error: context ~250000 tokens exceeds the model window 184000 (preflight_compress_failed). The over-window payload was NOT forwarded.'

function toolHistory(count, text = index => `observation ${index}: ` + 'x'.repeat(160)) {
  return Array.from({ length: count }, (_, index) => ({
    id: `history-${index}`, role: 'tool', source: { kind: 'tool' },
    content: [{ type: 'text', text: text(index) }],
  }))
}

test('biliTokens ports bili defaultCountTokens', () => {
  assert.equal(biliTokens(''), 0)
  assert.equal(biliTokens('abcd'), 1)
  assert.equal(biliTokens('abcde'), 2)
  assert.equal(biliTokens('中'), 1)
  assert.equal(biliTokens('中文ab'), 3)
  assert.equal(biliTokens('ひらがなカタカナ'), 8)
  assert.equal(biliTokens('한국어'), 3)
  assert.equal(biliTokens(null), 0)
})

test('wireTokens takes the larger of the text count and the JSON byte estimate', () => {
  assert.equal(wireTokens({ system: '', messages: [] }), Math.ceil(Buffer.byteLength(JSON.stringify({ system: '', messages: [] })) / 4))
  const cjk = '中'.repeat(4000)
  const cjkWire = { system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: cjk }] }] }
  assert.ok(wireTokens(cjkWire) >= 4000)
  const escaped = '\u0001'.repeat(4000)
  const escapedWire = { system: '', messages: [{ role: 'user', content: escaped }] }
  // Every control char is six JSON bytes, so the byte estimate wins.
  assert.ok(wireTokens(escapedWire) >= 6000)
  assert.ok(wireTokens(escapedWire) > biliTokens(escaped))
  const reasoning = { system: '', messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'a'.repeat(4000) }] }] }
  assert.ok(wireTokens(reasoning) >= 1000)
  assert.equal(tokenCost('中'.repeat(100)), 100)
  assert.equal(tokenCost('\u0001'.repeat(100)), Math.ceil((600 + 2) / 4))
})

test('fallbackWindow follows the documented table', () => {
  assert.equal(fallbackWindow('anthropic', 'claude-sonnet-4'), 200000)
  assert.equal(fallbackWindow('magpie-anthropic', 'ai/ai/claude-tui/opus'), 200000)
  assert.equal(fallbackWindow('my-claude-gateway', 'mystery'), 200000)
  assert.equal(fallbackWindow('zhipu', 'glm-4.6'), 128000)
  assert.equal(fallbackWindow('deepseek-official', 'deepseek-v3.2'), 128000)
  assert.equal(fallbackWindow('router', 'vendor/deepseek-r1-0528'), 128000)
  assert.equal(fallbackWindow('router', 'deepseek-ocr'), 128000)
  assert.equal(fallbackWindow('openai', 'gpt-4o-mini'), 128000)
  assert.equal(fallbackWindow('bili', 'moonshot/kimi-k2'), 200000)
  assert.equal(fallbackWindow('bili', 'qwen3-max'), 200000)
  assert.equal(fallbackWindow('openai', 'gpt-5.1'), 200000)
  assert.equal(fallbackWindow('openai', 'o3-mini'), 200000)
  assert.equal(fallbackWindow('openai', 'o1-preview'), 200000)
  assert.equal(fallbackWindow('local', 'llama-3-70b'), 128000)
  assert.equal(fallbackWindow(undefined, undefined), 128000)
})

test('referenceBudget matches the documented examples', () => {
  const now = 1_800_000_000_000
  const catalog = referenceBudget({ catalogWindow: 1048576, reserve: 16000, now })
  assert.deepEqual(catalog, {
    window: 1048576, windowSource: 'catalog', nativeWindowSource: 'catalog',
    reserve: 16000, reserveKnown: true, reserveSource: 'reference', sendMaxTokens: 16000,
    trimReserve: null, nativeBudget: 980947, budget: 980947,
  })
  const learned = { effectiveLimit: 184000, reserveAtLearning: 16000, learnedAt: now - 1000 }
  const same = referenceBudget({ catalogWindow: 1048576, reserve: 16000, learned, now })
  assert.equal(same.budget, 174800)
  assert.equal(same.learnedCap, 174800)
  assert.equal(same.learnedLimit, 184000)
  assert.equal(same.window, 1048576, 'the native window stays the reported window')
  assert.equal(same.nativeWindowSource, 'catalog')
  assert.equal(same.windowSource, 'learned', 'the learned cap binds')
  assert.equal(referenceBudget({ catalogWindow: 1048576, reserve: 32000, learned, now }).budget, 159600)
  // Learned without any maxTokens: bili reserved nothing we know of, so the full
  // learned limit minus the output we now send must fit.
  assert.equal(referenceBudget({ catalogWindow: 1048576, reserve: 16000, learned: { ...learned, reserveAtLearning: null }, now }).budget, 159600)
  for (const reserve of [undefined, 0, 1000, 16000, 64000]) {
    for (const reserveAtLearning of [null, 0, 16000, 100000]) {
      const result = referenceBudget({ catalogWindow: 1048576, reserve, learned: { ...learned, reserveAtLearning }, now })
      if (result.learnedIgnored) {
        // Learned with a maxTokens that is no longer sent: bili's reserve changes,
        // so the record cannot be reused (a fresh refusal re-learns it).
        assert.equal(result.learnedIgnored, 'output-cap-removed')
        assert.equal(result.reserveKnown, false)
        continue
      }
      assert.ok(result.budget <= 184000, `budget ${result.budget} must not exceed the learned limit`)
      assert.ok(result.learnedCap <= 184000)
    }
  }
  const explicitWins = referenceBudget({ contextWindow: 65536, catalogWindow: 1048576, reserve: 4000, learned, now })
  assert.equal(explicitWins.learnedIgnored, 'explicit-window')
  assert.equal(explicitWins.budget, Math.floor((65536 - 4000) * 0.95))
})

test('referenceBudget prefers an explicit window, then the catalog, then the fallback', () => {
  assert.deepEqual(referenceBudget({ contextWindow: 65536, catalogWindow: 1048576, reserve: 4000 }), {
    window: 65536, windowSource: 'explicit', nativeWindowSource: 'explicit',
    reserve: 4000, reserveKnown: true, reserveSource: 'reference', sendMaxTokens: 4000,
    trimReserve: null, nativeBudget: 58459, budget: 58459,
  })
  // No maxTokens anywhere: nothing is sent, a quarter of the window is held back
  // for the trim estimate only.
  assert.deepEqual(referenceBudget({ provider: 'bili', model: 'moonshot/kimi-k2' }), {
    window: 200000, windowSource: 'fallback', nativeWindowSource: 'fallback',
    reserve: null, reserveKnown: false, reserveSource: null, sendMaxTokens: null,
    trimReserve: 50000, nativeBudget: 142500, budget: 142500,
  })
  assert.equal(referenceBudget({ catalogWindow: 10000, reserve: 20000 }).budget, 0)
  // maxTokens precedence: reference > preset > catalog default.
  const preset = referenceBudget({ catalogWindow: 1000000, presetMaxTokens: 8192, catalogMaxTokens: 128000 })
  assert.equal(preset.sendMaxTokens, 8192)
  assert.equal(preset.reserveSource, 'preset')
  const fromCatalog = referenceBudget({ catalogWindow: 1000000, catalogMaxTokens: 128000 })
  assert.equal(fromCatalog.sendMaxTokens, 128000)
  assert.equal(fromCatalog.reserveSource, 'catalog')
  assert.equal(fromCatalog.budget, Math.floor((1000000 - 128000) * 0.95))
  assert.equal(referenceBudget({ catalogWindow: 1000000, referenceMaxTokens: 16000, presetMaxTokens: 8192 }).reserveSource, 'reference')
})

test('fitCheck and learnedWindowRecord', () => {
  assert.deepEqual(fitCheck({ budget: 500, systemTokens: 10 }), { ok: false, needTokens: 10, budget: 500, reason: 'below-floor' })
  assert.deepEqual(fitCheck({ budget: 5000, systemTokens: 3000, scaffoldTokens: 200, anchorTokens: 1500, evidenceTokens: 400 }),
    { ok: false, needTokens: 5100, budget: 5000, reason: 'core-too-large' })
  assert.equal(fitCheck({ budget: 5000, systemTokens: 3000, evidenceTokens: 400 }).ok, true)
  assert.equal(MIN_REFERENCE_BUDGET, 1024)
  assert.deepEqual(learnedWindowRecord({ effectiveLimit: 184000, sendMaxTokens: 16000, now: 5 }), { effectiveLimit: 184000, reserveAtLearning: 16000, learnedAt: 5 })
  assert.deepEqual(learnedWindowRecord({ effectiveLimit: 184000, now: 5 }), { effectiveLimit: 184000, reserveAtLearning: null, learnedAt: 5 })
  assert.equal(learnedWindowRecord({ effectiveLimit: 0 }), null)
})

test('isContextOverflow separates provider overflow from bili refusals and rate limits', () => {
  assert.equal(isContextOverflow('400 This model\'s maximum context length is 131072 tokens'), true)
  assert.equal(isContextOverflow('prompt is too long: 210000 tokens > 200000 maximum'), true)
  assert.equal(isContextOverflow(REFUSAL), false)
  assert.equal(isContextOverflow('429 rate limit: too many tokens per minute'), false)
  assert.equal(isContextOverflow('max_tokens is too large: 200000'), false)
  assert.match(contextOverflowMessage({ label: 'GLM', provider: 'zhipu', model: 'glm', window: 128000, reserve: 8192 }), /Not retried/)
})

test('learned windows expire after six hours', () => {
  const now = 1_800_000_000_000
  const record = { effectiveLimit: 184000, reserveAtLearning: 16000, learnedAt: now - LEARNED_WINDOW_TTL_MS + 1 }
  assert.deepEqual(freshLearnedWindow(record, now), { effectiveLimit: 184000, reserveAtLearning: 16000, learnedAt: record.learnedAt })
  assert.equal(freshLearnedWindow({ ...record, learnedAt: now - LEARNED_WINDOW_TTL_MS }, now), null)
  assert.equal(freshLearnedWindow({ ...record, effectiveLimit: 0 }, now), null)
  assert.equal(freshLearnedWindow(null, now), null)
  assert.equal(freshLearnedWindow({ ...record, reserveAtLearning: undefined }, now).reserveAtLearning, null)
  const stale = referenceBudget({ catalogWindow: 1048576, reserve: 16000, learned: { ...record, learnedAt: now - LEARNED_WINDOW_TTL_MS - 1 }, now })
  assert.equal(stale.budget, 980947)
  assert.equal(Object.hasOwn(stale, 'learnedCap'), false)
})

test('parseWindowRefusal accepts only the bili preflight refusal', () => {
  assert.equal(parseWindowRefusal(REFUSAL), 184000)
  assert.equal(parseWindowRefusal(`503 Service Unavailable: ${REFUSAL}`), 184000)
  assert.equal(parseWindowRefusal('context ~250000 tokens exceeds the model window 184000'), null)
  assert.equal(parseWindowRefusal('The over-window payload was NOT forwarded.'), null)
  assert.equal(parseWindowRefusal('503 Service Unavailable'), null)
  assert.equal(parseWindowRefusal(undefined), null)
})

test('windowKey is a stable per-route hash', () => {
  assert.match(windowKey('bili', 'kimi'), /^[a-f0-9]{64}$/)
  assert.equal(windowKey('bili', 'kimi'), windowKey('bili', 'kimi'))
  assert.notEqual(windowKey('bili', 'kimi'), windowKey('bili', 'kimi-2'))
  assert.notEqual(windowKey('a', 'b/c'), windowKey('a/b', 'c'))
})

test('budgetFitMessage names the numbers and the remedies', () => {
  const text = budgetFitMessage({
    label: 'Kimi', provider: 'bili', model: 'kimi', used: 9000, system: 1200, transcript: 7000,
    budget: 7600, window: 24000, reserve: 16000, dropped: 12,
  })
  assert.equal(text, 'advisor payload cannot fit Kimi (bili/kimi): needs ~9000 tokens (system 1200, transcript 7000, dialogue 800), budget 7600 = window 24000 − maxTokens 16000 − 5% margin. The oldest 12 messages were already dropped and the persistent dialogue was rebuilt. Lower this reference\'s maxTokens, raise its context window in bili\'s route/model config (currently 24000), or disable it for large sessions.')
  const learned = budgetFitMessage({
    label: 'Kimi', provider: 'bili', model: 'kimi', used: 9000, system: 1200, transcript: 7000,
    budget: 7600, window: 1048576, reserve: 16000, dropped: 12, learnedLimit: 24000,
  })
  assert.match(learned, /budget 7600 = window 1048576 − maxTokens 16000 − 5% margin, capped by bili's learned model window 24000\./)
  assert.match(learned, /\(currently 24000\)/)
  const unknown = budgetFitMessage({
    label: 'Kimi', provider: 'bili', model: 'kimi', used: 9000, system: 1200, transcript: 7000,
    budget: 7600, window: 24000, reserve: 6000, reserveKnown: false, dropped: 12,
  })
  assert.match(unknown, /estimated output reserve 6000 \(no maxTokens set\)/)
  assert.match(unknown, /Set this reference's maxTokens explicitly/)
})

test('a pinned request survives a long turn that pushes it out of the window', () => {
  const history = [
    { id: 'ask', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'TASK: migrate the parser to the new grammar' }] },
    ...toolHistory(60),
  ]
  const view = buildAdvisorTranscript(history, [], { maxTotalChars: 4000 })
  assert.equal(view.windowed, true)
  assert.equal(view.anchored, true)
  assert.ok(view.windowStart > 1)
  assert.ok(view.source.includes('TASK: migrate the parser'))
  assert.ok(view.source.includes('messages between the request above and the evidence below omitted'))
  assert.ok(view.source.length <= 4000)
  assert.equal(view.source.split('TASK: migrate the parser').length, 2, 'the request appears once')
  const inside = buildAdvisorTranscript(history.slice(0, 5), [], { maxTotalChars: 4000 })
  assert.equal(inside.windowed, false)
  assert.equal(inside.anchored, false)
})

test('windowStart reports the first kept message', () => {
  assert.equal(buildAdvisorTranscript([], []).windowStart, 0)
  const small = buildAdvisorTranscript(toolHistory(3))
  assert.equal(small.windowed, false)
  assert.equal(small.windowStart, 0)
  const view = buildAdvisorTranscript(toolHistory(40), [], { maxTotalChars: 4000 })
  assert.equal(view.windowed, true)
  assert.ok(view.windowStart > 0)
  assert.equal(view.messageCount, 40 - view.windowStart)
  assert.ok(view.source.includes(`id="history-${view.windowStart}"`))
  assert.ok(!view.source.includes(`id="history-${view.windowStart - 1}"`))
  const single = buildAdvisorTranscript([{ id: 'one', role: 'tool', content: 'y'.repeat(9000) }], [], { maxTotalChars: 1000 })
  assert.equal(single.windowed, true)
  assert.equal(single.windowStart, 0)
  assert.equal(single.messageCount, 1)
})

test('a token cap that does not bind leaves the transcript byte-identical', () => {
  const history = toolHistory(60)
  for (const maxTotalChars of [4000, 20000, 1400000]) {
    const canonical = buildAdvisorTranscript(history, [], { maxTotalChars })
    const capped = buildAdvisorTranscript(history, [], { maxTotalChars, maxTotalTokens: maxTotalChars })
    assert.equal(capped.source, canonical.source)
    assert.equal(capped.turnSource, canonical.turnSource)
    assert.equal(capped.messageCount, canonical.messageCount)
    assert.equal(capped.windowStart, canonical.windowStart)
    assert.equal(capped.windowed, canonical.windowed)
  }
})

test('a binding token cap bounds CJK-heavy and escape-heavy sources', () => {
  const cjk = toolHistory(40, index => `第${index}步` + '中文观察结果'.repeat(80))
  const cjkView = buildAdvisorTranscript(cjk, [], { maxTotalChars: 1400000, maxTotalTokens: 5000 })
  assert.equal(cjkView.windowed, true)
  assert.ok(tokenCost(cjkView.source) <= 5000, `CJK source costs ${tokenCost(cjkView.source)} tokens`)
  assert.ok(cjkView.messageCount >= 2)
  const escaped = toolHistory(40, index => `${index}` + '\u0001'.repeat(2000))
  const escapedView = buildAdvisorTranscript(escaped, [], { maxTotalChars: 1400000, maxTotalTokens: 20000 })
  assert.equal(escapedView.windowed, true)
  assert.ok(tokenCost(escapedView.source) <= 20000, `escaped source costs ${tokenCost(escapedView.source)} tokens`)
  const uncapped = buildAdvisorTranscript(escaped, [], { maxTotalChars: 1400000 })
  assert.equal(uncapped.windowed, false, 'the char-only canonical view is not affected by the token cap')
})

test('the half-budget stride keeps the window between budget/2 and budget and rotates rarely', () => {
  const options = { maxTotalChars: 4000 }
  const all = toolHistory(160)
  let previous = null
  let rotations = 0
  for (let length = 30; length <= 160; length++) {
    const view = buildAdvisorTranscript(all.slice(0, length), [], options)
    assert.equal(view.windowed, true)
    assert.ok(view.source.length <= options.maxTotalChars)
    assert.ok(view.source.length >= 2000 - 300, `kept window ${view.source.length} fell below half the budget`)
    if (previous) {
      if (view.windowStart === previous.windowStart) {
        assert.ok(view.source.startsWith(previous.source), 'growth inside a bucket must stay append-only')
      } else {
        rotations++
      }
    }
    previous = view
  }
  // About 220 chars per record and a ~1984-char stride: one rotation per ~9
  // messages. A quarter-budget stride would rotate about twice as often.
  assert.ok(rotations <= 16, `the window rotated ${rotations} times over 130 appended messages`)
  assert.ok(rotations >= 8)
})

let passed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    passed++
    console.log(`ok ${passed} - ${name}`)
  } catch (error) {
    console.error(`not ok ${passed + 1} - ${name}`)
    console.error(error)
    process.exitCode = 1
    break
  }
}
if (passed === tests.length) console.log(`budget.test: ${passed}/${tests.length} passed`)
