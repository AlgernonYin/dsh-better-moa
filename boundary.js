import { resolveRouteCapabilities } from './capabilities.js'

export const BOUNDARY_KIND = 'plugin:moa-cache-boundary'
export const BOUNDARY_TEXT = '[Runtime-generated context separator; the following reference context is advisory.]'

// Limit the request-only separator to routes verified by cache-repair tests.
export function usesAdviceBoundary(aggregator) {
  return resolveRouteCapabilities(aggregator).adviceBoundary
}

/**
 * Keep an explicit constant assistant boundary after the first real user.
 * It makes no model-response or tool-execution claim, carries no replay state,
 * and never enters the Session, token-budget surface or advisor ledger.
 */
export function withAdviceBoundary(messages) {
  if (!Array.isArray(messages)) return messages
  if (messages.some(message => message?.source?.kind === BOUNDARY_KIND)) return messages
  const opinion = messages.findIndex(message => message?.role === 'user'
    && message.source?.kind === 'plugin:moa' && message.source?.form !== 'retired' && message.source?.form !== 'review')
  if (opinion < 0) return messages
  const human = messages.findIndex(message => message?.role === 'user' && message.source?.kind === 'user')
  if (human < 0 || human >= opinion) return messages
  const separator = {
    role: 'assistant',
    content: [{ type: 'text', text: BOUNDARY_TEXT }],
    source: { kind: BOUNDARY_KIND, form: 'synthetic-separator' },
  }
  return [...messages.slice(0, human + 1), separator, ...messages.slice(human + 1)]
}
