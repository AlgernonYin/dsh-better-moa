// Config contract tests for the user-owned Better MoA table.
//
// Boundary rule: import the canonical ../dsh-better-moa implementation directly.
// Every assertion is causal: it names the user-visible behaviour (which preset is
// routable, which reference identity is reused, how long a call may take) instead
// of reading private fields or restating implementation arithmetic.
//
// Run: node --test moa-selftest/config.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  Config, DEFAULT_CONFIG, SESSION_POLICIES, buildPresetTable, normalizeConfig, normalizeFanout,
  normalizePresetOverrides, resolveConcurrency,
} from '../config.js'
import { DEFAULT_PRESET_ID, DEFAULT_PRESETS, PRESET_ORDER } from '../presets.js'

function preset(overrides = {}) {
  return {
    aggregator: { provider: 'fake', model: 'fake/aggregator' },
    references: [{ provider: 'fake', model: 'fake/ref', id: 'ref-a' }],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. no bundled recipes
// ---------------------------------------------------------------------------

test('the distributable ships no built-in model recipes', () => {
  assert.equal(DEFAULT_PRESET_ID, '', 'the default preset id must be empty, not a bundled recipe name')
  assert.deepEqual(DEFAULT_PRESETS, {}, 'the release must not reconstruct local recipes as defaults')
  assert.deepEqual(PRESET_ORDER, [])
  assert.ok(Object.isFrozen(DEFAULT_PRESETS), 'the empty default table must be immutable')
  assert.ok(Object.isFrozen(PRESET_ORDER), 'the empty preset order must be immutable')

  const config = normalizeConfig({})
  assert.equal(config.defaultPreset, '')
  assert.deepEqual(config.presetOverrides, {})
  assert.equal(buildPresetTable(config).size, 0, 'an empty install must not fabricate a usable preset')
})

test('schema defaults normalize to parallel calls and the documented timeout budget', () => {
  const config = normalizeConfig(Config({}))
  assert.equal(config.enabled, true)
  assert.equal(config.guardEnabled, true)
  assert.equal(config.referenceSchedule, 'parallel', 'the shipped schedule is parallel, not a legacy serial value')
  assert.equal(config.adviceHistory, 'latest')
  assert.equal(config.referenceTimeoutMs, 600000, 'one reference call defaults to ten minutes')
  assert.equal(config.deadlineMs, 900000, 'the whole reference round defaults to fifteen minutes')
  assert.equal(config.queueBudgetMs, 0)
  assert.equal(config.defaultPreset, '')
  assert.deepEqual(config.presetOverrides, {})
  assert.deepEqual(config.disabledPresets, [])
  assert.equal(DEFAULT_CONFIG.referenceTimeoutMs, 600000)
  assert.equal(DEFAULT_CONFIG.deadlineMs, 900000)
})

// ---------------------------------------------------------------------------
// 2. presetOverrides is a complete user table
// ---------------------------------------------------------------------------

test('a user preset is a complete record, never a patch over a bundled recipe', () => {
  const overrides = { mine: preset({ label: 'Mine', description: 'owned by the user' }) }
  const config = normalizeConfig({ presetOverrides: overrides })
  assert.deepEqual(Object.keys(config.presetOverrides), ['mine'], 'no other preset may appear alongside the user table')
  const stored = config.presetOverrides.mine
  assert.equal(stored.label, 'Mine')
  assert.equal(stored.fanout, 'user_turn', 'an omitted fanout takes the documented default')
  assert.equal(stored.references.length, 1)

  const table = buildPresetTable(config)
  assert.deepEqual([...table.keys()], ['mine'])
  assert.equal(table.get('mine').description, 'owned by the user')
  assert.equal(table.get('mine').referenceTimeoutMs, 600000, 'a missing per-reference timeout inherits the default')
  assert.equal(table.get('mine').deadlineMs, 900000, 'a missing whole-round deadline inherits the default')

  // A record that declares no references or aggregator must stay exactly that:
  // no bundled reference set and no bundled account may be merged in.
  const partial = normalizeConfig({ presetOverrides: { only: { label: 'Only' } } })
  assert.equal(partial.presetOverrides.only.label, 'Only')
  assert.equal(Object.hasOwn(partial.presetOverrides.only, 'references'), false, 'an empty reference list must not be synthesized')
  assert.equal(Object.hasOwn(partial.presetOverrides.only, 'aggregator'), false, 'an aggregator must not be synthesized')
  assert.equal(buildPresetTable(partial).size, 0, 'a preset without an aggregator route cannot be selected')
})

test('unsafe and reserved preset ids cannot enter the user table', () => {
  const raw = JSON.parse('{"__proto__":{"label":"proto"},"constructor":{"label":"ctor"},"prototype":{"label":"proto2"},"bad id":{"label":"space"},"a/b":{"label":"slash"},".hidden":{"label":"dot"},"Good_1.v2":{"label":"kept"}}')
  const table = normalizePresetOverrides(raw)
  assert.deepEqual(Object.keys(table), ['Good_1.v2'], 'only safe ASCII ids survive')
  assert.equal(Object.hasOwn(table, 'constructor'), false)
  assert.equal(Object.hasOwn(table, '__proto__'), false)
  assert.equal(normalizeConfig({ presetOverrides: raw }).defaultPreset, 'Good_1.v2', 'the default must be chosen only from surviving ids')
})

test('reference identities are deterministic, unique and never aliased', () => {
  const overrides = {
    A: preset({
      references: [
        { provider: 'fake', model: 'fake/r', id: 'dup' },
        { provider: 'fake', model: 'fake/r', id: 'dup' },
        { provider: 'fake', model: 'fake/r' },
        { provider: 'fake', model: 'fake/r', id: '__proto__' },
      ],
    }),
  }
  const normalized = normalizePresetOverrides(overrides)
  assert.deepEqual(normalized.A.references.map(reference => reference.id), ['dup', 'dup-2', 'ref-3', 'ref-4'])
  assert.deepEqual(normalized.A.references.map(reference => reference.label), ['Ref1', 'Ref2', 'Ref3', 'Ref4'])
  assert.deepEqual(normalizePresetOverrides(overrides), normalized, 'the same table must normalize to the same identities')
})

test('disabling a preset removes it from routing without deleting its configuration', () => {
  const overrides = { keep: preset(), off: preset({ label: 'Off' }) }
  const disabled = normalizeConfig({ presetOverrides: overrides, disabledPresets: ['off', 'ghost'] })
  assert.deepEqual(disabled.disabledPresets, ['off'], 'only ids present in the user table stay disabled')
  assert.equal(disabled.presetOverrides.off.label, 'Off', 'the disabled preset record is retained')
  assert.equal(disabled.presetOverrides.off.references.length, 1, 'disable must not delete references')
  assert.deepEqual([...buildPresetTable(disabled).keys()], ['keep'])

  const restored = normalizeConfig({ ...disabled, disabledPresets: [] })
  assert.deepEqual([...buildPresetTable(restored).keys()].sort(), ['keep', 'off'], 're-enabling restores the retained record')
})

test('defaultPreset falls back to the first available user preset, never to a bundled id', () => {
  const overrides = { second: preset(), first: preset() }
  assert.equal(normalizeConfig({ presetOverrides: overrides, defaultPreset: 'missing' }).defaultPreset, 'second')
  assert.equal(normalizeConfig({ presetOverrides: overrides, defaultPreset: 'first' }).defaultPreset, 'first')
  assert.equal(normalizeConfig({ presetOverrides: overrides, disabledPresets: ['second'] }).defaultPreset, 'first')
  assert.equal(normalizeConfig({ presetOverrides: {}, defaultPreset: 'anything' }).defaultPreset, '')
})

// ---------------------------------------------------------------------------
// 3. scheduling contract: parallel, ref count concurrency, fanout grammar
// ---------------------------------------------------------------------------

test('legacy serial/bounded schedules normalize to parallel and latest advice history', () => {
  for (const referenceSchedule of ['serial', 'bounded', 'parallel']) {
    const config = normalizeConfig({ referenceSchedule, adviceHistory: 'all' })
    assert.equal(config.referenceSchedule, 'parallel', `${referenceSchedule} must not survive as a serial queue`)
    assert.equal(config.adviceHistory, 'latest')
  }
  assert.equal(normalizeConfig({ adviceHistory: 'bogus' }).adviceHistory, 'latest')
})

test('concurrency is the reference count and ignores legacy maxConcurrency', () => {
  const refs = Array.from({ length: 12 }, (_, index) => ({ provider: 'fake', model: 'fake/r', id: `r${index}` }))
  const config = normalizeConfig({ maxConcurrency: 1, presetOverrides: { wide: preset({ references: refs }) } })
  const wide = buildPresetTable(config).get('wide')
  assert.equal(wide.references.length, 12, 'more than eight references must survive the table')
  assert.equal(resolveConcurrency(config, wide), 12, 'every reference starts in parallel')
  assert.equal(resolveConcurrency({ ...config, maxConcurrency: 8 }, wide), 12, 'legacy maxConcurrency cannot throttle a parallel table')

  const one = buildPresetTable(normalizeConfig({ presetOverrides: { one: preset() } })).get('one')
  assert.equal(resolveConcurrency(config, one), 1)
  const zero = buildPresetTable(normalizeConfig({ presetOverrides: { zero: preset({ references: [] }) } })).get('zero')
  assert.equal(resolveConcurrency(config, zero), 1, 'an empty fan-out still yields at least one worker slot')
})

test('fanout: every_n:1 keeps its literal cadence and every_n clamps to 1..999', () => {
  assert.equal(normalizeFanout('every_n:1'), 'every_n:1', 'every_n:1 must not collapse into another cadence')
  assert.equal(normalizeFanout('EVERY_N:1'), 'every_n:1')
  assert.equal(normalizeFanout('every_n:007'), 'every_n:7')
  assert.equal(normalizeFanout('every_n:999'), 'every_n:999')
  assert.equal(normalizeFanout('every_n:1000'), 'every_n:999')
  assert.equal(normalizeFanout('every_n:0'), 'every_n:1')
  assert.equal(normalizeFanout('per_iteration'), 'every_n:1', 'legacy every-iteration folds into every_n:1')
  assert.equal(normalizeFanout('smart'), 'smart')
  assert.equal(normalizeFanout('USER_TURN_END'), 'user_turn_end')
  assert.equal(normalizeFanout('nonsense'), 'user_turn')
  assert.equal(normalizeFanout(undefined), 'user_turn')

  assert.equal(normalizePresetOverrides({ A: preset({ fanout: 'every_n:1' }) }).A.fanout, 'every_n:1')
  assert.equal(buildPresetTable(normalizeConfig({ presetOverrides: { A: preset({ fanout: 'every_n:5000' }) } })).get('A').fanout, 'every_n:999')
})

// ---------------------------------------------------------------------------
// 4. timeout budget
// ---------------------------------------------------------------------------

test('timeouts: 600000ms per reference, 900000ms whole round, hard cap 1800000ms', () => {
  const config = normalizeConfig({
    referenceTimeoutMs: 100,
    deadlineMs: 9_999_999,
    presetOverrides: { A: preset({ referenceTimeoutMs: 250000, deadlineMs: 2_000_000 }) },
  })
  assert.equal(config.referenceTimeoutMs, 1000, 'a per-reference timeout below one second clamps up')
  assert.equal(config.deadlineMs, 1800000, 'a whole-round deadline above thirty minutes clamps down')
  const entry = buildPresetTable(config).get('A')
  assert.equal(entry.referenceTimeoutMs, 250000)
  assert.equal(entry.deadlineMs, 1800000)
  assert.equal(entry.fanout, 'user_turn')

  const defaults = buildPresetTable(normalizeConfig({ presetOverrides: { B: preset() } })).get('B')
  assert.equal(defaults.referenceTimeoutMs, 600000)
  assert.equal(defaults.deadlineMs, 900000)

  const referenceEntry = normalizePresetOverrides({ A: preset({ references: [{ provider: 'fake', model: 'fake/r', timeoutMs: 5 }] }) }).A.references[0]
  assert.equal(referenceEntry.timeoutMs, 1000, 'a reference-level timeout obeys the same lower bound')
})

test('the end-of-turn review has its own short budget, clamped to 1000..120000ms', () => {
  assert.equal(DEFAULT_CONFIG.reviewTimeoutMs, 60000, 'reviewing is a bounded add-on, not another full fan-out')
  assert.equal(normalizeConfig({}).reviewTimeoutMs, 60000)
  assert.equal(normalizeConfig(Config({})).reviewTimeoutMs, 60000, 'the schema exposes the review budget')
  assert.equal(normalizeConfig({ reviewTimeoutMs: 5 }).reviewTimeoutMs, 1000, 'a sub-second review budget clamps up')
  assert.equal(normalizeConfig({ reviewTimeoutMs: 9_999_999 }).reviewTimeoutMs, 120000, 'a fifteen-minute review budget clamps down')
  assert.equal(normalizeConfig({ reviewTimeoutMs: 45000 }).reviewTimeoutMs, 45000)
  const unchanged = normalizeConfig({ reviewTimeoutMs: 45000 })
  assert.deepEqual(normalizeConfig(unchanged), unchanged, 'the review budget is part of the idempotent config surface')
})

// ---------------------------------------------------------------------------
// 5. empty tables and route validity
// ---------------------------------------------------------------------------

test('a zero-reference preset is legal and is not replaced with a recipe', () => {
  const config = normalizeConfig({ presetOverrides: { empty: preset({ references: [] }) } })
  const empty = buildPresetTable(config).get('empty')
  assert.ok(empty, 'an aggregator-only preset is still a valid routing target')
  assert.deepEqual(empty.references, [], 'zero references pass through unchanged')
  assert.equal(config.presetOverrides.empty.references.length, 0)
  assert.equal(normalizePresetOverrides({ empty: preset({ references: 'nope' }) }).empty.references, undefined)
})

test('invalid or disabled references stay stored but cannot enter the routing table', () => {
  const overrides = {
    badAggregator: preset({ aggregator: { provider: '', model: 'fake/aggregator' } }),
    moaAggregator: preset({ aggregator: { provider: 'moa', model: 'fake/aggregator' } }),
    mixed: preset({
      references: [
        { provider: 'moa', model: 'fake/r', id: 'nested-moa' },
        { provider: 'fake', model: 'fake/r', id: 'off', enabled: false },
        { provider: 'fake', model: '', id: 'no-model' },
        { provider: 'fake', model: 'fake/r', id: 'ok' },
      ],
    }),
  }
  const config = normalizeConfig({ presetOverrides: overrides })
  const table = buildPresetTable(config)
  assert.deepEqual([...table.keys()], ['mixed'])
  assert.deepEqual(table.get('mixed').references.map(reference => reference.id), ['ok'])
  assert.deepEqual(
    config.presetOverrides.mixed.references.map(reference => reference.id),
    ['nested-moa', 'off', 'no-model', 'ok'],
    'disable or invalid routes must not delete the stored record',
  )
  assert.equal(config.presetOverrides.mixed.references[1].enabled, false)
  assert.equal(config.presetOverrides.badAggregator.aggregator.provider, undefined)
  assert.equal(config.presetOverrides.moaAggregator.aggregator.provider, 'moa', 'a moa aggregator is stored but unrouteable')
})

test('reference.sessionPolicy keeps only the exact stable or rotate literals through the production preset path', () => {
  // index.js routes with buildPresetTable(normalizeConfig(rawConfig)); an absent key means automatic.
  const cases = [
    ['ref-stable', 'stable'], ['ref-rotate', 'rotate'], ['ref-auto', 'auto'], ['ref-upper', 'STABLE'],
    ['ref-padded', ' stable'], ['ref-empty', ''], ['ref-number', 1], ['ref-null', null],
    ['ref-object', { policy: 'stable' }], ['ref-undefined', undefined],
  ]
  const references = cases.map(([id, sessionPolicy]) => ({ provider: 'fake', model: 'fake/r', id, sessionPolicy }))
  references.push({ provider: 'fake', model: 'fake/r', id: 'ref-absent' })
  const input = { presetOverrides: { pol: preset({ references }) } }
  const snapshot = structuredClone(input)
  const config = normalizeConfig(input)
  const table = buildPresetTable(config)
  assert.deepEqual(SESSION_POLICIES, new Set(['stable', 'rotate']))
  const kept = { 'ref-stable': 'stable', 'ref-rotate': 'rotate' }
  for (const [where, list] of [
    ['stored', config.presetOverrides.pol.references],
    ['routed', table.get('pol').references],
  ]) {
    assert.deepEqual(list.map(reference => reference.id), [...cases.map(([id]) => id), 'ref-absent'], `${where} keeps every reference`)
    for (const reference of list) {
      if (kept[reference.id]) assert.equal(reference.sessionPolicy, kept[reference.id], `${where} ${reference.id}`)
      else assert.equal(Object.hasOwn(reference, 'sessionPolicy'), false, `${where} ${reference.id} drops an unknown policy`)
    }
  }
  assert.deepEqual(normalizeConfig(config), config, 'normalization stays idempotent with a session policy')
  assert.deepEqual(input, snapshot, 'normalization never mutates the raw preset')
})

// ---------------------------------------------------------------------------
// 6. normalization hygiene
// ---------------------------------------------------------------------------

test('volatile schema values are unwrapped and normalization never mutates its input', () => {
  const input = {
    enabled: false,
    referenceTimeoutMs: 1234,
    disabledPresets: ['A', 'A', 'ghost'],
    presetOverrides: { A: preset({ label: 'A' }) },
  }
  const snapshot = JSON.parse(JSON.stringify(input))
  const config = normalizeConfig(input)
  assert.equal(config.enabled, false)
  assert.equal(config.referenceTimeoutMs, 1234)
  assert.deepEqual(config.disabledPresets, ['A'])
  assert.deepEqual(input, snapshot, 'normalizeConfig must not mutate the caller-owned config')

  // Settings Remote exposes volatile fields as { get(), [cosmokit.volatile.write] }.
  const wrapped = {
    get: () => ({ enabled: false, referenceTimeoutMs: 4321 }),
    [Symbol.for('cosmokit.volatile.write')]: () => {},
  }
  const unwrapped = normalizeConfig(wrapped)
  assert.equal(unwrapped.enabled, false, 'a volatile wrapper must be read through get()')
  assert.equal(unwrapped.referenceTimeoutMs, 4321)
})

test('normalization is idempotent for a full user-owned table', () => {
  const once = normalizeConfig({
    referenceSchedule: 'serial',
    presetOverrides: { A: preset({ label: 'A', fanout: 'every_n:1', references: [{ provider: 'fake', model: 'fake/r' }] }) },
  })
  const twice = normalizeConfig(once)
  assert.deepEqual(twice, once)
})

test('all smart presets share one global judge; legacy migration happens once', () => {
  const legacy = {
    defaultPreset: 'B',
    presetOverrides: {
      A: preset({ fanout: 'smart', scheduler: { kind: 'jev', minGap: 3 } }),
      B: preset({ fanout: 'smart', scheduler: { kind: 'model', provider: 'p', model: 'judge', minGap: 5 } }),
    },
  }
  const migrated = normalizeConfig(legacy)
  assert.equal(migrated.scheduler.minGap, 5)
  assert.equal(migrated.scheduler.model, 'judge')
  for (const item of buildPresetTable(migrated).values()) assert.deepEqual(item.scheduler, migrated.scheduler)
  const explicit = normalizeConfig({ ...legacy, scheduler: { kind: 'decisions', minGap: 2, openaiApiKeyEnv: 'SHARED_KEY' } })
  for (const item of buildPresetTable(explicit).values()) {
    assert.equal(item.scheduler.kind, 'decisions')
    assert.equal(item.scheduler.minGap, 2)
    assert.equal(item.scheduler.openaiApiKeyEnv, 'SHARED_KEY')
  }
  assert.deepEqual(normalizeConfig(explicit), explicit)
  const table = buildPresetTable(explicit)
  table.get('A').scheduler.kind = 'jev'
  assert.equal(table.get('B').scheduler.kind, 'decisions', 'individual runtime copies cannot mutate the shared configuration')
  assert.equal(explicit.scheduler.kind, 'decisions')
})

test('decision is optional by default and every public kind round-trips without secrets', () => {
  assert.deepEqual(normalizeConfig({}).decision, {
    kind: 'none', threshold: 0.6, minGap: 2, maxGap: 12, timeoutMs: 20000, stateChars: 128000,
  })
  const cases = [
    { kind: 'dsh-model', provider: 'fake', model: 'fake/judge', reasoningEffort: 'low' },
    { kind: 'openai-compatible', baseURL: 'https://models.example/v1', api: 'openai-responses', credentialRef: 'TEST_KEY', model: 'fake/judge' },
    { kind: 'jev', credentialRef: 'TEST_KEY', model: 'jev-test', baseURL: 'https://models.example/jev' },
    { kind: 'openai-decisions', credentialRef: 'TEST_KEY', model: 'fake/decision', cacheMode: 'implicit' },
  ]
  for (const decision of cases) {
    const config = normalizeConfig({ decision: { ...decision, apiKey: 'not-a-real-test-key', threshold: 0.6 } })
    assert.equal(config.decision.kind, decision.kind)
    assert.equal(config.decision.apiKey, undefined)
    for (const [key, value] of Object.entries(decision)) assert.equal(config.decision[key], value)
    assert.deepEqual(normalizeConfig(config), config)
  }
})

test('decision takes precedence while legacy scheduler kinds and credential names migrate once', () => {
  const legacy = normalizeConfig({ scheduler: {
    kind: 'openai', openaiApiKeyEnv: 'LEGACY_TEST_KEY', model: 'legacy-judge',
    baseURL: 'https://models.example/v1', minGap: 9, maxGap: 2, timeoutMs: 5,
  } })
  assert.equal(legacy.decision.kind, 'openai-compatible')
  assert.equal(legacy.decision.credentialRef, 'LEGACY_TEST_KEY')
  assert.equal(legacy.decision.model, 'legacy-judge')
  assert.equal(legacy.decision.minGap, 9)
  assert.equal(legacy.decision.maxGap, 9)
  assert.equal(legacy.decision.timeoutMs, 1000)
  const explicit = normalizeConfig({ ...legacy, decision: { kind: 'none', minGap: 2, maxGap: 20 } })
  assert.equal(explicit.decision.kind, 'none')
  assert.equal(explicit.decision.maxGap, 20)
  assert.equal(explicit.scheduler.kind, 'none', 'runtime adapter remains available to preset.scheduler')
  assert.deepEqual(normalizeConfig(explicit), explicit)
})

test('buildPresetTable re-normalizes and copies, so later edits cannot corrupt routing', () => {
  const config = normalizeConfig({ presetOverrides: { A: preset({ label: '', fanout: 'BOGUS', referenceMaxTokens: 512.9 }) } })
  const table = buildPresetTable(config)
  const entry = table.get('A')
  assert.equal(entry.label, 'A', 'a blank label falls back to the preset id')
  assert.equal(entry.fanout, 'user_turn')
  assert.equal(entry.referenceMaxTokens, 512, 'token budgets are floored to whole tokens')

  entry.references.push({ provider: 'fake', model: 'fake/extra', id: 'extra' })
  assert.equal(config.presetOverrides.A.references.length, 1, 'the table must not alias the stored references array')
  assert.notEqual(buildPresetTable(config).get('A').references, entry.references)

  const raw = { presetOverrides: { B: preset() }, referenceTimeoutMs: 900000 }
  const first = buildPresetTable(normalizeConfig(raw))
  raw.presetOverrides.B.references[0].model = 'fake/changed'
  assert.equal(first.get('B').references[0].model, 'fake/ref', 'the table must be a snapshot, not a live view of caller objects')
})