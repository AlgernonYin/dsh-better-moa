/*
 * Offline product tests for the Better MoA settings section.
 *
 * These tests evaluate the real client.js with a minimal React/ModuleLoader
 * double. They cover the settings contract, the user-owned preset table, the
 * provider/model catalog pickers, the bounded save + revision ACK machinery and
 * negative cases. They are not a browser render, accessibility or live-Host
 * verification.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadMoaClientModule } from '../settings-panel.js'

/*
 * Element double that keeps the parts of React's element model the panel uses
 * (nested elements, arrays, and scalar text children) and expands function
 * components exactly like React does: `type(props)`. Unlike a purely structural
 * stub it refuses a plain object used as a child, because React throws error
 * #31 ("Objects are not valid as a React child") for that. materialize() below
 * raises the same class of failure offline, so a mistyped `h(Component, child)`
 * call fails here instead of only in the real browser.
 */
function createRenderingReact() {
  let id = 0
  return {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      return {
        type,
        props: { ...(props || {}), ...(children.length ? { children: children.flat(Infinity) } : {}) },
      }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useId() {
      id += 1
      return `test-${id}`
    },
  }
}

const React = createRenderingReact()
const loaded = await loadMoaClientModule(React)
const client = loaded.exports
const pure = client.__test
const zh = (key) => client.LOCALES.zh[key] || key
const en = (key) => client.LOCALES.en[key] || key

/* ------------------------------------------------------------------ fixtures */

const CATALOG = {
  ok: true,
  value: {
    groups: [
      {
        id: 'magpie', name: 'Magpie',
        models: [
          {
            id: 'bailian/deepseek-v4.1-flash-1017', name: 'DeepSeek Flash',
            reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] },
          },
          {
            id: 'bailian/kimi-k3', name: 'Kimi K3',
            reasoning: { efforts: [{ id: 'high', name: 'High' }] },
          },
          // Known model, but the catalog publishes no reasoning efforts.
          { id: 'bailian/plain-model', name: 'Plain Model' },
        ],
      },
      {
        id: 'magpie-anthropic', name: 'Anthropic',
        models: [{ id: 'claude-opus', name: 'Claude Opus', reasoning: { efforts: [{ id: 'max', name: 'Max' }] } }],
      },
      // The MoA virtual group must never be offered as an advisor.
      { id: 'moa', name: 'MoA', models: [{ id: 'easyCN', name: 'EasyCN' }] },
    ],
    failures: [],
  },
}

// Local "ready" catalog view, independent of the React harness above.
const READY_CATALOG = { status: 'ready', groups: CATALOG.value.groups }

/** Host document as migrated on this machine: a complete user-owned table. */
function baseValue() {
  return {
    enabled: true,
    defaultPreset: 'easyCN',
    disabledPresets: [],
    presetOverrides: {
      easyCN: {
        id: 'easyCN',
        label: 'MoA EasyCN',
        description: '默认档',
        hermesSource: 'hermes',
        guidanceHeader: 'HEADER',
        guidanceInstruction: 'INSTRUCTION',
        referenceMaxTokens: 4096,
        fanout: 'every_n:10',
        aggregator: { provider: 'magpie', model: 'bailian/deepseek-v4.1-flash-1017', reasoningEffort: 'high' },
        references: [{
          id: 'kimi-k3', label: 'Kimi K3', provider: 'magpie', model: 'bailian/kimi-k3',
          reasoningEffort: 'high', maxTokens: 4096, enabled: true, async: false,
          timeoutMs: 600000, cacheScope: 'scope-a',
        }],
      },
    },
    persistentTags: ['*'],
    referenceTimeoutMs: 600000,
    deadlineMs: 900000,
    reviewTimeoutMs: 45000,
    guardEnabled: true,
    // Knobs the panel no longer renders but the Host document still carries.
    adviceHistory: 'latest',
    referenceSchedule: 'serial',
    maxConcurrency: 2,
    queueBudgetMs: 0,
  }
}

function mergeValue(base, patch) {
  return { ...base, ...patch }
}

/* -------------------------------------------------------------- tree helpers */

function childrenOf(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  const children = node.props?.children
  return Array.isArray(children) ? children : children === undefined ? [] : [children]
}

function isElement(node) {
  return Boolean(node) && typeof node === 'object' && !Array.isArray(node)
    && Object.prototype.hasOwnProperty.call(node, 'type')
    && (typeof node.type === 'string' || typeof node.type === 'function' || typeof node.type === 'symbol')
}

function invalidChild(node) {
  const keys = Object.keys(node)
  const error = new Error(
    `React would reject this child (error #31): object with keys {${keys.join(', ')}}`,
  )
  error.code = 'react/invalid-child'
  return error
}

function materialize(node) {
  if (Array.isArray(node)) return node.map(materialize)
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (!isElement(node)) throw invalidChild(node)
  const props = node.props || {}
  // React renders a component by calling it with one props object and renders
  // a fragment by splicing its children; both are followed here so a component
  // invoked with positional children is caught when it returns an object child.
  if (typeof node.type === 'function') return materialize(node.type(props))
  if (typeof node.type === 'symbol') return materialize(childrenOf({ props }))
  return { ...node, props: { ...props, children: childrenOf({ props }).map(materialize) } }
}

function findAll(node, predicate, output = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, output)
    return output
  }
  if (!node || typeof node !== 'object') return output
  if (predicate(node)) output.push(node)
  for (const child of childrenOf(node)) findAll(child, predicate, output)
  return output
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return childrenOf(node).map(textOf).join('')
}

function byData(node, name, value = true) {
  return findAll(node, (entry) => entry.props?.[name] === value)
}

function optionsOf(node) {
  return findAll(node, (entry) => entry.type === 'option').map((entry) => entry.props.value)
}

function renderSection(store, overrides = {}) {
  const element = client.MoaSettingsSection({
    useMoaSettings: (selector) => {
      assert.equal(typeof selector, 'function', 'slot snapshot hooks require a selector')
      return selector(store.getSnapshot())
    },
    store,
    t: zh,
    reload: () => store.reload(),
    save: () => store.flushAutosave(),
    loadCatalog: () => store.loadCatalog(),
    ...overrides,
  })
  return materialize(element)
}

/* ------------------------------------------------------------------ harness */

function createHarness(options = {}) {
  const listeners = new Set()
  const calls = { update: [], mutate: [], catalog: 0, load: 0 }
  let current = {
    status: options.status || 'ready',
    value: options.value === undefined ? {} : options.value,
    base: options.value === undefined ? {} : options.value,
    user: options.value === undefined ? {} : options.value,
    revision: options.revision ?? 7,
    writable: options.writable !== false,
  }

  function updateScope(patch) {
    if (!patch || typeof patch !== 'object') return
    if (Object.hasOwn(patch, 'value')) {
      const value = patch.value
      current = {
        ...current,
        value,
        base: Object.hasOwn(patch, 'base') ? patch.base : value,
        user: Object.hasOwn(patch, 'user') ? patch.user : value,
        revision: Object.hasOwn(patch, 'revision') ? patch.revision : current.revision,
        ...(patch.status ? { status: patch.status } : {}),
        ...(Object.hasOwn(patch, 'writable') ? { writable: patch.writable } : {}),
      }
    } else {
      current = { ...current, ...patch }
    }
    for (const listener of listeners) listener()
  }

  function notify() {
    for (const listener of listeners) listener()
  }

  const scope = {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async mutate(operations, revision) {
      calls.mutate.push({ namespace: client.SETTINGS_NS, operations, revision })
      const patch = Object.fromEntries(operations.map((operation) => {
        assert.equal(operation.op, 'set')
        assert.equal(operation.path.length, 1)
        return [operation.path[0], operation.value]
      }))
      if (options.onUpdate) {
        const result = await options.onUpdate({ patch, revision, current, updateScope, calls })
        if (result?.ok === false) throw Object.assign(new Error(result.error?.message || 'settings rejected'), result.error || result)
        if (result?.value?.value) updateScope(result.value)
        return result
      }
      const value = { ...current.value, ...patch }
      updateScope({ value, base: value, user: value, revision: current.revision + 1 })
      return { ok: true, value: { ns: client.SETTINGS_NS, value, base: value, user: value, revision: current.revision } }
    },
  }

  const describe = {
    acceptView: (view) => updateScope(view),
    async load() {
      calls.load += 1
      if (options.onLoad) return options.onLoad({ updateScope, scope, calls })
      notify()
      return undefined
    },
  }

  const ctx = {
    configForms: {
      get(namespace) {
        assert.equal(namespace, client.SETTINGS_NS)
        return scope
      },
      describe: () => describe,
    },
    remote: {
      credentials: {
        async describe(ref) { return { ok: true, value: { ref, configured: false } } },
        async set(ref, value) { calls.credentials = [...(calls.credentials || []), { ref, value }]; return { ok: true } },
      },
      llm: {
        async discoverModels(namespace, request) { calls.discover = [...(calls.discover || []), { namespace, request }]; return { ok: true, value: { groups: [] } } },
      },
      settings: {
        mutate(namespace, operations, revision) {
          assert.equal(namespace, client.SETTINGS_NS)
          calls.mutate.push({ namespace, operations, revision })
          const patch = Object.fromEntries(operations.map((operation) => {
            assert.equal(operation.op, 'set')
            assert.equal(operation.path.length, 1)
            return [operation.path[0], operation.value]
          }))
          if (options.onUpdate) return options.onUpdate({ patch, revision, current, updateScope, calls })
          const value = { ...current.value }
          for (const operation of operations) value[operation.path[0]] = operation.value
          return Promise.resolve({
            ok: true,
            value: { ns: namespace, value, base: value, user: value, revision: current.revision + 1 },
          })
        },
      },
      session: {
        async modelCatalog() {
          calls.catalog += 1
          if (options.onCatalog) return options.onCatalog()
          return CATALOG
        },
      },
    },
  }

  return { ctx, scope, calls, describe, updateScope, notify, current: () => current }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function withLiveStore(value, run, harnessOptions = {}) {
  const harness = createHarness({ value, revision: 12, ...harnessOptions })
  const store = new client.MoaSettingsStore(harness.ctx)
  try {
    await store.loadCatalog()
    await run(store, harness)
  } finally {
    store.dispose()
  }
}

/* ------------------------------------------------------------- module shape */

test('module stays self-contained and registers settings plus an independent advice node', async () => {
  assert.deepEqual(loaded.required, ['react'])
  assert.equal(loaded.registration.id, 'dsh-better-moa')
  assert.equal(loaded.registration.factory.length, 1)
  assert.equal(client.NS, 'moa.settings')
  assert.equal(client.SETTINGS_NS, 'better-moa')
  assert.deepEqual(client.inject, ['slots', 'locale', 'remote', 'remote.llm', 'remote.credentials', 'remote.session', 'configForms'])

  let registered
  let adviceSlot
  const registeredNodes = []
  const dictionaries = []
  const disposers = []
  const hostEvents = new Map()
  const harness = createHarness({ value: {}, revision: 7 })
  const ctx = {
    ...harness.ctx,
    locale: {
      bind: (namespace) => (key) => `${namespace}/${key}`,
      register: (namespace, dictionary) => {
        dictionaries.push({ namespace, dictionary })
        return () => {}
      },
    },
    effect(fn) {
      const value = fn()
      const dispose = typeof value === 'function' ? value : () => {}
      disposers.push(dispose)
      return dispose
    },
    remote: {
      ...harness.ctx.remote,
      $on(event, callback) { hostEvents.set(event, callback); return () => hostEvents.delete(event) },
    },
    on(event, callback) { hostEvents.set(`ctx:${event}`, callback); return () => hostEvents.delete(`ctx:${event}`) },
    get(name) {
      if (name === 'uiConversation') return {
        events: {
          register(definition) {
            registeredNodes.push(definition)
            return () => {}
          },
        },
      }
      if (name === 'slots') return this.slots
      return undefined
    },
    slots: {
      inject(name, callback) {
        assert.ok(['settings.section', 'conversation.chat.node'].includes(name))
        callback()
        return () => {}
      },
      register(descriptor, component) {
        if (descriptor.name === 'settings.section') registered = { descriptor, component }
        else adviceSlot = { descriptor, component }
        return () => {}
      },
    },
  }
  client.apply(ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(registered, 'settings.section must be registered')
  assert.equal(registered.descriptor.name, 'settings.section')
  assert.equal(registered.descriptor.id, 'moa')
  assert.equal(registered.descriptor.order, 35)
  assert.equal(registered.descriptor.locale, client.NS)
  assert.equal(registered.component, client.MoaSettingsSection)
  assert.equal(registeredNodes.length, 1)
  assert.equal(registeredNodes[0].kind, 'moa-advice')
  assert.notEqual(registeredNodes[0].exclusive, true)
  assert.equal(adviceSlot.descriptor.name, 'conversation.chat.node')
  assert.equal(adviceSlot.descriptor.key, 'moa-advice')
  assert.equal(typeof adviceSlot.component, 'function')
  const card = adviceSlot.component({ node: { key: 'moa-advice:test', anchorSeq: 3,
    data: { text: 'VISIBLE-ADVICE', preset: 'parallel', replacement: null } } })
  assert.equal(card.type, 'article')
  assert.equal(card.props['data-moa-advice'], 'parallel')
  assert.equal(findAll(card, node => node.type === 'pre').length, 0)
  assert.equal(findAll(card, node => node.type === 'button')[0].props['aria-expanded'], false)
  assert.doesNotMatch(textOf(card), /VISIBLE-ADVICE/)
  const face = registered.descriptor.inject()
  assert.ok(face.hooks.moaSettings instanceof client.MoaSettingsStore)
  assert.equal(typeof face.hooks.moaSettings.flushAutosave, 'function')
  assert.equal(typeof face.loadCatalog, 'function')
  assert.deepEqual(dictionaries.map((entry) => entry.namespace), [client.NS])
  const catalogEvents = ['llm/adapters-updated', 'settings/document-updated',
    'credentials/record-updated', 'credentials/reference-updated', 'ctx:connection/reset']
  for (const event of catalogEvents) {
    assert.equal(typeof hostEvents.get(event), 'function', `${event} must refresh the catalog automatically`)
    hostEvents.get(event)()
  }
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.calls.catalog, catalogEvents.length)
  for (const dispose of disposers) dispose()
})

/* ------------------------------------------------------------- draft shape */

test('empty configuration has no hidden built-in preset table', () => {
  const draft = pure.draftFromValue({})
  assert.deepEqual(draft.presets, [])
  assert.equal(draft.defaultPreset, '')
  assert.equal(draft.enabled, true)
  assert.equal(draft.guardEnabled, true)
  assert.equal(draft.persistentTags, null)
  assert.equal(draft.referenceTimeoutMs, '')
  assert.equal(draft.deadlineMs, '')

  // A table with one arbitrary id never gets expanded with the old seven.
  const custom = pure.draftFromValue({ presetOverrides: { 'my-preset': { label: 'Mine' } } })
  assert.deepEqual(custom.presets.map((preset) => preset.id), ['my-preset'])
  assert.equal(custom.presets[0].label, 'Mine')

  const source = loaded.source
  assert.equal(/DEFAULT_PRESETS/.test(source), false)
  assert.equal(/PRESET_ORDER/.test(source), false)
})

test('reads the user-owned table and keeps unknown advanced fields', () => {
  const draft = pure.draftFromValue(baseValue())
  assert.equal(draft.presets.length, 1)
  const preset = draft.presets[0]
  assert.equal(preset.id, 'easyCN')
  assert.equal(preset.label, 'MoA EasyCN')
  assert.equal(preset.fanout, 'every_n:10')
  assert.equal(preset.enabled, true)
  // Advanced preset fields stay in extras, never rewritten by the UI.
  assert.equal(preset.extra.hermesSource, 'hermes')
  assert.equal(preset.extra.guidanceHeader, 'HEADER')
  assert.equal(preset.extra.guidanceInstruction, 'INSTRUCTION')
  assert.equal(preset.extra.referenceMaxTokens, 4096)
  // reasoningEffort is now managed (it travels with effortMode), so it is no
  // longer an extra; a legacy value without effortMode reads as follow.
  assert.deepEqual(preset.aggregator.extra, {})
  assert.equal(preset.aggregator.reasoningEffort, 'high')
  assert.equal(preset.aggregator.effortMode, 'follow')
  // Every-reference timeout has no control but must survive as raw data.
  assert.equal(preset.references[0].extra.timeoutMs, 600000)
  assert.equal(preset.references[0].cacheScope, 'scope-a')
  assert.equal(draft.persistentTags.length, 1)
  assert.equal(draft.referenceTimeoutMs, 600000)
  assert.equal(draft.deadlineMs, 900000)

  const patch = pure.buildConfigPatch(draft)
  assert.equal(patch.presetOverrides.easyCN.hermesSource, 'hermes')
  assert.equal(patch.presetOverrides.easyCN.referenceMaxTokens, 4096)
  assert.equal(patch.presetOverrides.easyCN.aggregator.reasoningEffort, 'high')
  // A legacy preset must not be turned into a fixed effort by load+save.
  assert.equal(patch.presetOverrides.easyCN.aggregator.effortMode, 'follow')
  assert.equal(patch.presetOverrides.easyCN.references[0].timeoutMs, 600000)
})

test('review timeout reads Host defaults and validates edited integer bounds before saving', () => {
  for (const [stored, expected] of [[undefined, 60000], [null, 60000], [NaN, 60000],
    [999, 1000], [1000, 1000], [120000, 120000], [120001, 120000], [45000, 45000]]) {
    const draft = pure.draftFromValue({ reviewTimeoutMs: stored })
    assert.equal(draft.reviewTimeoutMs, expected)
    assert.equal(pure.buildConfigPatch(draft).reviewTimeoutMs, expected)
  }
  for (const edited of [999, 120001, 1.5, NaN, Infinity, '45000']) {
    const draft = pure.draftFromValue({})
    draft.reviewTimeoutMs = edited
    assert.deepEqual(pure.validateDraft(draft), {
      type: 'validation', code: 'reviewTimeoutInvalid', field: 'reviewTimeoutMs', min: 1000, max: 120000,
    }, `invalid edit: ${edited}`)
    assert.throws(() => pure.buildConfigPatch(draft), error => error.moa.code === 'reviewTimeoutInvalid')
  }
  for (const edited of ['', 1000, 120000, 45000]) {
    const draft = pure.draftFromValue({ reviewTimeoutMs: 45000 })
    draft.reviewTimeoutMs = edited
    const patch = pure.buildConfigPatch(draft)
    assert.equal(patch.reviewTimeoutMs, edited === '' ? 60000 : edited)
    assert.deepEqual(pure.buildConfigPatch(pure.draftFromValue(patch)), patch)
  }
})

test('loading and saving an untouched table is byte-stable for the new keys', () => {
  // The store only confirms a save when the landed patch equals the submitted
  // one, so draft->patch must be idempotent for effort/scheduler defaults.
  const value = baseValue()
  value.presetOverrides.easyCN.scheduler = {
    kind: 'jev', apiKeyEnv: 'TYPESAFE_API_KEY', jevModel: 'jev-latest',
    threshold: 0.6, minGap: 2, maxGap: 12, timeoutMs: 20000,
  }
  const first = pure.buildConfigPatch(pure.draftFromValue(value), READY_CATALOG)
  const second = pure.buildConfigPatch(pure.draftFromValue({ ...value, ...first }), READY_CATALOG)
  assert.deepEqual(second, first)
  assert.equal(first.presetOverrides.easyCN.aggregator.effortMode, 'follow')
  assert.equal(first.presetOverrides.easyCN.aggregator.reasoningEffort, 'high')
})

test('legacy preset judges migrate to the shared decision even when inactive', () => {
  const plain = pure.buildConfigPatch(pure.draftFromValue(baseValue()), READY_CATALOG)
  assert.equal(plain.decision.kind, 'none')
  assert.equal('scheduler' in plain.presetOverrides.easyCN, false)

  const value = baseValue()
  value.presetOverrides.easyCN.scheduler = {
    kind: 'model', provider: 'magpie', model: 'bailian/kimi-k3',
    threshold: 0.7, minGap: 3, maxGap: 18, timeoutMs: 10000,
  }
  const draft = pure.draftFromValue(value)
  assert.equal(draft.presets[0].fanout, 'every_n:10')
  const decision = pure.buildConfigPatch(draft, READY_CATALOG).decision
  assert.equal(decision.kind, 'dsh-model')
  assert.equal(decision.provider, 'magpie')
  assert.equal(decision.model, 'bailian/kimi-k3')
  assert.equal(decision.threshold, 0.7)
  assert.equal(decision.minGap, 3)
  assert.equal(decision.maxGap, 18)
  assert.equal(decision.timeoutMs, 10000)
})

test('smart scheduling allows no decision model and validates configured judges', () => {
  const value = baseValue()
  value.presetOverrides.easyCN.fanout = 'smart'
  const draft = pure.draftFromValue(value)
  assert.equal(draft.decision.kind, 'none')
  assert.equal(pure.validateDraft(draft, READY_CATALOG), undefined)

  const withDecision = (decision) => {
    const next = pure.draftFromValue(value)
    next.decision = { ...pure.emptyDecisionDraft(), ...decision }
    return next
  }
  const route = { kind: 'dsh-model', provider: 'magpie', model: 'bailian/kimi-k3' }
  assert.equal(pure.validateDraft(withDecision(route), READY_CATALOG), undefined)
  assert.equal(pure.validateDraft(withDecision({ kind: 'jev' }), READY_CATALOG), undefined)
  assert.equal(pure.validateDraft(withDecision({ kind: 'openai-compatible', model: 'judge', credentialRef: 'BETTER_MOA_DECISION_API_KEY', baseURL: 'http://localhost:1234/v1' }), READY_CATALOG), undefined)
  assert.deepEqual(pure.validateDraft(withDecision({ kind: 'openai-compatible', model: 'judge', credentialRef: 'BETTER_MOA_DECISION_API_KEY', baseURL: 'not-a-url' }), READY_CATALOG),
    { type: 'validation', code: 'decisionBaseURLInvalid', field: 'decision.baseURL' })
  assert.deepEqual(pure.validateDraft(withDecision({ kind: 'dsh-model' }), READY_CATALOG),
    { type: 'validation', code: 'schedulerRouteRequired', field: 'decision.model' })
  assert.deepEqual(pure.validateDraft(withDecision({ kind: 'dsh-model', provider: 'moa', model: 'easyCN' }), READY_CATALOG),
    { type: 'validation', code: 'schedulerRouteRequired', field: 'decision.model' })

  const handled = decision => pure.validateDraft(withDecision(decision), READY_CATALOG)
  for (const stateChars of [99999, 512001, 128000.5]) assert.equal(handled({ kind: 'jev', stateChars }).code, 'schedulerInvalid')
  for (const stateChars of ['', 100000, 512000]) assert.equal(handled({ kind: 'jev', stateChars }), undefined)
  assert.deepEqual(handled({ ...route, threshold: 1 }),
    { type: 'validation', code: 'schedulerInvalid', field: 'decision.threshold', min: 0.05, max: 0.95 })
  assert.deepEqual(handled({ ...route, minGap: 0 }),
    { type: 'validation', code: 'schedulerInvalid', field: 'decision.minGap', min: 1, max: 999 })
  assert.deepEqual(handled({ ...route, timeoutMs: 500 }),
    { type: 'validation', code: 'schedulerInvalid', field: 'decision.timeoutMs', min: 1000, max: 120000 })
  assert.deepEqual(handled({ ...route, minGap: 8, maxGap: 3 }),
    { type: 'validation', code: 'schedulerGapInvalid', field: 'decision.maxGap' })
  assert.equal(handled({ ...route, threshold: '', minGap: '' }), undefined)
})

test('a pinned aggregator effort must exist on the model; follow may carry anything', () => {
  const value = baseValue()
  value.presetOverrides.easyCN.aggregator = {
    provider: 'magpie', model: 'bailian/deepseek-v4.1-flash-1017', effortMode: 'fixed', reasoningEffort: 'max',
  }
  value.presetOverrides.easyCN.aggregator.reasoningEffort = 'ultra'
  assert.deepEqual(pure.validateDraft(pure.draftFromValue(value), READY_CATALOG),
    { type: 'validation', code: 'agentEffortInvalid', field: 'easyCN.aggregator.reasoningEffort' })

  value.presetOverrides.easyCN.aggregator.effortMode = 'follow'
  assert.equal(pure.validateDraft(pure.draftFromValue(value), READY_CATALOG), undefined,
    'a carried value under follow is inert and must not block a save')

  value.presetOverrides.easyCN.aggregator.effortMode = 'fixed'
  value.presetOverrides.easyCN.aggregator.model = 'bailian/deepseek-v4.1-flash-1017'
  value.presetOverrides.easyCN.aggregator.reasoningEffort = 'high'
  assert.equal(pure.validateDraft(pure.draftFromValue(value), READY_CATALOG), undefined)

  // A model that publishes no efforts at all can only follow.
  value.presetOverrides.easyCN.aggregator.model = 'bailian/plain-model'
  assert.deepEqual(pure.validateDraft(pure.draftFromValue(value), READY_CATALOG),
    { type: 'validation', code: 'aggregatorEffortRequired', field: 'easyCN.aggregator.reasoningEffort' },
    'a pinned effort is impossible on a model without efforts')

  // Unknown route: support cannot be judged, so no error is invented.
  value.presetOverrides.easyCN.aggregator = {
    provider: 'gone', model: 'vanished', effortMode: 'fixed', reasoningEffort: 'max',
  }
  assert.equal(pure.validateDraft(pure.draftFromValue(value), READY_CATALOG), undefined)

  // Choosing follow keeps the stored value untouched (it rides along).
  const draft = pure.draftFromValue(baseValue())
  draft.presets[0].aggregator.effortMode = 'follow'
  const patch = pure.buildConfigPatch(draft, READY_CATALOG)
  assert.equal(patch.presetOverrides.easyCN.aggregator.reasoningEffort, 'high')
  assert.equal(patch.presetOverrides.easyCN.aggregator.effortMode, 'follow')

  // Fixed pins the chosen level, and unmanaged aggregator keys survive.
  draft.presets[0].aggregator.effortMode = 'fixed'
  draft.presets[0].aggregator.reasoningEffort = 'max'
  draft.presets[0].aggregator.extra = { maxTokens: 2048, temperature: 0.1 }
  const pinned = pure.buildConfigPatch(draft, READY_CATALOG).presetOverrides.easyCN.aggregator
  assert.equal(pinned.effortMode, 'fixed')
  assert.equal(pinned.reasoningEffort, 'max')
  assert.equal(pinned.maxTokens, 2048)
  assert.equal(pinned.temperature, 0.1)
})

test('default preset follows the enabled table and disabled ids are honored', () => {
  const value = {
    defaultPreset: 'missing',
    disabledPresets: ['disabled-one'],
    presetOverrides: {
      'disabled-one': { label: 'Off', aggregator: { provider: 'magpie', model: 'm' }, references: [] },
      zeta: { label: 'Zeta', aggregator: { provider: 'magpie', model: 'm' }, references: [] },
      alpha: { label: 'Alpha', aggregator: { provider: 'magpie', model: 'm' }, references: [] },
    },
  }
  const draft = pure.draftFromValue(value)
  assert.deepEqual(draft.presets.map((preset) => preset.id), ['disabled-one', 'zeta', 'alpha'])
  assert.equal(draft.presets[0].enabled, false)
  assert.equal(draft.defaultPreset, 'zeta', 'invalid default falls back to first enabled')
  const patch = pure.buildConfigPatch(draft)
  assert.deepEqual(patch.disabledPresets, ['disabled-one'])
})

test('fanout accepts 1–999 without rewriting the bare one', () => {
  assert.equal(pure.normalizeFanout('every_n:1'), 'every_n:1')
  assert.equal(pure.normalizeFanout('every_n:2'), 'every_n:2')
  assert.equal(pure.normalizeFanout('every_n:999'), 'every_n:999')
  assert.equal(pure.normalizeFanout('every_n:1000'), 'every_n:999')
  assert.equal(pure.normalizeFanout('nonsense'), 'user_turn')
  assert.equal(pure.normalizeFanout(''), 'user_turn')
})

test('the offline renderer rejects object children exactly like React #31', () => {
  // Scalar and nested element children survive materialization.
  const tree = materialize(React.createElement('div', null,
    'text', 0, React.createElement('span', null, 'inner'), [null, false]))
  assert.equal(textOf(tree), 'text0inner')

  // A plain object child is what React rejects with error #31; the renderer
  // must fail loudly instead of rendering a stringified placeholder.
  assert.throws(
    () => materialize(React.createElement('div', null, { label: 'oops' })),
    (error) => error.code === 'react/invalid-child'
      && /error #31/.test(error.message)
      && /label/.test(error.message),
  )

  // Calling a component with positional children instead of props leaks the
  // props object into the tree; that is the same browser crash class.
  const Bad = (props) => React.createElement('span', null, props)
  assert.throws(
    () => materialize(React.createElement('div', null, React.createElement(Bad, 'x', 'y'))),
    (error) => error.code === 'react/invalid-child',
  )
})

test('the section lists all preset choices but renders one editor with scalar text children', async () => {
  await withLiveStore(baseValue(), (store) => {
    store.addPreset()
    const tree = renderSection(store)
    const text = textOf(tree)
    assert.match(text, /MoA EasyCN/)
    assert.match(text, /Preset 2/)
    assert.doesNotMatch(text, /\[object Object\]/)
    // The panel's own copy is rendered as text, not as an accidental object.
    assert.match(text, /预设/)
    assert.equal(findAll(tree, (node) => node.props?.['data-moa-preset-name'] !== undefined).length, 1)
    assert.equal(optionsOf(byData(tree, 'data-moa-preset-selector', true)[0]).length, 2)
  })
})

test('validation rejects broken user tables but allows an empty one', () => {
  const empty = pure.draftFromValue({})
  assert.equal(pure.validateDraft(empty), undefined)
  assert.deepEqual(pure.buildConfigPatch(empty), {
    enabled: true, defaultPreset: '', disabledPresets: [], presetOverrides: {}, reviewTimeoutMs: 60000, guardEnabled: true,
    decision: { kind: 'none', threshold: 0.6, minGap: 2, maxGap: 12, timeoutMs: 20000, stateChars: 128000 },
  })

  const draft = pure.draftFromValue(baseValue())
  assert.equal(pure.validateDraft(draft), undefined)

  const copy = () => pure.draftFromValue(baseValue())
  let broken = copy()
  broken.presets[0].label = ''
  assert.equal(pure.validateDraft(broken).code, 'labelRequired')

  broken = copy()
  broken.presets[0].id = 'bad id'
  assert.equal(pure.validateDraft(broken).code, 'invalidId')

  broken = copy()
  broken.presets[0].aggregator = { provider: '', model: '', extra: {} }
  assert.equal(pure.validateDraft(broken).code, 'routeRequired')

  broken = copy()
  broken.presets[0].references.push({ ...broken.presets[0].references[0] })
  assert.equal(pure.validateDraft(broken).code, 'duplicateId')

  broken = copy()
  broken.presets[0].fanout = 'every_n:0'
  assert.equal(pure.validateDraft(broken).code, 'fanoutInvalid')

  broken = copy()
  broken.presets[0].references[0].maxTokens = 1.5
  assert.equal(pure.validateDraft(broken).code, 'maxTokensInvalid')

  broken = copy()
  broken.defaultPreset = 'gone'
  assert.equal(pure.validateDraft(broken).code, 'defaultDisabled')
})

test('save patch keeps the hidden Host knobs and omits the removed ones', () => {
  const patch = pure.buildConfigPatch(pure.draftFromValue(baseValue()))
  assert.deepEqual(Object.keys(patch).sort(), [
    'deadlineMs', 'decision', 'defaultPreset', 'disabledPresets', 'enabled',
    'guardEnabled', 'persistentTags', 'presetOverrides', 'referenceTimeoutMs', 'reviewTimeoutMs',
  ])
  assert.equal(patch.referenceTimeoutMs, 600000)
  assert.equal(patch.deadlineMs, 900000)
  assert.deepEqual(patch.persistentTags, ['*'])
  assert.equal(patch.guardEnabled, true)
  for (const removed of ['adviceHistory', 'referenceSchedule', 'maxConcurrency', 'queueBudgetMs']) {
    assert.equal(Object.hasOwn(patch, removed), false, `${removed} must not be sent`)
  }
})

test('effort values follow the catalog and stale routes are preserved', () => {
  const value = {
    defaultPreset: 'p1',
    presetOverrides: {
      p1: {
        label: 'P1', fanout: 'user_turn',
        aggregator: { provider: 'magpie', model: 'bailian/deepseek-v4.1-flash-1017' },
        references: [
          { id: 'plain', label: 'Plain', provider: 'magpie', model: 'bailian/plain-model', reasoningEffort: 'high', enabled: true },
          { id: 'kimi', label: 'Kimi', provider: 'magpie', model: 'bailian/kimi-k3', reasoningEffort: 'high', enabled: true },
          { id: 'gone', label: 'Gone', provider: 'old-provider', model: 'old/model', reasoningEffort: 'max', enabled: true },
        ],
      },
    },
  }
  const catalog = { status: 'ready', groups: pure.normalizeCatalogGroups(CATALOG.value.groups) }
  const draft = pure.draftFromValue(value)
  const patch = pure.buildConfigPatch(draft, catalog)
  const references = patch.presetOverrides.p1.references
  // Known model without published efforts: never send an effort.
  assert.equal(Object.hasOwn(references[0], 'reasoningEffort'), false)
  assert.equal(references[1].reasoningEffort, 'high')
  // Unknown route cannot be judged, so the saved value is kept, not rewritten.
  assert.equal(references[2].provider, 'old-provider')
  assert.equal(references[2].reasoningEffort, 'max')
  assert.equal(pure.effortSupport(pure.findModel(catalog, 'magpie', 'bailian/plain-model')), 'unsupported')
  assert.equal(pure.effortSupport(pure.findModel(catalog, 'magpie', 'bailian/kimi-k3')), 'supported')
  assert.equal(pure.effortSupport(pure.findModel(catalog, 'nope', 'nope')), 'unknown')
})

/* ----------------------------------------------------------- catalog/store */

test('catalog excludes MoA from advisor routes and reports failures', async () => {
  const harness = createHarness({ value: baseValue(), revision: 12 })
  const store = new client.MoaSettingsStore(harness.ctx)
  assert.equal(await store.loadCatalog(), true)
  const state = store.getSnapshot()
  assert.equal(state.catalog.status, 'ready')
  assert.equal(state.catalog.groups.length, 3)
  assert.equal(pure.findModel(state.catalog, 'moa', 'easyCN').id, 'easyCN')
  store.dispose()

  const failing = createHarness({
    value: baseValue(), revision: 12,
    onCatalog: () => ({ ok: false, error: { code: 'session/model-catalog', message: 'catalog down' } }),
  })
  const failingStore = new client.MoaSettingsStore(failing.ctx)
  assert.equal(await failingStore.loadCatalog(), false)
  assert.equal(failingStore.getSnapshot().catalog.status, 'error')
  assert.equal(failingStore.getSnapshot().catalog.error.code, 'session/model-catalog')
  assert.match(failingStore.getSnapshot().catalog.error.message, /catalog down/)
  failingStore.dispose()
})

test('autosave writes the live revision and confirms through configForms', async () => {
  await withLiveStore(baseValue(), async (store, harness) => {
    store.edit(draft => { draft.guardEnabled = false })
    assert.equal(store.getSnapshot().dirty, true)
    assert.equal(harness.calls.mutate.length, 0)
    await store.flushAutosave()
    assert.equal(harness.calls.mutate.length, 1)
    assert.equal(harness.calls.mutate[0].revision, 12)
    assert.equal(harness.current().value.guardEnabled, false)
    assert.equal(store.getSnapshot().saved, true)
    assert.equal(store.getSnapshot().dirty, false)
  })
})

test('deleting a preset autosaves a replacement of the complete table', async () => {
  const value = baseValue()
  value.presetOverrides.second = { ...value.presetOverrides.easyCN, id: 'second', label: 'Second' }
  await withLiveStore(value, async (store, harness) => {
    store.removePreset('second')
    await store.flushAutosave()
    const operation = harness.calls.mutate[0].operations.find(entry => entry.path[0] === 'presetOverrides')
    assert.deepEqual(Object.keys(operation.value), ['easyCN'])
    assert.equal(operation.op, 'set')
  })
})

test('a rejected autosave preserves the draft, reports the error, and reloads the mirror', async () => {
  await withLiveStore(baseValue(), async (store, harness) => {
    store.edit(draft => { draft.guardEnabled = false })
    await store.flushAutosave()
    assert.equal(store.getSnapshot().draft.guardEnabled, false)
    assert.equal(store.getSnapshot().error.message, 'fixture rejection')
    assert.equal(store.getSnapshot().saving, false)
    assert.equal(harness.calls.load, 1)
  }, { onUpdate() { throw new Error('fixture rejection') } })
})

test('invalid edits never enter the Host document', async () => {
  await withLiveStore(baseValue(), async (store, harness) => {
    assert.equal(store.edit(draft => { draft.reviewTimeoutMs = 0 }), false)
    await store.flushAutosave()
    assert.equal(harness.calls.mutate.length, 0)
    assert.equal(store.getSnapshot().error.field, 'reviewTimeoutMs')
    assert.equal(store.getSnapshot().draft.reviewTimeoutMs, 0)
  })
})

test('autosave writes are serial and forward the latest Host revision', async () => {
  const first = deferred()
  let active = 0
  let maximum = 0
  await withLiveStore(baseValue(), async (store, harness) => {
    store.edit(draft => { draft.guardEnabled = false })
    const one = store.flushAutosave()
    store.edit(draft => { draft.reviewTimeoutMs = 46000 })
    const two = store.flushAutosave()
    first.resolve()
    await Promise.all([one, two])
    assert.equal(maximum, 1)
    assert.deepEqual(harness.calls.mutate.map(call => call.revision), [12, 13])
    assert.equal(harness.current().value.reviewTimeoutMs, 46000)
  }, {
    async onUpdate({ patch, current, updateScope }) {
      active += 1; maximum = Math.max(maximum, active)
      if (harnessCalls(active) === 1) await first.promise
      const value = { ...current.value, ...patch }
      updateScope({ value, base: value, user: value, revision: current.revision + 1 })
      active -= 1
      return { ok: true }
    },
  })
})

function harnessCalls(active) { return active }
test('users can add references and delete every preset, leaving an empty saveable table', async () => {
  await withLiveStore(baseValue(), async (store) => {
    const presetId = store.addPreset()
    assert.equal(presetId, 'preset-2')
    let state = store.getSnapshot()
    assert.equal(state.draft.presets.length, 2)
    const added = state.draft.presets.find((preset) => preset.id === presetId)
    assert.equal(added.label, 'Preset 2')
    assert.equal(added.references.length, 1)
    assert.equal(added.references[0].label, 'Ref 1')
    assert.equal(state.dirty, true)

    const referenceId = store.addReference(presetId)
    assert.ok(referenceId)
    state = store.getSnapshot()
    assert.equal(state.draft.presets.find((preset) => preset.id === presetId).references.length, 2)
    assert.equal(state.draft.presets.find((preset) => preset.id === presetId).references[1].label, 'Ref 2')

    store.removeReference(presetId, referenceId)
    assert.equal(store.getSnapshot().draft.presets.find((preset) => preset.id === presetId).references.length, 1)

    store.removePreset('easyCN')
    store.removePreset(presetId)
    state = store.getSnapshot()
    assert.equal(state.draft.presets.length, 0)
    assert.equal(state.draft.defaultPreset, '')
    // An empty table is saveable and never repopulated from a hidden default.
    assert.equal(await store.flushAutosave(), true)
    assert.deepEqual(store.getSnapshot().base.presets, [])
  })
})

test('the last enabled preset cannot be disabled and deletion repoints the default', async () => {
  await withLiveStore({}, async (store) => {
    const first = store.addPreset()
    const second = store.addPreset()
    const third = store.addPreset()
    assert.notEqual(first, second)
    assert.notEqual(second, third)
    assert.equal(store.getSnapshot().draft.defaultPreset, first)

    // Disabling the default hands the default to another enabled preset.
    store.setPresetEnabled(first, false)
    assert.equal(store.getSnapshot().draft.presets.find((preset) => preset.id === first).enabled, false)
    assert.equal(store.getSnapshot().draft.defaultPreset, second)

    // Removing the default picks the next enabled preset.
    store.removePreset(second)
    assert.equal(store.getSnapshot().draft.defaultPreset, third)

    // Only one enabled preset remains: it must not be disableable.
    store.setPresetEnabled(third, false)
    assert.equal(store.getSnapshot().draft.presets.find((preset) => preset.id === third).enabled, true)
    assert.equal(store.getSnapshot().draft.defaultPreset, third)
  })
})

/* ------------------------------------------------------------------- UI */

test('empty configuration shows the add-preset guidance and no removed knobs', async () => {
  const harness = createHarness({ value: {}, revision: 12 })
  const store = new client.MoaSettingsStore(harness.ctx)
  try {
    await store.loadCatalog()
    const tree = renderSection(store)
    const text = textOf(tree)
    assert.match(text, new RegExp(zh('presetsEmpty')))
    assert.equal(byData(tree, 'data-moa-preset').length, 0)
    assert.ok(findAll(tree, (node) => node.type === 'button' && textOf(node) === zh('addPreset')).length)
    for (const removed of ['save', 'refreshCatalog', 'reloadDocument']) {
      assert.equal(findAll(tree, node => node.type === 'button' && textOf(node) === zh(removed)).length, 0)
    }

    // Opinion retention, schedule, concurrency, queueing and reference timeouts are gone.
    for (const removed of [
      'data-moa-advice-history', 'data-moa-reference-schedule', 'data-moa-max-concurrency',
      'data-moa-queue-budget', 'data-moa-reference-timeout', 'data-moa-ref-timeout',
      'data-moa-deadline', 'data-moa-global-timeout',
    ]) {
      assert.equal(byData(tree, removed).length, 0, `${removed} must not render`)
    }
    const numbers = findAll(tree, (node) => node.type === 'input' && node.props.type === 'number')
    assert.equal(numbers.length, 6)
    assert.equal(byData(tree, 'data-moa-scheduler', true).length, 1)
    assert.equal(byData(tree, 'data-moa-review-timeout')[0].props.value, 60000)
  } finally {
    store.dispose()
  }
})

test('review timeout UI saves boundaries and clearing with Host or unary confirmation', async () => {
  for (const confirmation of ['host', 'response']) {
    for (const edited of ['', '1000', '120000', '30000']) {
      const harness = createHarness({ value: baseValue(), revision: 12 })
      // Suppress only the broadcast so the same landing is verified by the unary response.
      if (confirmation === 'response') harness.scope.subscribe = () => () => {}
      const store = new client.MoaSettingsStore(harness.ctx)
      try {
        await store.loadCatalog()
        const advanced = byData(renderSection(store), 'data-moa-global-advanced')[0]
        assert.ok(advanced)
        assert.equal(advanced.type, 'details')
        assert.ok(textOf(advanced).includes(zh('reviewTimeoutMs')))
        assert.ok(textOf(advanced).includes(zh('reviewTimeoutHint')))
        const field = byData(advanced, 'data-moa-review-timeout')[0]
        assert.deepEqual([field.props.type, field.props.min, field.props.max, field.props.step, field.props.value],
          ['number', 1000, 120000, 1, 45000])
        field.props.onChange({ target: { value: edited } })
        const expected = edited === '' ? 60000 : Number(edited)
        assert.equal(await store.flushAutosave(), true, `${confirmation} reset/save: ${edited}`)
        assert.equal(harness.calls.mutate.length, 1)
        assert.deepEqual(harness.calls.mutate[0].operations.find(operation => operation.path[0] === 'reviewTimeoutMs'),
          { op: 'set', path: ['reviewTimeoutMs'], value: expected })
        const state = store.getSnapshot()
        assert.equal(state.saved, true)
        assert.equal(state.dirty, false)
        assert.equal(state.base.reviewTimeoutMs, expected)
        assert.equal(state.draft.reviewTimeoutMs, expected)
      } finally {
        store.dispose()
      }
    }
  }
})

test('clearing an already-default review timeout stays clean without a settings mutation', async () => {
  const value = baseValue()
  delete value.reviewTimeoutMs
  await withLiveStore(value, async (store, harness) => {
    byData(renderSection(store), 'data-moa-review-timeout')[0].props.onChange({ target: { value: '' } })
    assert.equal(store.getSnapshot().draft.reviewTimeoutMs, '')
    assert.equal(store.getSnapshot().dirty, false)
    assert.equal(await store.flushAutosave(), true)
    assert.equal(harness.calls.mutate.length, 0)
    harness.notify()
    assert.equal(store.getSnapshot().draft.reviewTimeoutMs, 60000)
    assert.equal(store.getSnapshot().dirty, false)
  })
})

test('invalid review timeout edits never reach the Host', async () => {
  await withLiveStore(baseValue(), async (store, harness) => {
    for (const edited of ['999', '120001', '1.5']) {
      byData(renderSection(store), 'data-moa-review-timeout')[0].props.onChange({ target: { value: edited } })
      assert.equal(await store.flushAutosave(), false)
      assert.equal(store.getSnapshot().error.code, 'reviewTimeoutInvalid')
      assert.ok(textOf(renderSection(store)).includes(zh('reviewTimeoutInvalid')))
      assert.equal(harness.calls.mutate.length, 0)
    }
  })
})

test('the preset editor exposes delivery, preset timeout and reference context window', async () => {
  const legacy = baseValue()
  Object.assign(legacy.presetOverrides.easyCN.references[0], { async: true, futureField: 'keep' })
  const legacyDraft = pure.draftFromValue(legacy)
  assert.equal(legacyDraft.presets[0].delivery, 'background')
  const legacyReference = pure.buildConfigPatch(legacyDraft).presetOverrides.easyCN.references[0]
  assert.equal('async' in legacyReference, false)
  assert.equal(legacyReference.futureField, 'keep')

  await withLiveStore(baseValue(), async (store) => {
    const tree = renderSection(store)
    const text = textOf(tree)
    const card = byData(tree, 'data-moa-preset', 'easyCN')[0]
    assert.ok(card, 'preset card renders')

    const name = byData(tree, 'data-moa-preset-name', 'easyCN')[0]
    assert.equal(name.props.value, 'MoA EasyCN')
    // The label is not duplicated as a heading next to the editable input.
    assert.equal(findAll(tree, (node) => node.type === 'strong' && textOf(node).includes('MoA EasyCN')).length, 0)

    const delivery = byData(tree, 'data-moa-delivery', 'easyCN')[0]
    assert.equal(delivery.props.value, 'wait')
    assert.deepEqual(optionsOf(delivery), ['wait', 'background'])
    assert.ok(text.includes(zh('deliveryWait')))
    assert.ok(text.includes(zh('deliveryBackground')))
    assert.equal(byData(tree, 'data-moa-ref-injection', true).length, 0)
    const presetTimeout = byData(tree, 'data-moa-preset-reference-timeout')[0]
    assert.equal(presetTimeout.props.placeholder, '600')
    const contextWindow = byData(tree, 'data-moa-ref-context-window')[0]
    assert.equal(contextWindow.props.value, '')
    assert.equal(contextWindow.props.min, 8192)

    // Per-reference timeout is not offered, but its value stays in the draft.
    assert.equal(byData(tree, 'data-moa-ref-timeout').length, 0)
    assert.equal(store.getSnapshot().draft.presets[0].references[0].extra.timeoutMs, 600000)

    const details = findAll(card, (node) => node.type === 'details')
    assert.equal(details.length, 1)
    const detailsText = textOf(details[0])
    assert.ok(detailsText.includes(zh('cacheScope')))
    assert.ok(detailsText.includes(zh('systemSuffix')))
    assert.ok(detailsText.includes(zh('referencePersistent')))
    assert.ok(detailsText.includes(zh('referenceContinueOnStop')))
    assert.ok(detailsText.includes(zh('advancedHint')))
    assert.equal(byData(tree, 'data-moa-ref-cache-scope', true)[0].props.value, 'scope-a')
    assert.equal(byData(tree, 'data-moa-ref-persistent', true)[0].props.value, '')

    // The global advanced card holds the separate end-of-turn review budget.
    const globalAdvanced = byData(tree, 'data-moa-global-advanced')[0]
    assert.ok(textOf(globalAdvanced).includes(zh('reviewTimeoutMs')))
    assert.ok(text.includes(zh('guardHint')))
    assert.match(text, new RegExp(zh('fixedNote')))
  })
})

test('the reference editor offers a session cache policy that saves stable/rotate and drops the key for auto', async () => {
  const value = baseValue()
  Object.assign(value.presetOverrides.easyCN.references[0], { sessionPolicy: 'stable' })

  // Reading: a saved literal is kept; anything else (including a legacy 'auto') is automatic.
  const draft = pure.draftFromValue(value)
  assert.equal(draft.presets[0].references[0].sessionPolicy, 'stable')
  for (const [raw, expected] of [['rotate', 'rotate'], ['', ''], [undefined, ''], ['auto', ''], ['Stable', ''], [true, '']]) {
    const probe = baseValue()
    probe.presetOverrides.easyCN.references[0].sessionPolicy = raw
    assert.equal(pure.draftFromValue(probe).presets[0].references[0].sessionPolicy, expected, `raw ${String(raw)}`)
  }
  assert.deepEqual([...pure.SESSION_POLICY_VALUES], ['stable', 'rotate'])

  // Writing: auto is the absent key, never `sessionPolicy: 'auto'`.
  for (const [policy, expected] of [['stable', 'stable'], ['rotate', 'rotate'], ['', undefined], ['auto', undefined]]) {
    const probe = pure.draftFromValue(value)
    probe.presets[0].references[0].sessionPolicy = policy
    const saved = pure.buildConfigPatch(probe).presetOverrides.easyCN.references[0]
    assert.equal(saved.sessionPolicy, expected, `saving ${JSON.stringify(policy)}`)
    assert.equal(Object.hasOwn(saved, 'sessionPolicy'), expected !== undefined, `key presence for ${JSON.stringify(policy)}`)
  }
  // A brand-new reference starts automatic and stays keyless until the user chooses.
  const empty = pure.emptyReferenceDraft([])
  assert.equal(empty.sessionPolicy, '')
  const fresh = pure.draftFromValue(baseValue())
  fresh.presets[0].references.push({ ...empty, provider: 'magpie', model: 'bailian/kimi-k3' })
  const freshSaved = pure.buildConfigPatch(fresh).presetOverrides.easyCN.references[1]
  assert.equal(Object.hasOwn(freshSaved, 'sessionPolicy'), false)
  // The raw Host value no longer leaks through the round-tripped unknown fields.
  assert.equal(Object.hasOwn(pure.buildConfigPatch(pure.draftFromValue(value)).presetOverrides.easyCN.references[0].extra || {}, 'sessionPolicy'), false)

  await withLiveStore(value, async (store) => {
    const tree = renderSection(store)
    const select = byData(tree, 'data-moa-ref-session-policy', true)[0]
    assert.ok(select, 'session policy select renders')
    assert.equal(select.type, 'select')
    assert.equal(select.props.value, 'stable')
    assert.deepEqual(optionsOf(select), ['', 'stable', 'rotate'])
    assert.deepEqual(select.props.children.map((option) => textOf(option)),
      [zh('sessionPolicy_auto'), zh('sessionPolicy_stable'), zh('sessionPolicy_rotate')])
    const labelText = textOf(findAll(tree, (node) => node.type === 'label'
      && findAll(node, (inner) => inner === select).length > 0)[0])
    assert.ok(labelText.includes(zh('sessionPolicy')), labelText)
    assert.ok(labelText.includes(zh('sessionPolicyHint')), labelText)
    // The select lives with the other advanced reference options.
    const details = byData(tree, 'data-moa-reference', 'kimi-k3')[0]
    assert.equal(findAll(details, (node) => node.type === 'details' && findAll(node, (inner) => inner === select).length > 0).length, 1)

    // Simulated user choice flows into the draft and the Host patch.
    select.props.onChange({ target: { value: 'rotate' } })
    assert.equal(store.getSnapshot().draft.presets[0].references[0].sessionPolicy, 'rotate')
    assert.equal(pure.buildConfigPatch(store.getSnapshot().draft).presetOverrides.easyCN.references[0].sessionPolicy, 'rotate')
  })

  // English copy renders through the same component.
  await withLiveStore(baseValue(), async (store) => {
    const tree = renderSection(store, { t: en })
    const select = byData(tree, 'data-moa-ref-session-policy', true)[0]
    assert.deepEqual(select.props.children.map((option) => textOf(option)), ['Auto (by route)', 'Stable', 'Rotate'])
    const labelText = textOf(findAll(tree, (node) => node.type === 'label'
      && findAll(node, (inner) => inner === select).length > 0)[0])
    assert.ok(labelText.includes('Session cache policy'), labelText)
    assert.ok(labelText.includes(en('sessionPolicyHint')), labelText)
  })

  // Locale table: zh/en parity and the exact wording.
  assert.equal(client.LOCALES.zh.sessionPolicy, '会话缓存策略')
  assert.equal(client.LOCALES.zh.sessionPolicy_auto, '自动（按路由）')
  assert.equal(client.LOCALES.zh.sessionPolicy_stable, '稳定')
  assert.equal(client.LOCALES.zh.sessionPolicy_rotate, '轮换')
  assert.equal(client.LOCALES.en.sessionPolicy, 'Session cache policy')
  assert.equal(client.LOCALES.en.sessionPolicy_auto, 'Auto (by route)')
  assert.equal(client.LOCALES.en.sessionPolicy_stable, 'Stable')
  assert.equal(client.LOCALES.en.sessionPolicy_rotate, 'Rotate')
  assert.match(client.LOCALES.zh.sessionPolicyHint, /缓存/)
  assert.match(client.LOCALES.en.sessionPolicyHint, /cache/i)
})

test('provider and model selects expose the full catalog instead of prefix matches', async () => {
  await withLiveStore(baseValue(), async (store, harness) => {
    const tree = renderSection(store)
    const aggregator = byData(tree, 'data-moa-route', 'aggregator')[0]
    const provider = byData(aggregator, 'data-moa-route-provider', 'aggregator')[0]
    const model = byData(aggregator, 'data-moa-route-model', 'aggregator')[0]
    assert.equal(provider.type, 'select')
    assert.equal(model.type, 'select')

    // Complete provider list, MoA virtual models excluded.
    assert.deepEqual(optionsOf(provider), ['', 'magpie', 'magpie-anthropic'])
    assert.equal(optionsOf(provider).includes('moa'), false)
    // Every model of the group is listed, not just those matching the input value.
    assert.deepEqual(optionsOf(model), ['', 'bailian/deepseek-v4.1-flash-1017', 'bailian/kimi-k3', 'bailian/plain-model'])
    assert.ok(textOf(model).includes('DeepSeek Flash (bailian/deepseek-v4.1-flash-1017)'))

    // Changing provider clears a model the new provider does not offer.
    provider.props.onChange({ target: { value: 'magpie-anthropic' } })
    let draft = store.getSnapshot().draft
    assert.equal(draft.presets[0].aggregator.provider, 'magpie-anthropic')
    assert.equal(draft.presets[0].aggregator.model, '')

    // A model without published efforts drops a now-unsupported effort.
    const referenceRoute = byData(tree, 'data-moa-route', 'reference:kimi-k3')[0]
    const referenceModel = byData(referenceRoute, 'data-moa-route-model', 'reference:kimi-k3')[0]
    referenceModel.props.onChange({ target: { value: 'bailian/plain-model' } })
    draft = store.getSnapshot().draft
    assert.equal(draft.presets[0].references[0].model, 'bailian/plain-model')
    assert.equal(draft.presets[0].references[0].reasoningEffort, '')
    assert.equal(harness.calls.catalog, 1)
  })
})

test('a saved route missing from the catalog is kept with an explicit warning', async () => {
  const value = baseValue()
  value.presetOverrides.easyCN.references[0].provider = 'old-provider'
  value.presetOverrides.easyCN.references[0].model = 'old/model'
  await withLiveStore(value, async (store) => {
    const tree = renderSection(store)
    const route = byData(tree, 'data-moa-route', 'reference:kimi-k3')[0]
    const provider = byData(route, 'data-moa-route-provider', 'reference:kimi-k3')[0]
    const model = byData(route, 'data-moa-route-model', 'reference:kimi-k3')[0]
    assert.equal(provider.props.value, 'old-provider')
    assert.equal(model.props.value, 'old/model')
    assert.ok(textOf(provider).includes(zh('notInCatalog')))
    assert.ok(textOf(model).includes(zh('notInCatalog')))
    assert.ok(textOf(route).includes(zh('routeStale')))
    // The stale pair is saved unchanged rather than silently replaced.
    const patch = pure.buildConfigPatch(store.getSnapshot().draft, store.getSnapshot().catalog)
    assert.equal(patch.presetOverrides.easyCN.references[0].provider, 'old-provider')
    assert.equal(patch.presetOverrides.easyCN.references[0].model, 'old/model')
  })
})

test('a failed catalog falls back to manual route inputs without a manual refresh button', async () => {
  const harness = createHarness({
    value: baseValue(), revision: 12,
    onCatalog: () => ({ ok: false, error: { code: 'session/model-catalog', message: 'offline' } }),
  })
  const store = new client.MoaSettingsStore(harness.ctx)
  try {
    await store.loadCatalog()
    const tree = renderSection(store)
    const text = textOf(tree)
    assert.ok(text.includes(zh('catalogFailed')))
    const provider = byData(tree, 'data-moa-route-provider', 'aggregator')[0]
    const model = byData(tree, 'data-moa-route-model', 'aggregator')[0]
    assert.equal(provider.type, 'input')
    assert.equal(model.type, 'input')
    assert.equal(provider.props.value, 'magpie')
    assert.equal(findAll(tree, (node) => node.type === 'button' && textOf(node) === zh('refreshCatalog')).length, 0)
    // Failure is explicit, and the route can still be saved as typed.
    assert.equal(await store.loadCatalog(), false)
  } finally {
    store.dispose()
  }
})

test('an unanswered catalog read ends in a bounded retryable error, not loading forever', async () => {
  const harness = createHarness({
    value: {}, revision: 12,
    // A page frozen in the background leaves this promise pending forever.
    onCatalog: () => new Promise(() => {}),
  })
  const store = new client.MoaSettingsStore(harness.ctx)
  const previous = pure.getCatalogTimeoutMs()
  try {
    pure.setCatalogTimeoutMs(20)
    const started = Date.now()
    assert.equal(await store.loadCatalog(), false)
    assert.ok(Date.now() - started < 1000, 'the catalog read must be bounded')
    const state = store.getSnapshot()
    assert.equal(state.catalog.status, 'error')
    assert.equal(state.catalog.refreshing, false)
    assert.equal(state.catalog.error.code, 'session/model-catalog-timeout')
    const tree = renderSection(store)
    assert.ok(textOf(tree).includes(zh('catalogTimeout')))
    assert.equal(findAll(tree, (node) => node.type === 'button' && textOf(node) === zh('refreshCatalog')).length, 0)
  } finally {
    pure.setCatalogTimeoutMs(previous)
    store.dispose()
  }
})

test('refreshing a usable catalog keeps it ready and keeps the complete picker', async () => {
  let calls = 0
  const harness = createHarness({
    value: baseValue(), revision: 12,
    onCatalog: () => {
      calls += 1
      return calls === 1 ? CATALOG : new Promise(() => {})
    },
  })
  const store = new client.MoaSettingsStore(harness.ctx)
  const previous = pure.getCatalogTimeoutMs()
  try {
    assert.equal(await store.loadCatalog(), true)
    pure.setCatalogTimeoutMs(25)

    const pending = store.loadCatalog()
    const during = store.getSnapshot()
    // The refresh must not downgrade a catalog that already works.
    assert.equal(during.catalog.status, 'ready')
    assert.equal(during.catalog.refreshing, true)
    const tree = renderSection(store)
    const provider = byData(tree, 'data-moa-route-provider', 'aggregator')[0]
    assert.equal(provider.type, 'select')
    assert.deepEqual(optionsOf(provider), ['', 'magpie', 'magpie-anthropic'])
    const model = byData(tree, 'data-moa-route-model', 'aggregator')[0]
    assert.equal(model.type, 'select')
    assert.equal(optionsOf(model).includes('bailian/kimi-k3'), true)
    assert.ok(textOf(tree).includes(zh('catalogLoading')))

    assert.equal(await pending, false)
    const after = store.getSnapshot()
    assert.equal(after.catalog.status, 'ready')
    assert.equal(after.catalog.groups.length, 3)
    assert.equal(after.catalog.refreshing, false)
    assert.equal(after.catalog.error.code, 'session/model-catalog-timeout')
    assert.ok(textOf(renderSection(store)).includes(zh('catalogTimeout')))
  } finally {
    pure.setCatalogTimeoutMs(previous)
    store.dispose()
  }
})

test('a late catalog answer after the timeout cannot replace the bounded error state', async () => {
  let deliver
  const harness = createHarness({
    value: {}, revision: 12,
    onCatalog: () => new Promise((resolve) => { deliver = resolve }),
  })
  const store = new client.MoaSettingsStore(harness.ctx)
  const previous = pure.getCatalogTimeoutMs()
  try {
    pure.setCatalogTimeoutMs(20)
    assert.equal(await store.loadCatalog(), false)
    assert.equal(store.getSnapshot().catalog.error.code, 'session/model-catalog-timeout')
    deliver(CATALOG)
    await wait(20)
    const state = store.getSnapshot()
    assert.equal(state.catalog.status, 'error')
    assert.equal(state.catalog.groups.length, 0)
    assert.equal(state.catalog.error.code, 'session/model-catalog-timeout')
  } finally {
    pure.setCatalogTimeoutMs(previous)
    store.dispose()
  }
})

test('aggregator effort starts at follow and only a chosen level pins it', async () => {
  await withLiveStore(baseValue(), async (store) => {
    const tree = renderSection(store)
    const effort = byData(tree, 'data-moa-aggregator-effort', true)[0]
    assert.ok(effort, 'aggregator effort is now a real control')
    assert.equal(effort.type, 'select')
    // Legacy presets store reasoningEffort without effortMode: that reads as
    // follow, so the select shows the follow option, not 'high'.
    assert.equal(effort.props.value, '')
    assert.deepEqual(optionsOf(effort), ['', 'high', 'max'])
    assert.equal(effort.props.disabled, undefined)
    // Field() renders label / control / hint as siblings, so the hint lives
    // beside the select rather than inside it.
    const card = textOf(tree)
    assert.equal(textOf(byData(tree, 'data-moa-fanout', 'easyCN')[0]).includes(zh('followPicker')), false)
    assert.ok(card.includes(zh('followPicker')))
    assert.ok(card.includes(zh('aggregatorEffortHint')))

    // Picking a level pins it and leaves the rest of the preset untouched.
    effort.props.onChange({ target: { value: 'max' } })
    const pinned = store.getSnapshot().draft.presets[0].aggregator
    assert.deepEqual([pinned.effortMode, pinned.reasoningEffort], ['fixed', 'max'])
    const pinnedTree = renderSection(store)
    assert.equal(byData(pinnedTree, 'data-moa-aggregator-effort', true)[0].props.value, 'max')

    // Back to follow: the mode flips, the carried level is kept (inert).
    byData(renderSection(store), 'data-moa-aggregator-effort', true)[0].props.onChange({ target: { value: '' } })
    const followed = store.getSnapshot().draft.presets[0].aggregator
    assert.deepEqual([followed.effortMode, followed.reasoningEffort], ['follow', 'max'])
    assert.equal(byData(renderSection(store), 'data-moa-aggregator-effort', true)[0].props.value, '')

    const text = textOf(tree)
    assert.ok(text.includes(zh('fixedNote')))
    assert.match(text, /600/)
    assert.match(text, /900/)
    assert.match(text, /聚合器|aggregator/i)
    assert.ok(text.includes(zh('guardHint')))
  })
})

test('an aggregator model without efforts can only follow and cannot be pinned', async () => {
  const value = baseValue()
  value.presetOverrides.easyCN.aggregator.model = 'bailian/plain-model'
  await withLiveStore(value, async (store) => {
    const tree = renderSection(store)
    const effort = byData(tree, 'data-moa-aggregator-effort', true)[0]
    assert.deepEqual(optionsOf(effort), [''])
    assert.equal(effort.props.disabled, true, 'nothing to choose but follow')
    assert.ok(textOf(tree).includes(zh('aggregatorEffortUnsupported')))
  })

  // A stale route cannot be judged, so following stays possible.
  const stale = baseValue()
  stale.presetOverrides.easyCN.aggregator.model = 'bailian/gone'
  await withLiveStore(stale, async (store) => {
    const tree = renderSection(store)
    const effort = byData(tree, 'data-moa-aggregator-effort', true)[0]
    assert.equal(effort.props.disabled, undefined)
    assert.ok(textOf(tree).includes(zh('aggregatorEffortUnknown')))
  })
})

test('the shared decision model is optional and supports all five modes', async () => {
  await withLiveStore(baseValue(), async store => {
    const decisionOf = () => store.getSnapshot().draft.decision
    assert.equal(decisionOf().kind, 'none')
    assert.equal(byData(renderSection(store), 'data-moa-scheduler', true).length, 1)
    const section = byData(renderSection(store), 'data-moa-scheduler', true)[0]
    assert.deepEqual(optionsOf(byData(section, 'data-moa-scheduler-kind', true)[0]),
      ['none', 'dsh-model', 'openai-compatible', 'jev', 'openai-decisions'])

    for (const kind of ['jev', 'openai-decisions', 'openai-compatible']) {
      byData(renderSection(store), 'data-moa-scheduler-kind', true)[0].props.onChange({ target: { value: kind } })
      assert.equal(decisionOf().kind, kind)
      const tree = renderSection(store)
      assert.equal(byData(tree, 'data-moa-decision-credential-ref', true).length, 0, 'credential references are derived, not edited')
      assert.equal(byData(tree, 'data-moa-decision-api-key', true)[0].props.type, 'password')
      assert.equal(byData(tree, 'data-moa-preset', 'easyCN').length, 1)
      assert.equal(decisionOf().credentialRef, { jev: 'TYPESAFE_API_KEY', 'openai-decisions': 'MOA_OPENAI_API_KEY', 'openai-compatible': 'BETTER_MOA_DECISION_API_KEY' }[kind])
    }
    store.edit(draft => { draft.decision.model = 'judge'; draft.decision.baseURL = 'https://example.invalid/v1' })
    byData(renderSection(store), 'data-moa-scheduler-minGap', true)[0].props.onChange({ target: { value: '4' } })
    const patch = pure.buildConfigPatch(store.getSnapshot().draft, READY_CATALOG)
    assert.equal(patch.decision.credentialRef, 'BETTER_MOA_DECISION_API_KEY')
    assert.equal(patch.decision.minGap, 4)
    assert.equal('scheduler' in patch.presetOverrides.easyCN, false)
    assert.equal('apiKey' in patch.decision, false)
  })
})

test('legacy judges migrate to decision and retain unknown fields without private preset judges', async () => {
  const scheduler = { kind: 'model', provider: 'old-provider', model: 'old/model', reasoningEffort: 'high', apiKeyEnv: 'TEST_API_KEY', jevModel: 'jev-retained', threshold: .65, minGap: 8, maxGap: 3, timeoutMs: 22000, stateChars: 4321, custom: { enabled: true } }
  for (const fanout of ['user_turn', 'user_turn_end', 'every_n:1']) {
    const value = baseValue()
    Object.assign(value.presetOverrides.easyCN, { fanout, scheduler })
    await withLiveStore(value, async (store, harness) => {
      assert.equal(store.getSnapshot().draft.decision.kind, 'dsh-model')
      store.edit(draft => { draft.presets[0].label = 'Inactive judge retained' })
      assert.equal(await store.flushAutosave(), false, 'the migrated invalid range is not written')
      assert.equal(harness.calls.mutate.length, 0)
      store.edit(draft => { draft.decision.minGap = 2 })
      assert.equal(await store.flushAutosave(), true)
      const operations = harness.calls.mutate[0].operations
      const decision = operations.find(operation => operation.path[0] === 'decision').value
      assert.equal(decision.kind, 'dsh-model')
      assert.equal('credentialRef' in decision, false, 'DSH models use the catalog route, not a custom credential')
      assert.equal(decision.stateChars, 128000)
      assert.deepEqual(decision.custom, { enabled: true })
      assert.equal('scheduler' in operations.find(operation => operation.path[0] === 'presetOverrides').value.easyCN, false)
      assert.equal(store.getSnapshot().dirty, false)
    })
  }
})

test('switching smart presets to no decision model requires confirmation and warns inline', async () => {
  const value = baseValue()
  value.presetOverrides.easyCN.fanout = 'smart'
  value.decision = { kind: 'jev', credentialRef: 'TEST_DECISION_KEY', model: 'jev-latest', baseURL: 'https://example.invalid/v1' }
  await withLiveStore(value, async store => {
    const previous = globalThis.confirm
    globalThis.confirm = () => false
    try {
      byData(renderSection(store), 'data-moa-scheduler-kind', true)[0].props.onChange({ target: { value: 'none' } })
      assert.equal(store.getSnapshot().draft.decision.kind, 'jev')
      globalThis.confirm = () => true
      byData(renderSection(store), 'data-moa-scheduler-kind', true)[0].props.onChange({ target: { value: 'none' } })
      assert.equal(store.getSnapshot().draft.decision.kind, 'none')
      assert.ok(textOf(renderSection(store)).includes(zh('noDecisionWarning')))
    } finally { globalThis.confirm = previous }
  })
})

test('connection tests use catalog membership or a freshly typed key only', async () => {
  const value = baseValue()
  value.decision = { kind: 'dsh-model', provider: 'magpie', model: 'bailian/kimi-k3' }
  await withLiveStore(value, async (store, harness) => {
    await byData(renderSection(store), 'data-moa-test-decision', true)[0].props.onClick()
    assert.equal((harness.calls.discover || []).length, 0)
    store.edit(draft => { Object.assign(draft.decision, { kind: 'openai-compatible', baseURL: 'https://example.invalid/v1', credentialRef: 'TEST_DECISION_KEY' }) })
    await byData(renderSection(store), 'data-moa-test-decision', true)[0].props.onClick()
    assert.equal((harness.calls.discover || []).length, 0, 'saved credentials are never read back into the browser')
    const result = await pure.testDecisionConnection({
      decision: store.getSnapshot().draft.decision, catalog: store.getSnapshot().catalog,
      apiKey: 'test-key', remote: harness.ctx.remote,
    })
    assert.equal(result.ok, true)
    assert.equal(harness.calls.discover.length, 1)
    assert.equal(harness.calls.discover[0].namespace, 'better-moa')
    assert.equal(harness.calls.discover[0].request.baseURL, 'https://example.invalid/v1')
    assert.equal(harness.calls.discover[0].request.apiKey, 'test-key')
    assert.equal('provider' in harness.calls.discover[0].request, false)
  })
})
test('preset selection preserves drafts and never changes the default; add and delete select a usable editor', async () => {
  const value = baseValue()
  value.presetOverrides.second = structuredClone(value.presetOverrides.easyCN)
  value.presetOverrides.second.label = 'Second'
  await withLiveStore(value, async store => {
    const select = id => byData(renderSection(store), 'data-moa-preset-selector', true)[0].props.onChange({ target: { value: id } })
    select('second')
    assert.equal(store.getSnapshot().dirty, false)
    assert.equal(store.getSnapshot().draft.defaultPreset, 'easyCN')
    assert.equal(byData(renderSection(store), 'data-moa-preset', 'second').length, 1)
    byData(renderSection(store), 'data-moa-preset-name', 'second')[0].props.onChange({ target: { value: 'Edited unsaved' } })
    select('easyCN'); select('second')
    assert.equal(byData(renderSection(store), 'data-moa-preset-name', 'second')[0].props.value, 'Edited unsaved')
    const created = store.addPreset()
    assert.equal(byData(renderSection(store), 'data-moa-preset', created).length, 1)
    assert.equal(byData(renderSection(store), 'data-moa-preset-actions', created).length, 1)
    store.removePreset(created)
    assert.equal(byData(renderSection(store), 'data-moa-preset', 'easyCN').length, 1)
    assert.equal(store.getSnapshot().draft.presets.find(preset => preset.id === 'second').label, 'Edited unsaved')
  })
})

test('both locales are complete and every rendered key exists', async () => {
  const locales = client.LOCALES
  assert.deepEqual(Object.keys(locales.zh).sort(), Object.keys(locales.en).sort())
  for (const [key, value] of Object.entries(locales.zh)) {
    assert.equal(typeof value, 'string', `zh.${key} must be text`)
    assert.notEqual(value.trim(), '', `zh.${key} must not be empty`)
  }
  for (const [key, value] of Object.entries(locales.en)) {
    assert.equal(typeof value, 'string', `en.${key} must be text`)
    assert.notEqual(value.trim(), '', `en.${key} must not be empty`)
  }

  // Every key used through t('...') in the shipped source must exist.
  const keys = new Set()
  for (const match of loaded.source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9_]*)'\)/g)) keys.add(match[1])
  for (const key of keys) assert.ok(Object.hasOwn(locales.zh, key), `missing zh locale for t('${key}')`)
  for (const code of ['routeRequired', 'defaultDisabled', 'noPresets', 'fanoutInvalid', 'maxTokensInvalid', 'reviewTimeoutInvalid', 'labelRequired', 'invalidId', 'duplicateId', 'unverified']) {
    assert.ok(Object.hasOwn(locales.zh, code), `missing validation text for ${code}`)
  }
  // Copy for removed controls is gone rather than orphaned.
  for (const removed of ['referenceSchedule', 'maxConcurrency', 'queueBudgetMs', 'referenceTimeoutMs', 'deadlineMs', 'adviceHistory', 'resetPreset']) {
    assert.equal(Object.hasOwn(locales.zh, removed), false, `${removed} must not remain in locales`)
  }

  assert.match(locales.zh.injectionHint, /并行/)
  assert.match(locales.en.injectionHint, /parallel/i)
  assert.match(locales.zh.guardHint, /工具|执行|声称/)
  assert.equal(/万能|完整防提示注入/.test(locales.zh.guardHint), false)
})

/* -------------------------------------------------------- advice node */

test('advice card defaults to a collapsed note with a brief nature label', () => {
  const tree = client.AdviceCard({
    text: 'reference material', preset: 'demo', replacesEarlier: true,
    t: (key) => client.LOCALES.zh[key],
  })
  assert.equal(tree.type, 'article')
  assert.equal(tree.props.role, 'note')
  assert.equal(tree.props['data-moa-advice'], 'demo')
  assert.equal(tree.props['data-moa-advice-form'], 'advice')
  const content = textOf(tree)
  assert.match(content, /参考意见/)
  assert.match(content, /独立建议/)
  assert.match(content, /已替换上一版/)
  assert.doesNotMatch(content, /reference material|不是用户指令|已执行操作/)
  assert.equal(findAll(tree, node => node.type === 'pre').length, 0)
  assert.equal(findAll(tree, node => node.type === 'textarea').length, 0)
  const [toggle] = findAll(tree, node => node.type === 'button')
  assert.equal(toggle.props['aria-expanded'], false)
  assert.equal(textOf(toggle), client.LOCALES.zh.adviceExpand)
})

test('the end-of-turn review card has its own title and defaults to collapsed', () => {
  const t = (key) => client.LOCALES.zh[key]
  const advice = client.AdviceCard({ text: 'advice body', preset: 'demo', form: 'advice', t })
  const review = client.AdviceCard({ text: 'review body', preset: 'demo', form: 'review', t })
  assert.equal(review.type, 'article')
  assert.equal(review.props['data-moa-advice-form'], 'review')
  assert.equal(advice.props['data-moa-advice-form'], 'advice')
  assert.match(textOf(review), /结束前审阅/)
  assert.match(textOf(review), /QA 意见/)
  assert.doesNotMatch(textOf(review), /参考意见|review body|不是用户指令|已执行操作/)
  assert.match(textOf(advice), /参考意见/)
  assert.equal(findAll(review, node => node.type === 'pre').length, 0)
  const [toggle] = findAll(review, node => node.type === 'button')
  assert.equal(toggle.props['aria-expanded'], false)
  assert.equal(textOf(toggle), client.LOCALES.zh.reviewExpand)
})

test('advice and QA cards expand only opinions and can collapse again in both locales', async () => {
  const renderer = await import('../advice-renderer.js')
  const body = '### Advisor A\nActual opinion.\n\n### Advisor B\nAnother concrete finding.'
  for (const locale of ['zh', 'en']) {
    for (const form of ['advice', 'review']) {
      // Each mounted card owns persistent hook state. Clicking followed by a
      // render exercises the real toggle instead of a no-op setter stub.
      const states = []
      let cursor = 0
      const statefulReact = {
        ...createRenderingReact(),
        useState(initial) {
          const index = cursor++
          if (!Object.hasOwn(states, index)) states[index] = typeof initial === 'function' ? initial() : initial
          return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
        },
      }
      const { exports: mounted } = await loadMoaClientModule(statefulReact)
      const raw = '[Internal evidence]\nSafety preamble\nguidanceHeader\nInstruction template\n\n' + body
      const event = {
        type: 'user/message', seq: 42,
        data: { id: `${form}-${locale}`, role: 'user', content: [{ type: 'text', text: raw }], source: { kind: 'plugin:moa', form, preset: 'demo', displayText: body } },
      }
      const state = renderer.adviceState(event)
      const props = renderer.adviceViewProps(renderer.buildAdviceNode({ key: event.data.id, id: event.data.id, state }))
      const t = key => mounted.LOCALES[locale][key]
      const render = () => {
        cursor = 0
        return materialize(mounted.AdviceCard({ ...props, t }))
      }
      let tree = render()
      let [toggle] = findAll(tree, node => node.type === 'button')
      assert.equal(toggle.props['aria-expanded'], false)
      assert.equal(textOf(toggle), t(form === 'review' ? 'reviewExpand' : 'adviceExpand'))
      assert.equal(findAll(tree, node => node.type === 'pre').length, 0)
      toggle.props.onClick()
      tree = render()
      ;[toggle] = findAll(tree, node => node.type === 'button')
      assert.equal(toggle.props['aria-expanded'], true)
      assert.equal(textOf(toggle), t('adviceCollapse'))
      const [expanded] = findAll(tree, node => node.type === 'pre')
      assert.equal(textOf(expanded), body)
      assert.doesNotMatch(textOf(tree), /Internal evidence|Safety preamble|guidanceHeader|Instruction template/)
      assert.equal(state.text, raw, 'the complete model message survives display filtering')
      assert.equal(event.data.content[0].text, raw)
      toggle.props.onClick()
      tree = render()
      assert.equal(findAll(tree, node => node.type === 'pre').length, 0)
      assert.equal(findAll(tree, node => node.type === 'button')[0].props['aria-expanded'], false)
    }
  }
})

test('advice definition matches only the plugin form and leaves ordinary chat nodes alone', async () => {
  const definition = client.__adviceDefinitionForTest
  assert.equal(definition, undefined, 'the browser entry stays lazy')
  const renderer = await import('../advice-renderer.js')
  const advice = { role: 'user', content: 'x', source: { kind: 'plugin:moa', form: 'advice' } }
  const review = { role: 'user', content: 'x', source: { kind: 'plugin:moa', form: 'review' } }
  const retired = { role: 'user', content: 'x', source: { kind: 'plugin:moa', form: 'retired' } }
  const other = { role: 'user', content: 'x', source: { kind: 'plugin:other', form: 'advice' } }
  const match = renderer.createAdviceNodeDefinition().match['user/message']
  assert.equal(match({ type: 'user/message', data: { ...advice, id: 'a' } })?.id, 'a')
  assert.equal(match({ type: 'user/message', data: { ...review, id: 'r' } })?.id, 'r')
  assert.equal(match({ type: 'user/message', data: { ...retired, id: 't' } }), null)
  assert.equal(match({ type: 'user/message', data: { ...other, id: 'b' } }), null)
})

test('generated browser renderer is an official package-local chunk', async () => {
  const source = await readFile(new URL('../client.advice-renderer.js', import.meta.url), 'utf8')
  const window = { __ModuleLoader__: { load(entry) { window.entry = entry } } }
  new Function('window', source)(window)
  assert.equal(window.entry.id, 'dsh-better-moa')
  assert.equal(window.entry.chunk, 'client.advice-renderer.js')
  assert.equal(window.entry.factory.length, 0)
  const module = { exports: {} }
  const exports = window.entry.factory.call({ module }, module)
  assert.equal(typeof exports.registerAdviceDefinition, 'function')
  assert.equal(typeof exports.registerAdviceRenderer, 'function')
  assert.equal(typeof exports.adviceDisplayText, 'function')
  const displayText = '### Browser advisor\nActual opinion.'
  const state = { text: 'Internal preamble\nguidanceHeader\nInstruction template\n\n### Wrong template heading', source: { displayText } }
  assert.equal(exports.adviceViewProps({ data: state }).text, displayText)
  assert.equal(exports.adviceDisplayText('Legacy preamble\n\n' + displayText), displayText)
  assert.equal(state.text.includes('Internal preamble'), true)
})


test('shipped metadata describes a user-owned preset table, not a seven-preset default', async () => {
  for (const locale of ['zh', 'en']) {
    const raw = await readFile(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    assert.ok(parsed.meta?.title)
    assert.ok(parsed.meta?.description)
    assert.equal(typeof parsed.meta.description, 'string')
    assert.doesNotMatch(parsed.meta.description, /七档|seven preset/i)
    assert.doesNotMatch(parsed.meta.description, /默认\s*easyCN|defaults? to easyCN/i)
    assert.ok(parsed.guidance?.header)
    assert.ok(parsed.guidance?.instruction)
  }
})