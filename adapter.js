import { randomUUID } from 'node:crypto'
import { PROVIDER_ID } from './route.js'
import { adviceRouteKey, sha256 } from './transcript.js'
import { layoutAdviceForAggregator } from './layout.js'
import { usesAdviceBoundary, withAdviceBoundary } from './boundary.js'
import { resolveRouteCapabilities } from './capabilities.js'

function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function errorMessage(error) { return !error ? 'unknown error' : typeof error === 'string' ? error : String(error.message || error.code || error) }
function unknownPreset(presets, model) {
  return new Error(`[moa] unknown MoA preset "${model}". Available presets: ${[...presets.keys()].join(', ') || '(none)'}`)
}
function mirroredCapabilities(info) {
  const mirror = {}
  if (!info) return mirror
  for (const key of ['context', 'defaultMaxTokens', 'reasoning', 'inputModalities', 'systemPromptUpdate', 'toolUpdate']) {
    if (info[key] !== undefined) mirror[key] = key === 'inputModalities' && Array.isArray(info[key]) ? [...info[key]] : info[key]
  }
  return mirror
}

export function wrapReplayState(replayState, aggregator, scope) {
  if (!isRecord(replayState)) return replayState
  const { response, ...rest } = replayState
  return { ...rest, response: { moa: 1, provider: aggregator.provider, model: aggregator.model, ...(scope ? { scope } : {}), inner: response } }
}

export function unwrapReplayState(replayState, aggregator, scope) {
  if (!isRecord(replayState) || !isRecord(replayState.response)) return undefined
  const wrapper = replayState.response
  if (wrapper.moa !== 1 || wrapper.provider !== aggregator.provider || wrapper.model !== aggregator.model) return undefined
  if (scope !== undefined && wrapper.scope !== scope) return undefined
  if (!Object.prototype.hasOwnProperty.call(wrapper, 'inner')) return undefined
  const { response: _response, ...rest } = replayState
  return { ...rest, response: wrapper.inner }
}

export function rewriteMessagesForAggregator(messages, aggregator, scope) {
  if (!Array.isArray(messages)) return messages
  return messages.map(message => {
    if (message?.role !== 'assistant' || message.source?.provider !== PROVIDER_ID) return message
    const source = { ...message.source, provider: aggregator.provider, model: aggregator.model }
    if (Object.prototype.hasOwnProperty.call(source, 'replayState')) {
      const replayState = unwrapReplayState(source.replayState, aggregator, scope)
      if (replayState === undefined) delete source.replayState
      else source.replayState = replayState
    }
    return { ...message, source }
  })
}

export function createMoaAdapter({ runtime, presets, providerName = 'Better MoA', log, refresh, isEnabled, config = {}, getBudgetScope }) {
  const resolvedCache = new Map()
  const affinities = new Map()
  const nativeEpoch = randomUUID().replaceAll('-', '').slice(0, 10)
  const enabled = () => isEnabled?.() !== false
  const refreshPresets = () => { if (refresh?.()) resolvedCache.clear() }

  function presetFor(model) {
    refreshPresets()
    const preset = presets.get(model)
    if (!preset) throw unknownPreset(presets, model)
    return preset
  }

  async function resolvePreset(model, signal) {
    refreshPresets()
    if (resolvedCache.has(model)) return resolvedCache.get(model)
    const preset = presetFor(model)
    let info
    try { info = await runtime.resolveModelInfo(preset.aggregator.provider, preset.aggregator.model, signal) }
    catch (error) { log?.warn?.(`[moa] could not resolve aggregator ${preset.aggregator.provider}/${preset.aggregator.model}: ${errorMessage(error)}`) }
    const resolved = {
      provider: PROVIDER_ID, id: model, name: preset.label || preset.id || model,
      description: preset.description, inputModalities: ['text'], ...mirroredCapabilities(info),
      ...(Number.isSafeInteger(preset.aggregator.maxTokens) && preset.aggregator.maxTokens > 0
        ? { defaultMaxTokens: preset.aggregator.maxTokens } : {}),
    }
    resolvedCache.set(model, resolved)
    return resolved
  }

  function affinityFor(options, preset, messages) {
    if (!options.sessionId) return { id: options.sessionId, scope: undefined }
    const key = sha256(JSON.stringify([options.sessionId, adviceRouteKey(preset)]))
    const hashes = (messages || []).map(message => sha256(JSON.stringify([message.role, message.content])))
    const header = sha256(JSON.stringify([options.system, options.tools]))
    const previous = affinities.get(key)
    const follows = !previous || (previous.header === header && previous.hashes.length <= hashes.length
      && previous.hashes.every((hash, index) => hash === hashes[index]))
    const generation = (previous?.generation ?? 0) + (follows ? 0 : 1)
    affinities.set(key, { header, hashes, generation })
    const capabilities = resolveRouteCapabilities(preset.aggregator)
    const native = capabilities.nativeSession
    const base = `moa-agg-${key.slice(0, 36)}`
    // Keep the workspace identity only when the upstream transport is known to
    // reconcile the full request after a rewrite. Replay still expires below.
    const id = native && capabilities.requestReconciliation ? `${base}-${nativeEpoch}`
      // Non-native routes carry the MAIN session id: billion-context attributes a
      // request by options.sessionId but runs its compress/ACP tools against the
      // owning agent's session, so a private id would split the two (0.6 review).
      : native ? `${base}-${nativeEpoch}-g${generation}` : options.sessionId
    // Opaque replay still expires on every genuine rewrite, including TUI.
    return { id, scope: `${base}:${native ? nativeEpoch : 'auto'}:g${generation}` }
  }

  const adapter = {
    providerInfo() { return { id: PROVIDER_ID, name: providerName } },
    providerRetryPolicy() { return undefined },
    imageRequestPricing() { return undefined },
    imageRequestTarget() { return { width: 1568, height: 1568, maxBytes: 5 * 1024 * 1024 } },
    async listModels() {
      refreshPresets()
      if (!enabled()) return []
      return Promise.all([...presets.keys()].map(model => resolvePreset(model)))
    },
    async resolveModel(_provider, model, signal) { return resolvePreset(model, signal) },
    async prepareCall(_provider, model, signal) {
      const resolved = await resolvePreset(model, signal)
      return { model: resolved, stream: options => adapter.stream({ ...options, provider: PROVIDER_ID, model }) }
    },
    async *stream(options) {
      refreshPresets()
      if (!enabled()) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '[moa] Better MoA is disabled in settings', code: 'moa/disabled' } } }
        return
      }
      const preset = presets.get(options.model)
      if (!preset) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: unknownPreset(presets, options.model).message, code: 'moa/unknown-preset' } } }
        return
      }
      const aggregator = preset.aggregator
      const arranged = layoutAdviceForAggregator(options.messages, preset, config.adviceHistory)
      const selected = usesAdviceBoundary(aggregator) ? withAdviceBoundary(arranged) : arranged
      const affinity = affinityFor(options, preset, selected)
      // A preset budget has known provenance. Host-filled maxTokens cannot
      // distinguish a user choice from a collapsed default, so the preset wins.
      const explicitCap = Number.isSafeInteger(aggregator.maxTokens) && aggregator.maxTokens > 0
        ? aggregator.maxTokens : undefined
      const maxTokens = explicitCap === undefined ? options.maxTokens : explicitCap
      const forwarded = {
        ...options, provider: aggregator.provider, model: aggregator.model,
        messages: rewriteMessagesForAggregator(selected, aggregator, affinity.scope),
        sessionId: affinity.id,
        // Follow the session picker unless the preset explicitly pins an effort.
        reasoningEffort: aggregator.effortMode === 'fixed' && aggregator.reasoningEffort
          ? aggregator.reasoningEffort : options.reasoningEffort,
        temperature: options.temperature !== undefined ? options.temperature : aggregator.temperature,
        maxTokens,
      }
      try {
        // Keep the outer llm/stream attribution on the owning agent while the
        // native adapter retains its private transport epoch/generation. Re-entering
        // the waterfall here would replace billion-context's ambient main-session id.
        const privateTransport = affinity.id !== options.sessionId
        if (privateTransport && typeof runtime.adapterStream !== 'function') {
          throw new Error('native MoA transport requires LlmRuntime.adapterStream for correct context attribution')
        }
        const dispatch = () => privateTransport ? runtime.adapterStream.call(runtime, forwarded) : runtime.stream(forwarded)
        const budgetScope = explicitCap === undefined ? undefined : getBudgetScope?.()
        const stream = typeof budgetScope?.wrap === 'function'
          ? budgetScope.wrap({ owner: 'better-moa', maxTokens }, dispatch) : dispatch()
        for await (const chunk of stream) {
          if (chunk?.type === 'finish' && chunk.replayState !== undefined) {
            yield { ...chunk, replayState: wrapReplayState(chunk.replayState, aggregator, affinity.scope) }
          } else yield chunk
        }
      } catch (error) {
        const message = errorMessage(error)
        log?.warn?.(`[moa] aggregator call failed: ${message}`)
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `[moa] aggregator call failed: ${message}`, code: 'moa/aggregator-failed' } } }
      }
    },
  }
  return adapter
}
