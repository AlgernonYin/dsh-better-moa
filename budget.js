import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

// Per-reference context budget. This module must not import transcript.js,
// because transcript.js imports it for token-aware windowing.

export const LEARNED_WINDOW_TTL_MS = 6 * 60 * 60 * 1000

const CJK = /[一-鿿぀-ヿ가-힯]/g

// Port of bili's defaultCountTokens: one token per CJK code unit, four
// UTF-16 code units per token for everything else.
export function biliTokens(text) {
  const value = asText(text)
  if (!value) return 0
  const cjk = value.match(CJK)?.length ?? 0
  return cjk + Math.ceil((value.length - cjk) / 4)
}

export function utf8Bytes(text) {
  return Buffer.byteLength(asText(text), 'utf8')
}

// Conservative cost of one text once it is JSON-encoded into a request body.
export function tokenCost(text) {
  const value = asText(text)
  return Math.max(biliTokens(value), Math.ceil(utf8Bytes(JSON.stringify(value)) / 4))
}

export function wireTokens({ system, messages } = {}) {
  let counted = biliTokens(typeof system === 'string' ? system : '')
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = message?.content
    if (typeof content === 'string') counted += biliTokens(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type !== 'text' && part?.type !== 'reasoning') continue
        if (typeof part.text === 'string') counted += biliTokens(part.text)
        else if (typeof part.reasoning === 'string') counted += biliTokens(part.reasoning)
      }
    }
  }
  return Math.max(counted, Math.ceil(utf8Bytes(JSON.stringify({ system, messages })) / 4))
}

export function fallbackWindow(provider, model) {
  if (/claude/i.test(`${provider ?? ''}/${model ?? ''}`)) return 200000
  const name = String(model ?? '').split('/').pop() || ''
  if (/^(glm-4\.6|deepseek-(r1|v3|ocr)|gpt-4o)/i.test(name)) return 128000
  if (/^(kimi|qwen|claude|gpt-5|o[13]-)/i.test(name)) return 200000
  return 128000
}

export function freshLearnedWindow(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return null
  const effectiveLimit = positiveInteger(record.effectiveLimit)
  const learnedAt = Number(record.learnedAt)
  if (!effectiveLimit || !Number.isFinite(learnedAt)) return null
  if (now - learnedAt >= LEARNED_WINDOW_TTL_MS || learnedAt - now >= LEARNED_WINDOW_TTL_MS) return null
  const reserveAtLearning = Number.isFinite(record.reserveAtLearning) && record.reserveAtLearning >= 0
    ? Math.floor(record.reserveAtLearning)
    : null
  return { effectiveLimit, reserveAtLearning, learnedAt }
}

// Smallest budget a reference may run with (spec B3). Below this the call is
// refused with an actionable message instead of sending a useless payload.
export const MIN_REFERENCE_BUDGET = 1024
// Share of the window assumed for output when no maxTokens is known (B2).
// Used only to estimate how much transcript to trim, never sent upstream.
export const UNKNOWN_RESERVE_SHARE = 0.25

// B2: R is the first valid maxTokens of reference > preset > catalog.
export function resolveOutputCap({ referenceMaxTokens, presetMaxTokens, catalogMaxTokens } = {}) {
  for (const [value, source] of [[referenceMaxTokens, 'reference'], [presetMaxTokens, 'preset'], [catalogMaxTokens, 'catalog']]) {
    const parsed = positiveInteger(value)
    if (parsed) return { value: parsed, source }
  }
  return { value: null, source: null }
}

// Learned cap for the current R (spec B). Returns { cap } (raw tokens, before
// the 5% margin) or { ignored } when the record must not be reused.
export function learnedInputCap(record, outputCap) {
  const limit = record.effectiveLimit
  const r = record.reserveAtLearning
  const R = positiveInteger(outputCap) ?? null
  if (r != null && R == null) return { ignored: 'output-cap-removed' }
  if (r == null && R == null) return { cap: limit }
  if (r == null) return { cap: Math.max(0, limit - R) }
  return { cap: Math.max(0, Math.min(limit, limit + r - R)) }
}

// Window priority (spec A): explicit contextWindow > fresh learned refusal >
// catalogWindow > fallbackWindow. An explicit window disables learned records.
// `window` is always the native window; the learned limit is kept separately.
// `reserve` (legacy) is an alias for referenceMaxTokens.
export function referenceBudget({
  contextWindow, catalogWindow, provider, model, reserve,
  referenceMaxTokens, presetMaxTokens, catalogMaxTokens, learned, now = Date.now(),
} = {}) {
  const explicit = positiveInteger(contextWindow)
  const catalog = positiveInteger(catalogWindow)
  const window = explicit ?? catalog ?? fallbackWindow(provider, model)
  const nativeSource = explicit ? 'explicit' : catalog ? 'catalog' : 'fallback'
  const output = resolveOutputCap({ referenceMaxTokens: referenceMaxTokens ?? reserve, presetMaxTokens, catalogMaxTokens })
  const reserveKnown = output.value != null
  const trimReserve = reserveKnown ? null : Math.ceil(UNKNOWN_RESERVE_SHARE * window)
  // budgetReserve is arithmetic only; `reserve` reports what is actually sent.
  const budgetReserve = reserveKnown ? output.value : trimReserve
  const nativeBudget = withMargin(Math.max(window - budgetReserve, 0))
  const result = {
    window,
    windowSource: nativeSource,
    nativeWindowSource: nativeSource,
    reserve: output.value,
    reserveKnown,
    reserveSource: output.source,
    sendMaxTokens: output.value,
    trimReserve,
    nativeBudget,
    budget: nativeBudget,
  }
  const record = freshLearnedWindow(learned, now)
  if (!record) return result
  if (explicit) {
    result.learnedIgnored = 'explicit-window'
    return result
  }
  const learnedCap = learnedInputCap(record, output.value)
  if (learnedCap.ignored) {
    result.learnedIgnored = learnedCap.ignored
    return result
  }
  result.learnedLimit = record.effectiveLimit
  result.learnedCap = withMargin(learnedCap.cap)
  // Final budget = min(native, learned) (task item 3). With R unknown the
  // native side is the 25% trim estimate, so (null, null) at window 200000
  // gives learnedCap 174800 but budget 142500 (see the task-12 report).
  result.budget = Math.min(nativeBudget, result.learnedCap)
  // 'learned' only when the learned cap is the binding constraint.
  if (result.learnedCap <= nativeBudget) result.windowSource = 'learned'
  return result
}

// Budget (with the 5% margin) that one refused request may use on its retry,
// whatever the window precedence says; null when the record cannot be applied.
export function refusalBudget(record, outputCap) {
  if (!record) return null
  const learned = learnedInputCap(record, outputCap)
  return learned.ignored ? null : withMargin(learned.cap)
}

// Metadata to persist after a bili refusal. reserveAtLearning is the maxTokens
// actually sent on the refused request (null if none), never trimReserve.
export function learnedWindowRecord({ effectiveLimit, sendMaxTokens, now = Date.now() } = {}) {
  const limit = positiveInteger(effectiveLimit)
  if (!limit) return null
  return { effectiveLimit: limit, reserveAtLearning: positiveInteger(sendMaxTokens) ?? null, learnedAt: now }
}

// B3: system + scaffold + latest user anchor + latest evidence must fit.
export function fitCheck({ budget, systemTokens = 0, scaffoldTokens = 0, anchorTokens = 0, evidenceTokens = 0 } = {}) {
  const value = Number.isFinite(budget) ? Math.floor(budget) : 0
  const needTokens = [systemTokens, scaffoldTokens, anchorTokens, evidenceTokens]
    .reduce((sum, item) => sum + (Number.isFinite(item) && item > 0 ? Math.ceil(item) : 0), 0)
  if (value < MIN_REFERENCE_BUDGET) return { ok: false, needTokens, budget: value, reason: 'below-floor' }
  if (needTokens > value) return { ok: false, needTokens, budget: value, reason: 'core-too-large' }
  return { ok: true, needTokens, budget: value, reason: null }
}

// bili's preflight_compress_failed refusal. Both phrases must be present.
export function parseWindowRefusal(text) {
  const value = asText(text)
  if (!/over-window payload was NOT forwarded/.test(value)) return null
  const match = /exceeds the model window (\d+)/.exec(value)
  const limit = match ? Number(match[1]) : NaN
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null
}

export function windowKey(provider, model) {
  return createHash('sha256').update(`moa-window\0${provider ?? ''}\0${model ?? ''}`).digest('hex')
}

// `learnedLimit` is set only when a learned bili refusal is the binding cap.
// The native window is still reported as the window; the learned limit is
// named separately because it is what bili's route/model config enforces.
// reserveKnown === false: no maxTokens is sent; `reserve` is then the trim
// estimate (trimReserve) and is described as such, never as maxTokens.
export function budgetFitMessage({ label, provider, model, used, system, transcript, budget, window, reserve, reserveKnown, dropped, learnedLimit }) {
  const dialogue = Math.max(0, used - system - transcript)
  const capped = learnedLimit ? `, capped by bili's learned model window ${learnedLimit}` : ''
  const reserveText = reserveKnown === false
    ? `estimated output reserve ${reserve} (no maxTokens set)`
    : `maxTokens ${reserve}`
  const advice = reserveKnown === false
    ? `Set this reference's maxTokens explicitly, raise its contextWindow`
    : `Lower this reference's maxTokens, raise its context window`
  return `advisor payload cannot fit ${label} (${provider}/${model}): needs ~${used} tokens (system ${system}, transcript ${transcript}, dialogue ${dialogue}), budget ${budget} = window ${window} − ${reserveText} − 5% margin${capped}. The oldest ${dropped} messages were already dropped and the persistent dialogue was rebuilt. ${advice} in bili's route/model config (currently ${learnedLimit ?? window}), or disable it for large sessions.`
}

// Non-bili upstream overflow (provider's own context-length error). bili's
// refusal is handled by parseWindowRefusal and is excluded here. Callers must
// not blindly retry these: the same payload will overflow again.
const OVERFLOW_PATTERNS = [
  /context_length_exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /input is too long/i,
  /exceed(?:s|ed)? (?:the |its |your )?(?:model'?s? )?(?:maximum )?context (?:window|length|limit)/i,
  /input token count .*exceeds/i,
  /exceeded model token limit/i,
  /context window (?:is )?(?:full|exceeded)/i,
  /too many tokens in (?:the )?(?:prompt|input|context)/i,
]

export function isContextOverflow(text) {
  const value = asText(text)
  if (!value) return false
  if (parseWindowRefusal(value) != null) return false
  if (/max_tokens.*(?:too large|must be (?:less|at most))/i.test(value)) return false
  if (/(?:per minute|rate limit|tpm\b)/i.test(value)) return false
  return OVERFLOW_PATTERNS.some(pattern => pattern.test(value))
}

export function contextOverflowMessage({ label, provider, model, window, reserve, reserveKnown } = {}) {
  const name = label ? `${label} (${provider}/${model})` : `${provider}/${model}`
  const windowText = Number.isFinite(window) ? `assumed context window ${window}` : 'unknown context window'
  const reserveText = reserveKnown === false || reserve == null
    ? 'no maxTokens set (output reserve estimated)'
    : `maxTokens ${reserve}`
  return `reference ${name} rejected the request as over its context length (${windowText}, ${reserveText}). Not retried: the same payload would overflow again. Set this reference's contextWindow to the model's real window, or lower its maxTokens, or disable it for large sessions.`
}

function withMargin(value) {
  return Math.floor(value * 95 / 100)
}

function positiveInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function asText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}
