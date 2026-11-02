import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'
import { SESSION_POLICIES } from '../config.js'
import { loadMoaClientModule } from '../settings-panel.js'

const here = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT = resolve(here, 'ui-locale.json')
const REFRESH = resolve(here, 'refresh-ui-locale.mjs')

test('sync-client publishes changed artifacts through the host rebuild hook', async () => {
  const tools = new Map(), disposers = [], calls = []
  let rev = 'old'
  const modules = {
    pkgMeta: new Map(), sources: new Map(), dirty: new Set(), table: new Map(),
    graph: () => ({ rev, entries: [{ id: 'dsh-better-moa' }] }),
    clientPath: () => '/fixture/client.js',
    flush() { calls.push('flush') },
    rebuilt(id) { calls.push(id); rev = 'new' },
  }
  const ctx = {
    llm: { registerAdapter: () => () => {}, stream() { throw new Error('unexpected model call') } },
    effect(fn) { const off = fn(); if (off) disposers.push(off) }, inject() {}, on() {},
    loader: { *entries() { yield { options: { name: 'file:///fixture/dsh-better-moa/index.js' } } } },
    get(key) {
      if (key === 'clientModules') return modules
      if (key === 'tools') return { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } }
    },
  }
  apply(ctx, { presetOverrides: {} })
  try {
    const value = await tools.get('moa_status').execute({ action: 'sync-client' })
    assert.deepEqual(calls, ['flush', 'dsh-better-moa'])
    assert.equal(value.clientSync.graphRev, 'new')
    assert.equal(value.clientSync.ok, true)
  } finally { for (const off of disposers.reverse()) await off() }
})

test('public status exposes the live QA budget and smart or inactive scheduler without generation', async () => {
  const disposers = []
  const tools = new Map()
  let generated = 0
  const ctx = {
    llm: {
      registerAdapter() { return () => {} },
      stream() { generated += 1; throw new Error('status must never generate') },
    },
    effect(callback) { const disposer = callback(); if (disposer) disposers.push(disposer) },
    inject() {}, on() {},
    get(key) { if (key === 'tools') return { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } },
  }
  const raw = {
    presetOverrides: {
      smart: {
        label: 'Smart', fanout: 'smart', aggregator: { provider: 'fake', model: 'actor' }, references: [],
        scheduler: {
          kind: 'jev', apiKeyEnv: 'MOA_TEST_SCHEDULER_KEY', jevModel: 'jev-test',
          threshold: 0.75, minGap: 3, maxGap: 17, timeoutMs: 14000,
          apiKey: 'not-a-real-test-key',
        },
      },
      inactive: {
        label: 'Inactive', fanout: 'user_turn_end', aggregator: { provider: 'fake', model: 'actor' }, references: [],
        scheduler: {
          kind: 'model', provider: 'fake', model: 'judge', reasoningEffort: 'low',
          threshold: 0.8, minGap: 4, maxGap: 20, timeoutMs: 18000,
        },
      },
    },
  }
  apply(ctx, raw)
  const status = () => tools.get('moa_status').execute({ action: 'inspect' })
  try {
    for (const [budget, expected] of [[undefined, 60000], [5, 1000], [9_999_999, 120000], [45000, 45000]]) {
      raw.reviewTimeoutMs = budget
      const value = await status()
      assert.equal(value.config.reviewTimeoutMs, expected)
      const smart = value.presets.find(preset => preset.id === 'smart')
      assert.equal(smart.fanout, 'smart')
      assert.deepEqual(smart.scheduler, {
        kind: 'jev', apiKeyEnv: 'MOA_TEST_SCHEDULER_KEY', jevModel: 'jev-test',
        jevBaseURL: 'https://api.typesafe.ai/v1/systemone',
        openaiApiKeyEnv: 'MOA_OPENAI_API_KEY', openaiModel: 'gpt-6-luna',
        openaiBaseURL: 'https://api.openai.com/v1', openaiCacheMode: 'explicit',
        threshold: 0.75, minGap: 3, maxGap: 17, timeoutMs: 14000, stateChars: 128000,
      })
      assert.deepEqual(value.config.scheduler, smart.scheduler)
      const inactive = value.presets.find(preset => preset.id === 'inactive')
      assert.equal(inactive.fanout, 'user_turn_end')
      assert.deepEqual(inactive.scheduler, smart.scheduler, 'all cadences expose the same global judge')
      assert.equal(JSON.stringify(value).includes('not-a-real-test-key'), false)
    }
    raw.presetOverrides.smart.scheduler.minGap = 5
    assert.equal((await status()).presets.find(preset => preset.id === 'smart').scheduler.minGap, 5)
    assert.equal(generated, 0)
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
  }
})

test('live user preset table updates the model catalog and default, including deletion to empty', async () => {
  const disposers = []
  const tools = new Map()
  let adapter
  const runtime = {
    registerAdapter(_ids, value) { adapter = value; return () => {} },
    async resolveModelInfo(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'] } },
    stream() { throw new Error('this configuration test must never generate') },
  }
  const ctx = {
    llm: runtime,
    effect(callback) { const disposer = callback(); if (disposer) disposers.push(disposer) },
    inject() {}, on() {},
    get(key) { if (key === 'tools') return { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } },
  }
  const raw = { presetOverrides: {}, defaultPreset: '' }
  apply(ctx, raw)
  const status = () => tools.get('moa_status').execute({ action: 'inspect' })
  try {
    assert.deepEqual(await adapter.listModels('moa'), [])
    assert.equal((await status()).defaultPreset, '')
    raw.presetOverrides = { user_choice: { label: 'My choice', aggregator: { provider: 'fake', model: 'actor' }, references: [] } }
    assert.deepEqual((await adapter.listModels('moa')).map(model => model.id), ['user_choice'])
    assert.equal((await status()).defaultPreset, 'user_choice')
    raw.presetOverrides = { renamed_choice: { label: 'Second', aggregator: { provider: 'fake', model: 'actor-2' }, references: [] } }
    assert.deepEqual((await adapter.listModels('moa')).map(model => model.id), ['renamed_choice'])
    assert.equal((await status()).defaultPreset, 'renamed_choice')
    } finally {
    for (const dispose of disposers.reverse()) await dispose()
  }
})

/* ------------------------------------------------- ui-locale.json snapshot */

const reactDouble = {
  createElement() { return {} },
  useState() { return [undefined, () => {}] },
  useEffect() {},
  useId() { return 'snapshot' },
}

function snapshotValue(text) {
  return JSON.parse(text)
}

function snapshotText(namespace, locales) {
  return `${JSON.stringify({ namespace, locales }, null, 2)}\n`
}

/** Run the shipping refresh script against explicit files; stdout only, still offline. */
function runRefresh({ clientPath, snapshotPath }) {
  const output = execFileSync(process.execPath, [REFRESH], {
    encoding: 'utf8',
    env: { ...process.env, MOA_CLIENT_PATH: clientPath, MOA_LOCALE_SNAPSHOT: snapshotPath },
  })
  return { output, text: readFileSync(snapshotPath, 'utf8') }
}

test('the ui-locale snapshot is the shipped client table, not an empty file', async () => {
  const { exports: client } = await loadMoaClientModule(reactDouble)
  const raw = readFileSync(SNAPSHOT, 'utf8')

  // The round-2 defect wrote "{}"; a 3-byte placeholder must fail loudly.
  assert.notEqual(raw.trim(), '{}', 'ui-locale.json must carry the client table, not an empty object')
  assert.ok(raw.length > 1000, `ui-locale.json looks truncated (${raw.length} bytes)`)
  const snapshot = snapshotValue(raw)
  assert.equal(snapshot.namespace, client.NS)
  assert.equal(snapshot.namespace, 'moa.settings')

  const zh = Object.keys(snapshot.locales.zh)
  const en = Object.keys(snapshot.locales.en)
  assert.ok(zh.length > 100, 'zh locale table is complete')
  assert.deepEqual([...zh].sort(), [...en].sort(), 'both locales carry the same keys')
  assert.deepEqual(zh, Object.keys(client.LOCALES.zh), 'snapshot zh order matches client.js')
  assert.deepEqual(en, Object.keys(client.LOCALES.en), 'snapshot en order matches client.js')
  for (const code of ['zh', 'en']) {
    for (const [key, value] of Object.entries(snapshot.locales[code])) {
      assert.equal(value, client.LOCALES[code][key], `${code}.${key} matches client.js`)
      assert.equal(typeof value, 'string', `${code}.${key} is text`)
      assert.notEqual(value.trim(), '', `${code}.${key} is not empty`)
    }
  }

  // The reference session cache policy ships in both languages.
  for (const code of ['zh', 'en']) {
    for (const key of ['sessionPolicy', 'sessionPolicy_auto', 'sessionPolicy_stable', 'sessionPolicy_rotate', 'sessionPolicyHint']) {
      assert.ok(Object.hasOwn(snapshot.locales[code], key), `${code}.${key} is in the snapshot`)
    }
  }
  assert.equal(snapshot.locales.en.sessionPolicy, 'Session cache policy')
  assert.equal(snapshot.locales.zh.sessionPolicy, '会话缓存策略')

  // Every stored sessionPolicy literal the Host accepts has copy for it.
  for (const literal of SESSION_POLICIES) {
    assert.ok(Object.hasOwn(snapshot.locales.zh, `sessionPolicy_${literal}`), `zh copy for ${literal}`)
    assert.ok(Object.hasOwn(snapshot.locales.en, `sessionPolicy_${literal}`), `en copy for ${literal}`)
  }

  // Byte equality with what a regeneration would write: wording edits must refresh the file.
  assert.equal(raw, snapshotText(client.NS, client.LOCALES))
  assert.equal(raw, snapshotText(snapshot.namespace, snapshot.locales), 'snapshot is canonical JSON')
})

test('the refresh script reproduces the committed snapshot, is idempotent, and detects drift', async () => {
  const { source } = await loadMoaClientModule(reactDouble)
  const committed = readFileSync(SNAPSHOT, 'utf8')
  const clientPath = resolve(here, '../client.js')
  const dir = mkdtempSync(join(tmpdir(), 'moa-locale-'))
  try {
    // 1. Starting from the old "{}" placeholder the script must rebuild the table.
    const placeholder = join(dir, 'placeholder.json')
    writeFileSync(placeholder, '{}\n', 'utf8')
    const first = runRefresh({ clientPath, snapshotPath: placeholder })
    assert.match(first.output, /^Updated the diagnostic locale snapshot/)
    assert.equal(first.text, committed, 'regenerated snapshot equals the committed file byte for byte')

    // 2. A second run reports no change and does not rewrite.
    const second = runRefresh({ clientPath, snapshotPath: placeholder })
    assert.match(second.output, /^Diagnostic locale snapshot already matches the client/)
    assert.equal(second.text, committed)

    // 3. A missing snapshot is created rather than aborting the script.
    const missing = join(dir, 'missing.json')
    const third = runRefresh({ clientPath, snapshotPath: missing })
    assert.match(third.output, /^Updated the diagnostic locale snapshot/)
    assert.equal(third.text, committed)

    // 4. Drift detection: change one zh string in a copy of client.js. The script
    //    must rewrite the copy (this is the extraction proof, not a skip).
    const driftedClient = join(dir, 'client.js')
    const marker = '会话缓存策略（漂移测试）'
    const driftedSource = source.replace("sessionPolicy: '会话缓存策略'", `sessionPolicy: '${marker}'`)
    assert.notEqual(driftedSource, source, 'drift fixture must actually change client.js')
    writeFileSync(driftedClient, driftedSource, 'utf8')
    const driftedSnapshot = join(dir, 'drifted.json')
    copyFileSync(SNAPSHOT, driftedSnapshot)
    const fourth = runRefresh({ clientPath: driftedClient, snapshotPath: driftedSnapshot })
    assert.match(fourth.output, /^Updated the diagnostic locale snapshot/)
    assert.equal(snapshotValue(fourth.text).locales.zh.sessionPolicy, marker)
    // Only the probe copy changed; the committed snapshot is untouched.
    assert.equal(readFileSync(SNAPSHOT, 'utf8'), committed)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
