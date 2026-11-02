import { createHash, randomUUID } from 'node:crypto'
import { tokenCost } from './budget.js'

const DEFAULT_EXCLUDE_KINDS = ['plugin:moa', 'time-context', 'runtime-context', 'skill-catalog', 'model-selection']
const TRUNCATION_MARKER = '\n[truncated]\n'
const WINDOW_HEADER = '\n[moa] earlier messages omitted\n'
const ANCHOR_GAP = '\n[moa] messages between the request above and the evidence below omitted\n'

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function limit(value, fallback) {
  if (value === Infinity) return Infinity
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}

function truncateHeadTail(text, maxChars) {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return ''
  if (maxChars <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, maxChars)
  const available = maxChars - TRUNCATION_MARKER.length
  let head = Math.ceil(available / 2)
  let tailStart = text.length - Math.floor(available / 2)
  if (head > 0 && /[\uD800-\uDBFF]/u.test(text[head - 1]) && /[\uDC00-\uDFFF]/u.test(text[head])) head--
  if (tailStart > 0 && /[\uDC00-\uDFFF]/u.test(text[tailStart]) && /[\uD800-\uDBFF]/u.test(text[tailStart - 1])) tailStart++
  return text.slice(0, head) + TRUNCATION_MARKER + text.slice(tailStart)
}

function argumentText(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function renderContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      if (block.text !== undefined) parts.push(String(block.text))
    } else if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name || '?'} ${argumentText(block.arguments)}]`)
    } else if (block.type === 'image') {
      parts.push('[image]')
    } else if (block.type === 'file') {
      parts.push(`[file ${block.attachment?.name ?? block.name ?? ''}]`)
    } else if (block.type === 'tool-result') {
      if (block.text !== undefined) parts.push(String(block.text))
      else if (block.content !== undefined) parts.push(renderContent(block.content))
    }
  }
  return parts.join('\n')
}

export function contentToText(content, { maxChars = 24000 } = {}) {
  return truncateHeadTail(renderContent(content), limit(maxChars, 24000))
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;')
}

function hasId(message) {
  return message?.id !== undefined && message?.id !== null
}

function serializeMessage(message, maxMessageChars) {
  const role = message.role
  const kind = message.source?.kind || role
  const rawText = renderContent(message.content)
  const wasTruncated = rawText.length > maxMessageChars
  const text = truncateHeadTail(rawText, maxMessageChars)
  const originalId = Object.hasOwn(message, 'advisorSourceId') ? message.advisorSourceId : message.id
  const id = originalId ?? sha256(`${role}\0${kind}\0${text}`).slice(0, 16)
  const serialized = `\n<source id="${escapeAttribute(id)}" role="${escapeAttribute(role)}" kind="${escapeAttribute(kind)}">\n${text}`
  return { serialized, wasTruncated, realUser: role === 'user' && message.source?.kind === 'user' }
}

function combineMessages(history, pending) {
  const base = Array.isArray(history) ? history : []
  const extra = Array.isArray(pending) ? pending : []
  const ids = new Set(base.filter(hasId).map((message) => message.id))
  const combined = [...base]
  for (const message of extra) {
    if (!message || typeof message !== 'object') continue
    if (hasId(message)) {
      if (ids.has(message.id)) continue
      const committedCopy = base.some(stored => stored?.advisorSourceId === message.id
        && stored.role === message.role
        && (stored.source?.kind || stored.role) === (message.source?.kind || message.role)
        && renderContent(stored.content) === renderContent(message.content))
      if (committedCopy) continue
      ids.add(message.id)
    }
    combined.push(message)
  }
  return combined
}

export function buildAdvisorTranscript(history, pending = [], options = {}) {
  const maxMessageChars = limit(options.maxMessageChars ?? 24000, 24000)
  const maxTotalChars = limit(options.maxTotalChars ?? 1400000, 1400000)
  const maxEncodedChars = limit(options.maxEncodedChars ?? Infinity, Infinity)
  const maxTotalTokens = limit(options.maxTotalTokens ?? Infinity, Infinity)
  // Fixed per-record costs keep the window buckets stable as escaped text grows.
  // JSON string escaping is additive, apart from the two enclosing quotes. A
  // token cap is scaled into the same char units, so whichever cap is tighter
  // for a record decides its cost.
  const cost = text => Math.max(text.length, Number.isFinite(maxEncodedChars)
    ? Math.ceil((JSON.stringify(text).length - 2) * maxTotalChars / Math.max(1, maxEncodedChars - 2)) : 0,
  Number.isFinite(maxTotalTokens) ? Math.ceil(tokenCost(text) * maxTotalChars / Math.max(1, maxTotalTokens)) : 0)
  const excludeKinds = new Set(options.excludeKinds ?? DEFAULT_EXCLUDE_KINDS)
  const records = []
  let truncated = false
  let lastRealUser = -1

  for (const message of combineMessages(history, pending)) {
    if (!message || !['user', 'assistant', 'tool'].includes(message.role)) continue
    if (message.role === 'user' && excludeKinds.has(message.source?.kind)) continue
    const record = serializeMessage(message, maxMessageChars)
    truncated ||= record.wasTruncated
    if (record.realUser) lastRealUser = records.length
    records.push(record)
  }

  const serialized = records.map((record) => record.serialized)
  const fullSource = serialized.join('')
  const turnSource = lastRealUser >= 0 ? serialized.slice(0, lastRealUser + 1).join('') : fullSource
  let source = fullSource
  let windowed = false
  let messageCount = records.length
  // Index of the first kept serialized record; records.length when none is kept.
  let windowStart = 0

  let anchored = false

  const costs = serialized.map(cost)
  const totalCost = costs.reduce((sum, value) => sum + value, 0)
  if (totalCost > maxTotalChars) {
    windowed = true
    const header = cost(WINDOW_HEADER) <= maxTotalChars ? WINDOW_HEADER : ''
    const full = maxTotalChars - cost(header)
    let plan = windowPlan(costs, totalCost, full)
    // The request that started this turn must stay visible. When one long turn has
    // pushed it out of the window, pin it ahead of the newest evidence, clipped to a
    // quarter of the budget, instead of leaving the advisor without the task.
    let anchor = ''
    // The quarter includes the gap line, so the anchor never takes more than it.
    const anchorBudget = Math.floor(full / 4) - cost(ANCHOR_GAP)
    if (lastRealUser >= 0 && lastRealUser < plan.start && anchorBudget > 0) {
      const pinned = fitText(serialized[lastRealUser], anchorBudget, cost)
      const anchoredPlan = windowPlan(costs, totalCost, Math.max(0, full - cost(pinned + ANCHOR_GAP)))
      if (pinned && lastRealUser < anchoredPlan.start) {
        anchor = pinned + ANCHOR_GAP
        plan = anchoredPlan
      } else if (lastRealUser >= anchoredPlan.start) {
        // The smaller budget moved the window back over the request: that window
        // already contains it, so use it without a pinned copy (never send it twice).
        plan = anchoredPlan
      }
    }
    const tail = serialized.slice(plan.start).join('')
    const kept = fitText(tail, plan.budget, cost)
    source = header + anchor + kept
    truncated ||= kept.length < tail.length
    anchored = Boolean(anchor)
    messageCount = plan.budget > 0 ? serialized.length - plan.start : 0
    windowStart = plan.budget > 0 ? plan.start : serialized.length
  }

  return { source, turnSource, messageCount, truncated, windowed, windowStart, anchored, ...(options.schedulerRecords ? { schedulerRecords: records } : {}) }
}

// Advance the absolute window start in coarse buckets. A sliding tail would change
// its first message on almost every step after reaching the cap, forcing the
// persistent advisor to rebuild a full request each time. Half-budget buckets keep
// the window between budget/2 and budget, so the persistent dialogue can append for
// about half a budget between rebases.
function windowPlan(costs, totalCost, budget) {
  const stride = Math.max(1, Math.floor(budget / 2))
  const windowEnd = Math.ceil(totalCost / stride) * stride
  const startOffset = Math.max(0, windowEnd - budget)
  let offset = 0
  let start = 0
  while (start < costs.length - 1 && offset < startOffset) {
    offset += costs[start]
    start += 1
  }
  return { budget, start }
}

// Longest head+tail clip of `text` whose cost fits the budget.
function fitText(text, budget, cost) {
  let low = 0
  let high = Math.max(0, Math.min(text.length, budget))
  if (cost(truncateHeadTail(text, high)) <= budget) return truncateHeadTail(text, high)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (cost(truncateHeadTail(text, mid)) <= budget) low = mid
    else high = mid - 1
  }
  return truncateHeadTail(text, low)
}

export function adviceRouteKey(preset) {
  return sha256(JSON.stringify([preset.id, preset.aggregator?.provider, preset.aggregator?.model]))
}

export function isRouteAdvice(message, preset) {
  if (message?.role !== 'user' || message.source?.kind !== 'plugin:moa' || message.source.form === 'retired' || message.source.form === 'review') return false
  const source = message.source
  if (source.routeKey) return source.routeKey === adviceRouteKey(preset)
  return !source.preset || source.preset === preset.id
}

/** Keep the event log intact; choose the advice visible in this model request only. */
export function selectAdviceForAggregator(messages, preset, mode = 'latest') {
  if (!Array.isArray(messages)) return messages
  const candidates = []
  for (let index = 0; index < messages.length; index++) {
    if (isRouteAdvice(messages[index], preset)) candidates.push(index)
  }
  const ownAdvice = message => message?.role === 'user' && message.source?.kind === 'plugin:moa' && message.source.form !== 'review'
  if (mode === 'all') return messages.filter(message => !ownAdvice(message) || isRouteAdvice(message, preset))
  let keep = candidates[candidates.length - 1]
  if (keep !== undefined) {
    const hash = message => sha256(contentToText(message.content, { maxChars: Infinity }))
    const latestHash = hash(messages[keep])
    // Duplicate reinjection of identical guidance keeps the first position in the latest
    // uninterrupted run of that guidance. A later A after a changed B remains a new A.
    for (let index = candidates.length - 2; index >= 0; index--) {
      const candidate = candidates[index]
      if (hash(messages[candidate]) !== latestHash) break
      keep = candidate
    }
  }
  return messages.filter((message, index) => !ownAdvice(message) || index === keep)
}

export function makeAdviceMessage(text, metadata = {}) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:moa', form: 'advice', ...metadata },
  }
}
