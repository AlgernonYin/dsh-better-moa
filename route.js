export const PROVIDER_ID = 'moa'

function routeFrom(data, source, descriptor = false) {
  if (!data || typeof data !== 'object') return undefined
  const provider = descriptor ? data.agentProvider : data.provider
  const model = descriptor ? data.agentModel : data.model
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model) return undefined
  const route = { provider, model }
  if (data.reasoningEffort !== undefined) route.reasoningEffort = data.reasoningEffort
  if (data.maxTokens !== undefined) route.maxTokens = data.maxTokens
  route.source = source
  return route
}

function eventData(event) {
  return event?.data ?? event
}

function headerRoute(session) {
  try {
    if (typeof session?.requestHeader !== 'function') return undefined
    return routeFrom(session.requestHeader()?.config, 'header')
  } catch {
    return undefined
  }
}

export function resolveSessionRoute(session) {
  let descriptor
  try {
    if (typeof session?.eventAt === 'function' && Number.isFinite(session.seq)) {
      for (let index = Math.trunc(session.seq) - 1; index >= 0; index -= 1) {
        try {
          const event = session.eventAt(index)
          const data = eventData(event)
          if (event?.type === 'model/selection') {
            const route = routeFrom(data, 'selection')
            if (route) return route
          } else if (event?.type === 'request/header') {
            const route = routeFrom(data?.header?.config, 'header')
            if (route) return route
          } else if (!descriptor && event?.type === 'subagent/descriptor') {
            descriptor = routeFrom(data, 'descriptor', true)
          }
        } catch {
          // A malformed event must not hide older route facts.
        }
      }
    }
  } catch {
    // Session accessors are host-provided and may be unavailable during teardown.
  }
  return descriptor || headerRoute(session)
}

export function resolveMoaPreset(session, presets) {
  const route = resolveSessionRoute(session)
  if (!route || route.provider !== PROVIDER_ID || !presets.has(route.model)) return null
  return { route, preset: presets.get(route.model) }
}
