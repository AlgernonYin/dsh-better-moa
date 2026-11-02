import { createHash } from 'node:crypto'

export const SCHEDULER_CONTEXT_VERSION = 'anchored-record-window-v1'
export const DEFAULT_STATE_CHARS = 128000
export const MIN_STATE_CHARS = 100000
export const MAX_STATE_CHARS = 512000
// Lookup history and writes are different limits. Preserve successful markings
// throughout an append chain; cap history so request metadata stays bounded.
export const MAX_RETAINED_BREAKPOINTS = 48
const INTRO = 'Quoted chronological transcript evidence. Some middle records may be omitted. Judge the latest activity against the current real user request when present. Earlier completed stages do not establish completion of the current stage.\n'
const GAP = '\n[scheduler: intermediate source records omitted]\n'
const CUT = '\n[scheduler: middle of this oversized source record omitted]\n'
const hash = text => createHash('sha256').update(text).digest('hex')

export function normalizeStateChars(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= MIN_STATE_CHARS
    ? Math.min(MAX_STATE_CHARS, Math.floor(number)) : DEFAULT_STATE_CHARS
}

function safeEnd(text, end) {
  return end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end]) ? end - 1 : end
}
function safeStart(text, start) {
  return start > 0 && start < text.length && /[\uDC00-\uDFFF]/u.test(text[start]) && /[\uD800-\uDBFF]/u.test(text[start - 1]) ? start + 1 : start
}
function excerpt(text, cap) {
  if (text.length <= cap) return text
  const remaining = Math.max(0, cap - CUT.length)
  const first = safeEnd(text, Math.ceil(remaining / 2))
  const last = safeStart(text, text.length - Math.floor(remaining / 2))
  return text.slice(0, first) + CUT + text.slice(last)
}

/** Structured records are supplied before the advisor's independent rolling view. */
export function schedulerContext(records, capacity = DEFAULT_STATE_CHARS) {
  const cap = normalizeStateChars(capacity)
  const raw = Array.isArray(records) ? records : []
  const recordCap = Math.min(32000, Math.floor(cap / 4) - 512)
  let truncations = 0
  const entries = raw.map(record => {
    const original = String(record.serialized || '')
    const text = excerpt(original, recordCap)
    if (text !== original || record.wasTruncated) truncations++
    return { text, realUser: record.realUser === true, truncated: text !== original || record.wasTruncated }
  })
  if (!entries.length) return { text: '(No transcript evidence.)', anchors: [], layout: SCHEDULER_CONTEXT_VERSION,
    context: { capacity: cap, inputChars: 25, sourceChars: 0, omittedRecords: 0, truncatedRecords: 0, windowOffset: 0 } }
  const headCap = Math.min(32768, Math.floor(cap / 4))
  let headCount = 0, headChars = 0
  while (headCount < entries.length && headChars + entries[headCount].text.length <= headCap) {
    headChars += entries[headCount++].text.length
  }
  // Reserving the goal before selection makes window buckets independent of
  // whether that request is currently inside the recent portion.
  const goalCap = Math.min(8192, Math.floor(cap / 16))
  const tailBudget = cap - INTRO.length - headChars - goalCap - GAP.length * 2
  const remaining = entries.slice(headCount)
  const totalTail = remaining.reduce((sum, entry) => sum + entry.text.length, 0)
  const stride = Math.max(1, Math.floor(tailBudget / 4))
  const threshold = Math.max(0, Math.ceil((totalTail - tailBudget) / stride) * stride)
  let skipped = 0, offset = 0
  while (skipped < remaining.length - 1 && offset < threshold) offset += remaining[skipped++].text.length
  while (skipped < remaining.length - 1 && totalTail - offset > tailBudget) offset += remaining[skipped++].text.length
  const latestUser = entries.findLastIndex(entry => entry.realUser)
  const selectedSize = skip => {
    const start = headCount + skip
    const goal = latestUser >= headCount && latestUser < start
    return INTRO.length + headChars + (skip ? GAP.length : 0)
      + (goal ? excerpt(entries[latestUser].text, goalCap).length + (latestUser < start - 1 ? GAP.length : 0) : 0)
      + entries.slice(start).reduce((sum, entry) => sum + entry.text.length, 0)
  }
  // If enough real history exists, a coarse rotation must not reduce the
  // delivered evidence below 100k. Backfill adjacent older records, never pad.
  // At the tightest capacity, only the boundary record may need a marked excerpt.
  while (skipped > 0 && selectedSize(skipped) < MIN_STATE_CHARS) {
    const previous = entries[headCount + skipped - 1]
    const originalLength = previous.text.length
    const size = selectedSize(skipped - 1)
    if (size > cap) {
      const available = originalLength - (size - cap)
      if (available <= CUT.length) break
      previous.text = excerpt(previous.text, available)
      if (!previous.truncated) truncations++
      previous.truncated = true
    }
    skipped--; offset -= originalLength
  }
  const start = headCount + skipped
  const keepGoal = latestUser >= headCount && latestUser < start
  const segments = [INTRO]
  const anchors = []
  let length = INTRO.length
  const append = text => { if(text) {segments.push(text); length += text.length} }
  for (const entry of entries.slice(0, headCount)) append(entry.text)
  if(headCount) anchors.push(length)
  let goalChars = 0
  if(skipped) append(GAP)
  if(keepGoal) {
    const goal = excerpt(entries[latestUser].text, goalCap)
    goalChars = goal.length
    append(goal); anchors.push(length)
    if(latestUser < start - 1) append(GAP)
  }
  for (const entry of entries.slice(start)) append(entry.text)
  const text = segments.join('')
  if (text.length > cap) throw Error('Scheduler context exceeded its character capacity')
  let end = 0
  const boundaries = segments.map(segment => (end += segment.length))
  return { text, anchors, boundaries, layout: SCHEDULER_CONTEXT_VERSION, context: {
    capacity: cap, inputChars: text.length, sourceChars: raw.reduce((sum, entry) => sum + String(entry.serialized || '').length, 0),
    headChars, goalChars, recentChars: entries.slice(start).reduce((sum, entry) => sum + entry.text.length, 0), windowOffset: offset,
    omittedRecords: Math.max(0, skipped - (keepGoal ? 1 : 0)), truncatedRecords: truncations,
    selectedRecords: headCount + entries.length - start + (keepGoal ? 1 : 0),
  } }
}

export function contextText(state) {
  return typeof state === 'string' ? state : typeof state?.text === 'string' ? state.text : String(state || '')
}

/**
 * Retain exact content-part boundaries only when their entire prefix still
 * matches. A checkpoint contains hashes/offsets, never transcript text. Static
 * anchors are chunked deterministically even after an engine restart.
 */
export function planContextParts(state, previous) {
  const text = contextText(state) || '(No recent transcript evidence.)'
  const anchors = [...new Set(Array.isArray(state?.anchors) ? state.anchors : [])]
    .filter(end => Number.isSafeInteger(end) && end > 0 && end <= text.length).sort((a,b) => a-b)
  const stableEnd = anchors.at(-1) || 0
  const cuts = []
  function appendCuts(from, to) {
    while (from < to) {
      const end = safeEnd(text, Math.min(to, from + 2048))
      cuts.push(end); from = end
    }
  }
  const stableHash = hash(text.slice(0, stableEnd))
  let matchedEnd = 0
  const recordBoundaries = Array.isArray(state?.boundaries) ? state.boundaries : null
  if(recordBoundaries) {
    let cursor = 0
    for(const boundary of [...new Set([...recordBoundaries, ...anchors, text.length])].sort((a,b) => a-b)) {
      if(!Number.isSafeInteger(boundary) || boundary <= cursor || boundary > text.length) continue
      appendCuts(cursor, boundary); cursor = boundary
    }
    // Content-part equality includes the boundary positions, not just joined text.
    for(let i=0; i<cuts.length && i<(previous?.cuts?.length || 0); i++) {
      const cut = previous.cuts[i]
      if(cut.end !== cuts[i] || cut.hash !== hash(text.slice(0, cuts[i]))) break
      matchedEnd = cuts[i]
    }
  } else {
    let cursor = 0
    for (const anchor of anchors) { appendCuts(cursor, anchor); cursor = anchor }
    matchedEnd = previous?.stableEnd === stableEnd && previous.stableHash === stableHash ? stableEnd : 0
    if (previous?.stableEnd === stableEnd && previous.stableHash === stableHash && Array.isArray(previous.cuts)) {
      const candidates = previous.cuts.filter(cut => cut.end > stableEnd && cut.end <= text.length)
      let low = 0, high = candidates.length
      while (low < high) {
        const mid = Math.floor((low + high) / 2)
        if (hash(text.slice(0, candidates[mid].end)) === candidates[mid].hash) low = mid + 1
        else high = mid
      }
      for (const cut of candidates.slice(0, low)) cuts.push(cut.end)
      if (low) matchedEnd = candidates[low - 1].end
    }
    let from = Math.max(stableEnd, matchedEnd)
    // Text-only callers also retain deterministic paragraph/source boundaries.
    let end = 0
    for (const piece of text.split(/(?<=\n)(?=<source )|(?<=\n\n)/u)) {
      end += piece.length
      if (end > from) { appendCuts(from, end); from = end }
    }
  }
  const priorEndpoint = previous?.totalChars > 0 && previous.totalChars <= matchedEnd ? previous.totalChars : null
  const retained = (Array.isArray(previous?.marks) ? previous.marks : priorEndpoint ? [priorEndpoint] : [])
    .filter(end => Number.isSafeInteger(end) && end > 0 && end <= matchedEnd && cuts.includes(end))
  let marks = [...new Set([...retained, ...anchors.slice(0, 2), text.length])].sort((a,b) => a-b)
  const breakpointHistoryRebased = marks.length > MAX_RETAINED_BREAKPOINTS
  // Removing a prior mark can prevent remote reuse even when text is unchanged.
  // Rebase explicitly and infrequently, rather than silently dropping one per call.
  if (breakpointHistoryRebased) marks = [...new Set([...anchors.slice(0, 2), text.length])]
  const retainedBreakpoints = breakpointHistoryRebased ? 0 : retained.filter(end => marks.includes(end)).length
  const newBreakpoints = marks.filter(end => !retained.includes(end)).length
  const parts = []
  const checkpoints = []
  let start = 0
  const digest = createHash('sha256')
  for (const end of cuts) {
    const part = text.slice(start, end)
    digest.update(part)
    parts.push({ text: part, marked: marks.includes(end) })
    checkpoints.push({ end, hash: digest.copy().digest('hex') })
    start = end
  }
  return { parts, checkpoint: { stableEnd, stableHash, totalChars: text.length, cuts: checkpoints, marks },
    diagnostics: { layout: state?.layout || 'text', sharedPrefixChars: matchedEnd,
      previousEndpointRetained: Boolean(priorEndpoint && marks.includes(priorEndpoint)), breakpoints: marks.length,
      retainedBreakpoints, newBreakpoints, breakpointHistoryRebased } }
}
