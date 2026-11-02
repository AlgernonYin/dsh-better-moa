// Public route options live on aggregator/reference.capabilities. These are
// transport guarantees supplied by the operator, not inferred model features:
// - nativeSession: upstream retains a conversation under sessionId.
// - requestReconciliation: upstream validates the FULL request and rebuilds its
//   transcript after edits/rebases. Only such native routes may keep a stable
//   outer id automatically. A generic stateful TUI is not sufficient evidence.
// - adviceBoundary: opt into the request-only synthetic cache separator.
// Explicit booleans (including false) override compatibility defaults. Unknown
// keys and non-booleans are discarded; absence means compatibility detection.
export function normalizeRouteCapabilities(value) {
  const result = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const key of ['nativeSession', 'requestReconciliation', 'adviceBoundary']) {
    if (Object.hasOwn(value, key) && typeof value[key] === 'boolean') result[key] = value[key]
  }
  return result
}

export function resolveRouteCapabilities(route = {}) {
  const provider = route?.provider || ''
  const model = route?.model || ''
  // Compatibility detection only, not recommended personal defaults. Unknown
  // native transports should explicitly set nativeSession rather than rely on
  // naming; never broaden reconciliation to every route matching these names.
  const nativeSession = provider === 'deepseek-official' || /claude-tui|\/session/i.test(`${provider}/${model}`)
  // Reconciliation and cache separators require explicit transport guarantees;
  // provider aliases and model names are not evidence of those capabilities.
  return {
    nativeSession,
    requestReconciliation: false,
    adviceBoundary: false,
    ...normalizeRouteCapabilities(route?.capabilities),
  }
}

export function stableReferenceTransport(route) {
  if (route?.sessionPolicy === 'rotate') return false
  if (route?.sessionPolicy === 'stable') return true
  const capabilities = resolveRouteCapabilities(route)
  return !capabilities.nativeSession || capabilities.requestReconciliation
}

export function referenceTransportId(plan, route) {
  const base = `moa-ref-${plan.key.slice(0, 32)}`
  const capabilities = resolveRouteCapabilities(route)
  return capabilities.nativeSession && capabilities.requestReconciliation && route?.sessionPolicy !== 'rotate'
    ? base : `${base}-${plan.transportEpoch.slice(0, 12)}`
}
