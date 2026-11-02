import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_PRESET_ID } from './presets.js'
import { normalizeRouteCapabilities } from './capabilities.js'
import { normalizeDecision, normalizeScheduler, schedulerFromDecision } from './scheduler.js'

// This dictionary is the complete user-owned table, not a patch over bundled recipes.
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  providerName: Schema.string().default('Better MoA'),
  defaultPreset: Schema.string().default(DEFAULT_PRESET_ID).volatile(),
  disabledPresets: Schema.array(Schema.string()).default([]).volatile(),
  presetOverrides: Schema.dict(Schema.any()).default({}).description('User-defined complete MoA preset table. Aggregator/reference capabilities accept nativeSession, requestReconciliation and adviceBoundary booleans; explicit false overrides compatibility detection.').volatile(),
  scheduler: Schema.any().description('Legacy shared judge; migrated to decision.').volatile(),
  decision: Schema.any().description('Optional decision model and shared smart-cadence gates.').volatile(),
  // Legacy values remain loadable; normalization enforces parallel calls/latest advice.
  referenceSchedule: Schema.union(['serial', 'parallel', 'bounded']).default('parallel').volatile(),
  maxConcurrency: Schema.number().step(1).min(1).default(1).volatile(),
  queueBudgetMs: Schema.number().step(1).min(0).max(1800000).default(0).volatile(),
  referenceTimeoutMs: Schema.number().step(1).min(1000).max(1800000).default(600000).volatile(),
  deadlineMs: Schema.number().step(1).min(1000).max(1800000).default(900000).volatile(),
  reviewTimeoutMs: Schema.number().step(1).min(1000).max(120000).default(60000).volatile(),
  guardEnabled: Schema.boolean().default(true).volatile(),
  adviceHistory: Schema.union(['latest', 'all']).default('latest').volatile(),
  persistentTags: Schema.array(Schema.string()).default(['*']).volatile(),
  maxDialogueChars: Schema.number().step(1).min(10000).max(10000000).default(4000000).volatile(),
  maxMessageChars: Schema.number().step(1).min(1000).max(200000).default(24000).volatile(),
  maxTranscriptChars: Schema.number().step(1).min(10000).max(10000000).default(4000000).volatile(),
  maxAdviceChars: Schema.number().step(1).min(1000).max(100000).default(20000).volatile(),
  statusTool: Schema.boolean().default(true),
  probeTool: Schema.boolean().default(true),
  recordRuns: Schema.number().step(1).min(1).max(200).default(40).volatile(),
})

export const DEFAULT_CONFIG = {
  enabled: true, providerName: 'Better MoA', defaultPreset: DEFAULT_PRESET_ID,
  disabledPresets: [], presetOverrides: {}, referenceSchedule: 'parallel', maxConcurrency: 1,
  queueBudgetMs: 0, referenceTimeoutMs: 600000, deadlineMs: 900000, reviewTimeoutMs: 60000,
  guardEnabled: true, adviceHistory: 'latest', persistentTags: ['*'],
  // Char ceilings only; each reference's own token budget is the binding limit.
  maxDialogueChars: 4000000, maxMessageChars: 24000, maxTranscriptChars: 4000000,
  maxAdviceChars: 20000, statusTool: true, probeTool: true, recordRuns: 40,
}
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const TEXT_FIELDS = ['label', 'description', 'referenceSystem', 'referenceSystemSuffix', 'guidanceHeader', 'guidanceInstruction', 'hermesSource']

export function unwrapVolatile(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return value
  if (typeof value.get === 'function' && VOLATILE_WRITE in value) return unwrapVolatile(value.get(), seen)
  if (seen.has(value)) return value
  if (Array.isArray(value)) {
    seen.add(value)
    const result = value.map(item => unwrapVolatile(item, seen))
    seen.delete(value)
    return result
  }
  if (!isRecord(value)) return value
  seen.add(value)
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapVolatile(item, seen)]))
  seen.delete(value)
  return result
}

export function normalizeConfig(raw) {
  const unwrapped = unwrapVolatile(raw)
  const input = isRecord(unwrapped) ? unwrapped : {}
  const config = { ...DEFAULT_CONFIG, ...input }
  config.presetOverrides = normalizePresetOverrides(input.presetOverrides)
  config.disabledPresets = Array.isArray(input.disabledPresets)
    ? [...new Set(input.disabledPresets.filter(id => typeof id === 'string' && Object.hasOwn(config.presetOverrides, id)))] : []
  config.persistentTags = Array.isArray(input.persistentTags) ? [...input.persistentTags] : ['*']
  config.referenceSchedule = 'parallel'
  config.adviceHistory = 'latest'
  config.referenceTimeoutMs = boundedMs(input.referenceTimeoutMs, DEFAULT_CONFIG.referenceTimeoutMs)
  config.deadlineMs = boundedMs(input.deadlineMs, DEFAULT_CONFIG.deadlineMs)
  // The end-of-turn QA review is advisory: it gets its own, much shorter budget.
  config.reviewTimeoutMs = numberOr(input.reviewTimeoutMs, DEFAULT_CONFIG.reviewTimeoutMs, 1000, 120000)
  config.queueBudgetMs = numberOr(input.queueBudgetMs, 0, 0, 1800000)
  const available = Object.keys(config.presetOverrides).filter(id => !config.disabledPresets.includes(id))
  config.defaultPreset = available.includes(input.defaultPreset) ? input.defaultPreset : available[0] || ''
  // Migration: prefer the default preset's old judge, then an active smart preset.
  // Once a global value is saved, legacy per-preset values can never override it.
  const legacy = config.presetOverrides[config.defaultPreset]?.scheduler
    || available.map(id => config.presetOverrides[id]).find(preset => preset.fanout === 'smart' && preset.scheduler)?.scheduler
    || Object.values(config.presetOverrides).find(preset => preset.scheduler)?.scheduler
  const decisionInput = isRecord(input.decision) ? input.decision : isRecord(input.scheduler) ? input.scheduler : legacy
  config.decision = normalizeDecision(decisionInput)
  // Keep the established preset.scheduler/advice.js runtime contract while settings use decision.
  config.scheduler = schedulerFromDecision(config.decision)
  return config
}

export function normalizePresetOverrides(raw) {
  const output = {}
  for (const [id, value] of Object.entries(isRecord(raw) ? raw : {})) {
    if (!SAFE_ID.test(id) || RESERVED_IDS.has(id) || !isRecord(value)) continue
    const preset = { fanout: normalizeFanout(value.fanout) }
    for (const key of TEXT_FIELDS) if (typeof value[key] === 'string') preset[key] = value[key]
    if (isRecord(value.aggregator)) {
      preset.aggregator = normalizeModel(value.aggregator)
      // Legacy presets stored an effort that was never applied; only an explicit pin is honoured.
      preset.aggregator.effortMode = value.aggregator.effortMode === 'fixed' && preset.aggregator.reasoningEffort ? 'fixed' : 'follow'
    }
    if (isRecord(value.scheduler)) preset.scheduler = normalizeScheduler(value.scheduler)
    if (Array.isArray(value.references)) {
      const used = new Set()
      preset.references = value.references.filter(isRecord).map((item, index) => {
        const reference = normalizeReferenceOverride(item)
        let candidate = reference.id && SAFE_ID.test(reference.id) && !RESERVED_IDS.has(reference.id) ? reference.id : `ref-${index + 1}`
        const stem = candidate
        for (let suffix = 2; used.has(candidate); suffix++) candidate = `${stem}-${suffix}`
        used.add(candidate)
        reference.id = candidate
        reference.label ||= `Ref${index + 1}`
        return reference
      })
    }
    // One sealed batch per round: 'wait' blocks the step until every reference settled
    // or timed out; 'background' delivers that same single batch at a later step.
    preset.delivery = DELIVERY_MODES.has(value.delivery) ? value.delivery : legacyDelivery(preset.references)
    for (const key of ['referenceTimeoutMs', 'deadlineMs']) {
      if (Number.isFinite(value[key])) preset[key] = boundedMs(value[key], DEFAULT_CONFIG[key])
    }
    if (Number.isFinite(value.referenceMaxTokens) && value.referenceMaxTokens > 0) preset.referenceMaxTokens = Math.floor(value.referenceMaxTokens)
    output[id] = preset
  }
  return output
}

function normalizeModel(value) {
  const model = {}
  for (const key of ['provider', 'model', 'reasoningEffort']) if (typeof value[key] === 'string' && value[key].trim()) model[key] = value[key].trim()
  if (Number.isFinite(value.maxTokens) && value.maxTokens > 0) model.maxTokens = Math.floor(value.maxTokens)
  const capabilities = normalizeRouteCapabilities(value.capabilities)
  if (Object.keys(capabilities).length) model.capabilities = capabilities
  return model
}

function normalizeReferenceOverride(value) {
  const reference = normalizeModel(value)
  for (const key of ['id', 'label', 'cacheScope', 'systemSuffix']) if (typeof value[key] === 'string') reference[key] = value[key].trim()
  for (const key of ['enabled', 'async', 'persistent', 'continueOnStop']) if (typeof value[key] === 'boolean') reference[key] = value[key]
  if (Number.isFinite(value.timeoutMs)) reference.timeoutMs = boundedMs(value.timeoutMs, DEFAULT_CONFIG.referenceTimeoutMs)
  // Optional native context window (tokens) for routes whose catalog entry is missing or wrong.
  if (Number.isFinite(value.contextWindow) && value.contextWindow > 0) {
    reference.contextWindow = Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, Math.floor(value.contextWindow)))
  }
  // Optional session cache policy. Only the exact literals are kept; anything else (including 'auto') means automatic.
  if (SESSION_POLICIES.has(value.sessionPolicy)) reference.sessionPolicy = value.sessionPolicy
  return reference
}

export const DELIVERY_MODES = new Set(['wait', 'background'])
// Explicit reference.sessionPolicy values. An absent key is the automatic per-route policy.
export const SESSION_POLICIES = new Set(['stable', 'rotate'])
export const MIN_CONTEXT_WINDOW = 8192
export const MAX_CONTEXT_WINDOW = 10000000

// Legacy presets expressed delivery per reference; only an all-async panel ran in the background.
export function legacyDelivery(references) {
  const enabled = (Array.isArray(references) ? references : []).filter(reference => reference?.enabled !== false)
  return enabled.length > 0 && enabled.every(reference => reference.async === true) ? 'background' : 'wait'
}

export function buildPresetTable(config) {
  const table = new Map()
  const entries = normalizePresetOverrides(config.presetOverrides)
  for (const [id, source] of Object.entries(entries)) {
    if (config.disabledPresets?.includes(id) || !validRoute(source.aggregator) || source.aggregator.provider === 'moa') continue
    const references = (source.references || [])
      .filter(reference => reference.enabled !== false && validRoute(reference) && reference.provider !== 'moa')
      .map(reference => ({ ...reference }))
    table.set(id, {
      ...source, id, label: source.label || id, aggregator: { ...source.aggregator }, references,
      fanout: normalizeFanout(source.fanout),
      scheduler: normalizeScheduler(isRecord(config.scheduler) ? config.scheduler : source.scheduler),
      referenceTimeoutMs: boundedMs(source.referenceTimeoutMs, config.referenceTimeoutMs),
      deadlineMs: boundedMs(source.deadlineMs, config.deadlineMs),
    })
  }
  return table
}

const FANOUT_MODES = new Set(['user_turn', 'user_turn_end', 'smart'])

export function normalizeFanout(value) {
  const fanout = String(value || 'user_turn').trim().toLowerCase()
  if (FANOUT_MODES.has(fanout)) return fanout
  // "Every iteration" was the same schedule as every_n:1 and is folded into it.
  if (fanout === 'per_iteration') return 'every_n:1'
  const match = /^every_n:(\d+)$/.exec(fanout)
  if (!match) return 'user_turn'
  return `every_n:${Math.min(999, Math.max(1, Number(match[1])))}`
}

export function resolveConcurrency(_config, preset) {
  return Math.max(1, preset.references.length)
}
function validRoute(value) {
  return isRecord(value) && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
}
function boundedMs(value, fallback) { return numberOr(value, fallback, 1000, 1800000) }
function numberOr(value, fallback, min, max) { return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback }
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }
