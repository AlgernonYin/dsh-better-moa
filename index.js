/**
 * dsh-better-moa — Hermes-style Mixture of Agents for DeepSeek Harness.
 *
 * The virtual `moa/<preset>` model only routes the acting agent to a real aggregator. Reference
 * fan-out lives in `agent/pre-step`: advisor output is filtered, then committed to the session log
 * as a user message with source `plugin:moa`. The log therefore remains the source of truth, and
 * subsequent tool-loop steps retain the same advice without another fan-out.
 */
import { createHash } from 'node:crypto'
import { Config, buildPresetTable, normalizeConfig } from './config.js'
import { createAdvicePlacement, layoutAdviceForAggregator } from './layout.js'
import { withAdviceBoundary, usesAdviceBoundary } from './boundary.js'
import { createMoaAdapter } from './adapter.js'
import { createAdviceEngine } from './advice.js'
import { createScheduler } from './scheduler.js'
import { schedulerInput } from './scheduler-openai.js'
import { schedulerContext, planContextParts } from './scheduler-context.js'
import { createDialogueStore } from './dialogue.js'
import { createHistoryProjection, readAdvisorHistory } from './history.js'
import { resolveMoaPreset } from './route.js'
import { replaceAdviceInSurface } from './surface.js'

export const name = 'dsh-better-moa'
export const inject = ['llm', 'credentials']
export { Config }

const PROVIDER_ID = 'moa'
const PLUGIN_VERSION = '0.9.0'

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = createLogger(ctx)
  if (!config.enabled) log?.info?.('[moa] disabled by configuration; settings remain available')

  const runtime = ctx.llm
  if (!runtime || typeof runtime.stream !== 'function' || typeof runtime.registerAdapter !== 'function') {
    throw new Error('[moa] the llm service is unavailable')
  }
  const presets = buildPresetTable(config)
  if (!presets.size) log?.warn?.('[moa] no usable presets; the settings page can restore them')
  if (!presets.has(config.defaultPreset)) config.defaultPreset = presets.keys().next().value || ''

  const state = {
    config,
    presets,
    ready: null,
    engine: null,
    storageKind: 'memory',
    refresh: refreshConfig,
  }
  const adapter = createMoaAdapter({
    runtime,
    presets,
    providerName: config.providerName,
    log,
    refresh: refreshConfig,
    isEnabled: () => config.enabled,
    config,
    getBudgetScope: () => safeGet(ctx, 'biliExplicitBudgetScope'),
  })
  ctx.effect(() => runtime.registerAdapter([PROVIDER_ID], adapter))
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.effect(() => projectionCtx.sessionProjections.register(createHistoryProjection()))
  })

  state.ready = initialize()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    refreshConfig()
    if (decision.kind !== 'enter' || payload.signal?.aborted) return decision
    const resolved = resolveMoaPreset(payload.agent.session, presets)
    if (!resolved) {
      // Do not let a reference started under MoA leak advice into a session that switched models.
      state.engine?.cancel(payload.agent.session.header.id, 'session left the MoA route')
      return decision
    }
    const current = await state.ready
    const admitted = await current.engine.preStep(payload, () => Promise.resolve(decision))
    return replaceAdviceInSurface(payload.agent.session, admitted)
  }, { prepend: true })

  // "每轮会话开始和结束": one QA review before the turn closes. Serial hook, so the
  // loop waits for it; an injected REVISE review keeps the same turn open.
  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      refreshConfig()
      if (payload.signal?.aborted || !resolveMoaPreset(payload.agent.session, presets)) return
      const current = await state.ready
      await current.engine.turnStopping(payload)
    } catch (error) {
      log?.warn?.(`[moa] turn-stopping review skipped: ${error?.message || error}`)
    }
  })

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: true }))
  })

  const tools = safeGet(ctx, 'tools')
  if (tools && typeof tools.register === 'function') {
    if (config.statusTool) ctx.effect(() => tools.register(createStatusTool(state, ctx)))
    if (config.probeTool) ctx.effect(() => tools.register(createProbeTool(state)))
  }
  const commands = safeGet(ctx, 'commands')
  if (commands && typeof commands.register === 'function') {
    ctx.effect(() => commands.register(createMoaCommand(state)))
  }

  ctx.effect(() => () => {
    return state.ready.then(async (current) => {
      await current.engine.close()
      await current.store.close()
    }).catch((error) => {
      log?.warn?.(`[moa] failed to close advisor storage: ${errorMessage(error)}`)
    })
  })

  function refreshConfig() {
    const next = normalizeConfig(rawConfig)
    const before = JSON.stringify(config)
    const after = JSON.stringify(next)
    if (before === after) return false
    const routingBefore = JSON.stringify({
      disabledPresets: config.disabledPresets,
      presetOverrides: config.presetOverrides,
      scheduler: config.scheduler,
    })
    const routingAfter = JSON.stringify({
      disabledPresets: next.disabledPresets,
      presetOverrides: next.presetOverrides,
      scheduler: next.scheduler,
    })
    Object.assign(config, next)
    const nextPresets = buildPresetTable(config)
    presets.clear()
    for (const [id, preset] of nextPresets) presets.set(id, preset)
    if (!presets.has(config.defaultPreset)) config.defaultPreset = presets.keys().next().value || ''
    if (routingBefore !== routingAfter) state.engine?.cancelAll?.('MoA preset configuration changed')
    return true
  }

  async function initialize() {
    let kv
    try {
      const storage = safeGet(ctx, 'storage')
      const backendName = storage?.backend?.names?.()[0]
      const backend = backendName ? storage.backend.get(backendName) : undefined
      if (backend?.kv) {
        kv = await backend.kv.open({
          name: 'moa_dialogue',
          version: 1,
          tables: ['dialogue', 'cadence', 'window'],
          hasGlobal: false,
          layout: 'per-record',
        })
        state.storageKind = backendName
      }
    } catch (error) {
      log?.warn?.(`[moa] persistent advisor storage unavailable; using memory: ${errorMessage(error)}`)
    }
    const store = createDialogueStore({
      kv,
      get maxChars() { return config.maxDialogueChars },
      get persistentTags() { return config.persistentTags },
    })
    try {
      await store.load()
    } catch (error) {
      log?.warn?.(`[moa] could not load advisor checkpoints: ${errorMessage(error)}`)
    }
    const engine = createAdviceEngine({
      runtime, store, presets, config, log, kv,
      scheduler: createScheduler({ runtime, log, credentials: safeGet(ctx, 'credentials') }),
      historyFor(session) {
        const history = readAdvisorHistory(safeGet(ctx, 'sessionProjections'), session)
        state.historyKind = history.source
        state.historyDegradedReason = history.reason ?? null
        return history.messages
      },
    })
    state.engine = engine
    try {
      await engine.load()
    } catch (error) {
      log?.warn?.(`[moa] could not load fan-out cadence: ${errorMessage(error)}`)
    }
    return { engine, store }
  }

  log?.info?.(
    `[moa] registered dsh-better-moa v${PLUGIN_VERSION}; presets: ${[...presets.keys()].join(', ')}`,
  )
}


function createStatusTool(state, ctx) {
  return {
    name: 'moa_status',
    description: 'Show Better MoA presets, advisor storage, cadence state and recent reference fan-out runs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'sync-client'] },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      state.refresh?.()
      const current = await state.ready
      const modules = safeGet(ctx, 'clientModules')
      let client = null
      let clientSync = null
      if (modules) {
        try {
          const graph = typeof modules.graph === 'function' ? modules.graph() : null
          const indexedIds = Array.isArray(graph?.entryIds)
            ? graph.entryIds
            : Array.isArray(graph?.entries)
              ? graph.entries.map((entry) => entry?.id).filter((id) => typeof id === 'string')
              : []
          client = {
            loaded: typeof modules.clientPath === 'function' && Boolean(modules.clientPath(name)),
            path: typeof modules.clientPath === 'function' ? modules.clientPath(name) ?? null : null,
            rev: graph?.rev ?? null,
            indexed: indexedIds.includes(name),
          }
          if (args?.action === 'sync-client') clientSync = syncClientModules(ctx, modules)
        } catch (error) {
          client = { error: errorMessage(error) }
        }
      }
      return sanitizeJson({
        plugin: name,
        version: PLUGIN_VERSION,
        loadedFunctions: Object.fromEntries(Object.entries({
          createMoaAdapter, replaceAdviceInSurface, createAdvicePlacement,
          layoutAdviceForAggregator, withAdviceBoundary, usesAdviceBoundary,
          normalizeConfig, buildPresetTable, createAdviceEngine, createScheduler, schedulerInput, schedulerContext, planContextParts,
        }).map(([key, fn]) => [key, createHash('sha256').update(fn.toString()).digest('hex')])),
        provider: PROVIDER_ID,
        defaultPreset: state.config.defaultPreset,
        presetOrder: [...state.presets.keys()],
        storage: state.storageKind,
        history: { source: state.historyKind ?? 'not-used', reason: state.historyDegradedReason ?? null },
        config: publicConfig(state.config),
        presets: [...state.presets.values()].map(publicPreset),
        stats: current.engine.stats(),
        recentRuns: current.engine.recentRuns(),
        client,
        clientSync,
      })
    },
  }
}

function createProbeTool(state) {
  return {
    name: 'moa_probe',
    description: 'Run one end-to-end Better MoA self-check: fan out to the preset references, then call its aggregator with their guidance. Real model calls are billed.',
    parameters: {
      type: 'object',
      properties: {
        preset: { type: 'string', description: 'User-defined preset id; defaults to the configured local default. Configure a preset first on an empty installation.' },
        prompt: { type: 'string', description: 'Short diagnostic prompt.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      try {
        state.refresh?.()
        const current = await state.ready
        const result = await current.engine.probe({
          preset: args?.preset,
          prompt: args?.prompt,
        })
        return sanitizeJson(result)
      } catch (error) {
        return sanitizeJson({ ok: false, error: errorMessage(error) })
      }
    },
  }
}

function createMoaCommand(state) {
  return {
    name: 'moa',
    description: 'Inspect Better MoA, run a one-shot consultation, or clear derived advisor checkpoints.',
    input: { hint: '[status|clear|<preset> <question>]' },
    async handler(invocation) {
      try {
        state.refresh?.()
        const raw = String(invocation.rawInput || '').trim()
        const current = await state.ready
        if (!raw || raw === 'status') {
          const lines = [
            `Better MoA v${PLUGIN_VERSION}; default preset: ${state.config.defaultPreset}`,
            ...[...state.presets.values()].map((preset) => {
              const refs = preset.references.map((ref) => ref.model).join(', ')
              return `- ${preset.id}: ${preset.aggregator.model} ← ${refs} [${preset.fanout}]`
            }),
            'Select moa/<preset> in the model menu for the logged, tool-using MoA mode.',
            'Use /moa <preset> <question> for a one-shot consultation; /moa clear resets advisor checkpoints.',
          ]
          return { kind: 'success', text: lines.join('\n') }
        }
        if (raw === 'clear') {
          await current.engine.clear()
          return { kind: 'success', text: 'Better MoA advisor checkpoints, cadence and run history cleared.' }
        }
        const space = raw.indexOf(' ')
        const preset = space < 0 ? state.config.defaultPreset : raw.slice(0, space)
        const prompt = space < 0 ? raw : raw.slice(space + 1).trim()
        if (!prompt) return { kind: 'error', text: 'Usage: /moa <preset> <question>' }
        const result = await current.engine.probe({ preset, prompt })
        return {
          kind: result.ok ? 'success' : 'error',
          text: result.reply || 'The aggregator returned no text.',
        }
      } catch (error) {
        return { kind: 'error', text: errorMessage(error) }
      }
    },
  }
}

function publicPreset(preset) {
  return {
    id: preset.id,
    label: preset.label,
    description: preset.description,
    hermesSource: preset.hermesSource,
    fanout: preset.fanout,
    delivery: preset.delivery,
    aggregator: preset.aggregator,
    scheduler: preset.scheduler,
    references: preset.references.map((reference) => ({
      id: reference.id,
      provider: reference.provider,
      model: reference.model,
      label: reference.label,
      reasoningEffort: reference.reasoningEffort,
      maxTokens: reference.maxTokens,
      timeoutMs: reference.timeoutMs,
      contextWindow: reference.contextWindow,
      sessionPolicy: reference.sessionPolicy,
      async: reference.async === true,
      persistent: reference.persistent !== false,
      continueOnStop: reference.continueOnStop ?? 'auto',
      cacheScope: reference.cacheScope,
      systemSuffix: reference.systemSuffix,
    })),
    referenceMaxTokens: preset.referenceMaxTokens,
    referenceTimeoutMs: preset.referenceTimeoutMs,
    deadlineMs: preset.deadlineMs,
  }
}

function publicConfig(config) {
  return {
    enabled: config.enabled,
    providerName: config.providerName,
    defaultPreset: config.defaultPreset,
    disabledPresets: config.disabledPresets,
    presetOverrides: config.presetOverrides,
    scheduler: config.scheduler,
    decision: config.decision,
    referenceSchedule: config.referenceSchedule,
    adviceHistory: config.adviceHistory,
    maxConcurrency: config.maxConcurrency,
    queueBudgetMs: config.queueBudgetMs,
    referenceTimeoutMs: config.referenceTimeoutMs,
    deadlineMs: config.deadlineMs,
    reviewTimeoutMs: config.reviewTimeoutMs,
    guardEnabled: config.guardEnabled,
    persistentTags: config.persistentTags,
    maxDialogueChars: config.maxDialogueChars,
    maxMessageChars: config.maxMessageChars,
    maxTranscriptChars: config.maxTranscriptChars,
    maxAdviceChars: config.maxAdviceChars,
  }
}

function sanitizeJson(value) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) {
    const items = []
    for (const item of value) {
      const next = sanitizeJson(item)
      if (next !== undefined) items.push(next)
    }
    return items
  }
  if (type === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const next = sanitizeJson(item)
      if (next !== undefined) out[key] = next
    }
    return out
  }
  return undefined
}

function syncClientModules(ctx, modules) {
  const loader = ctx.loader ?? safeGet(ctx, 'loader') ?? modules.ctx?.loader
  const entries = []
  if (loader && typeof loader.entries === 'function') {
    for (const entry of loader.entries()) {
      const entryName = entry?.options?.name
      if (typeof entryName === 'string' && entryName.includes('better-moa')) entries.push(entryName)
    }
  }
  const packageNames = new Set()
  const removedKeys = []
  if (modules.pkgMeta instanceof Map) {
    for (const key of [...modules.pkgMeta.keys()]) {
      if (typeof key === 'string' && key.includes('better-moa')) {
        modules.pkgMeta.delete(key)
        removedKeys.push(key)
      }
    }
  }
  if (modules.sources instanceof Map) {
    for (const source of modules.sources.values()) {
      if (typeof source?.packageName === 'string') packageNames.add(source.packageName)
    }
  }
  for (const entryName of entries) {
    modules.dirty.add(entryName)
    modules.pkgMeta.delete(modules.sourceKey?.(entryName, ctx.baseUrl) ?? '')
  }
  const errors = []
  const onError = (error) => errors.push(errorMessage(error))
  if (typeof modules.flush === 'function') modules.flush(onError)
  // Loader reconciliation keeps the same source record. Publish changed bundle
  // bytes through the host rebuild hook so package-local chunks get a new URL.
  if (typeof modules.rebuilt === 'function') {
    try { modules.rebuilt(name) } catch (error) { onError(error) }
  }
  const table = modules.table instanceof Map ? [...modules.table.keys()] : []
  const graph = typeof modules.graph === 'function' ? modules.graph() : null
  return {
    ok: errors.length === 0,
    loaderEntryNames: entries,
    packageCount: packageNames.size,
    removedKeys,
    tableCount: table.length,
    graphRev: graph?.rev ?? null,
    graphHasMoa: Array.isArray(graph?.entries) ? graph.entries.some((entry) => entry?.id === name) : null,
    errors,
  }
}

function safeGet(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
  } catch {
    return undefined
  }
}

function createLogger(ctx) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('moa') : ctx.logger
    return logger && typeof logger.info === 'function' ? logger : undefined
  } catch {
    return undefined
  }
}

function errorMessage(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  return String(error.message || error.code || error)
}

