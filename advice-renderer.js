/*
 * MoA advice → Chat row, using only official client contracts.
 *
 * Two forms share this row: `advice` (reference material injected during the
 * turn) and `review` (the end-of-turn QA review). Both are `user/message`
 * events with `source.kind === 'plugin:moa'`; only `retired` stays hidden.
 *
 * WHY THIS FILE EXISTS
 * The Chat target hid MoA advice for two independent reasons, both upstream and
 * both deliberate:
 *
 *  1. `input-message` (Chat's `user/message` Definition) classifies every
 *     user-role message whose `source.kind !== 'user'` as context presentation
 *     (`kind: "context"`). `isVisibleChatNode` then hides `context` rows unless
 *     they carry tool additions/removals. MoA advice is `source.kind ===
 *     'plugin:moa'`, i.e. ordinary injected context, so it has a Node and no DOM.
 *  2. A later advice replaces the previous one with
 *     `surfaceOp: { op: 'replace' }`. Chat's `input-message` only matches
 *     append-origin events, and its sole fallback also requires append, so
 *     replacement advice produces no Chat Node at all.
 *
 * Neither reason is a bug and neither needs to be "fixed" in core: the official
 * extension point is a Definition of our own, registered through
 * `ctx.uiConversation.events`, that materializes a Chat Node of a NEW kind and
 * a matching `conversation.chat.node` renderer entry for that kind. The engine
 * fans an event out to every matching Definition (unless one declares
 * `exclusive: true`), so our node is ADDITIVE: Chat's own hidden `context` node
 * and real user rows are untouched, and nothing is faked as a user, assistant or
 * tool event.
 *
 * CONTRACT (verified in the shipped asar, dsh-client-ui-conversation/lib/client.js)
 *  - Definitions are registered per target: `requireState` rejects an undefined
 *    `start` result; a Definition must declare `target` and `buildViewNode`
 *    together (client.js:3437-3439).
 *  - The engine dispatches to ALL matching Definitions and only lets an
 *    `exclusive: true` result claim a target (client.js:2805-2847). Two
 *    exclusive claims on one target throw (client.js:2825), so we must NOT set
 *    `exclusive`.
 *  - A Match is `{ id, role: 'start' | 'update' }`; contexts are keyed by
 *    `(kind, id)` (client.js:2871), which is why a new `kind` can never collide
 *    with Chat's rows for the same event.
 *  - Node shape (dsh-client-ui-chat/lib/client.js:7685-7697): `key` must equal
 *    `context.key`, `target` must equal the Definition target, and
 *    `location`/`anchorSeq` are required by the view builder.
 *
 * This module is intentionally React-free and side-effect free: it exports the
 * Definition, a pure event→state projection, and a view-model mapper. client.js
 * owns mounting (slots) and JSX.
 */

/** Renderer dispatch key on `conversation.chat.node`; also the Definition kind. */
export const ADVICE_KIND = 'moa-advice'

/** Slot the Chat target renders one Node kind with. */
export const ADVICE_SLOT = 'conversation.chat.node'

/** Source identity of an injectable MoA advice message. */
export const ADVICE_SOURCE_KIND = 'plugin:moa'
export const ADVICE_FORM = 'advice'
/**
 * End-of-turn QA review. Same durable shape as advice (`user/message` with a
 * `source`), same reserved Chat kind, same slot and renderer entry: only the
 * card wording differs, so a second kind would buy nothing but a second
 * registration path.
 */
export const REVIEW_FORM = 'review'
export const RETIRED_FORM = 'retired'

/** Forms this renderer owns. Everything else (retired included) stays hidden. */
const RENDERED_FORMS = new Set([ADVICE_FORM, REVIEW_FORM])

/** Chat's own kinds. Ours must never reuse one of these. */
const CHAT_RESERVED_KINDS = new Set([
  'input-message',
  'developer-message',
  'assistant-step',
  'tool-call',
  'compaction',
  'manual-compaction',
  'model-retry',
  'turn-error',
  'turn-trigger',
  'turn-tail',
  'system-prompt',
  'ui-notice',
  'inbox-next-step',
  'inbox-next-turn',
])

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * True for an active (renderable) MoA message: advice or end-of-turn review.
 *
 * Deliberately strict: `source.kind` must be exactly `plugin:moa` and
 * `source.form` exactly `advice` or `review`. Retired placeholders
 * (`form: 'retired'`) and any other form stay unrendered, matching MoA's own
 * "never show a result that was not injected" rule.
 *
 * @param {unknown} message committed `user/message` payload
 */
export function isAdviceMessage(message) {
  if (!isRecord(message) || message.role !== 'user') return false
  const source = isRecord(message.source) ? message.source : null
  if (source === null) return false
  return source.kind === ADVICE_SOURCE_KIND && RENDERED_FORMS.has(source.form)
}

/**
 * True for a durable `user/message` event carrying active advice, in either
 * surface role: the first advice of a session is appended by the loop, every
 * later one is an explicit `replace` (moa/surface.js:58-78).
 *
 * @param {unknown} event committed Session event
 */
export function isAdviceEvent(event) {
  return isRecord(event) && event.type === 'user/message' && isAdviceMessage(event.data)
}

/**
 * Match function shared by the Definition and the tests.
 *
 * Both surface roles use `role: 'start'`: a replacement advice event carries a
 * fresh `data.id`, so it opens its own context at its own anchor. Chat uses
 * `role: 'update'` only for replacement copies whose id is stable across
 * events (compaction checkpoints), which is not our shape.
 *
 * @param {unknown} event
 * @returns {{ id: string, role: 'start' } | null}
 */
export function matchAdvice(event) {
  if (!isAdviceEvent(event)) return null
  const id = event.data.id
  if (typeof id !== 'string' || id.length === 0) return null
  return { id, role: 'start' }
}

/** Join the text blocks of a message content array. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Display metadata is authoritative; legacy templates end before opinions or status. */
export function adviceDisplayText(text, source) {
  if (typeof source?.displayText === 'string' && source.displayText.trim()) return source.displayText
  if (typeof text !== 'string') return ''
  const knownPreamble = /^(?:\[Expert consultation for the acting agent\]|\[Final QA review\]|【内部参考证据】|【结束前 QA 审阅】)/.test(text)
  let offset = 0
  let fence = null
  let statusOffset = null
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/.exec(line)
    if (fence !== null) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === '') fence = null
    } else if (marker) {
      fence = marker[1]
    } else if (/^### [^\s][^\r\n]*\r?$/.test(line)) {
      return text.slice(offset)
    } else if (knownPreamble && statusOffset === null && /^(?:参考可用性：|异步参考处理中：|本次没有参考模型返回可用建议。|Unavailable:|Pending:|No usable advisor response\.)/.test(line)) {
      statusOffset = offset
    }
    offset += line.length + 1
  }
  // A status line is reliable only after one of our fixed template headers.
  // Unknown unstructured responses retain every byte of the original text.
  return statusOffset === null ? text : text.slice(statusOffset)
}

/**
 * Pure event → Node payload projection.
 *
 * `replacement` records the shadowed surface span so the renderer can say
 * "this advice replaces the previous one" instead of pretending to be a new
 * user prompt; `null` means this advice was appended as the session's first.
 *
 * @param {any} event a committed `user/message` event that `matchAdvice` accepts
 */
export function adviceState(event) {
  const message = event.data
  const source = isRecord(message.source) ? message.source : {}
  const surfaceOp = isRecord(event.surfaceOp) ? event.surfaceOp : null
  return {
    kind: ADVICE_KIND,
    messageId: String(message.id),
    seq: event.seq,
    time: event.time,
    content: message.content,
    source,
    text: contentText(message.content),
    // The caller never assumes a form: a review and an advice row differ only
    // in their label, so the renderer must receive the source's own form.
    form: source.form,
    routeKey: typeof source.routeKey === 'string' ? source.routeKey : null,
    preset: typeof source.preset === 'string' ? source.preset : null,
    logicalPlacement: source.logicalPlacement ?? null,
    replacement:
      surfaceOp !== null && surfaceOp.op === 'replace'
        ? { from: surfaceOp.startSeq ?? null, to: surfaceOp.endSeq ?? null }
        : null,
  }
}

/**
 * Engine-owned Location of a Context: its start Match, else its first Match.
 * Mirrors Chat's internal `contextLocation` (dsh-client-ui-chat/lib/client.js:7660-7662)
 * because the engine hands Definitions the assembled Context, not this helper.
 */
function contextLocation(context) {
  return context.start?.location ?? context.matches?.[0]?.location ?? { kind: 'unresolved' }
}

/**
 * Build the Chat view Node for one advice Context.
 *
 * `groupTree: 'input'` keeps this reference material with the request input.
 * An ungrouped non-assistant row is classified as an external process and is
 * hidden when the Host collapses a completed tool/execution group. This is only
 * layout metadata: kind stays `moa-advice`, never `user`, `steering` or `context`.
 *
 * @param {any} context assembled business Context
 */
export function buildAdviceNode(context) {
  const state = context.state
  // Reject an absent or malformed state: a Node without a seq would sort before
  // the first row, and Chat's builder requires a numeric anchor.
  if (!isRecord(state) || typeof state.seq !== 'number') return null
  return {
    key: context.key,
    kind: ADVICE_KIND,
    id: context.id,
    target: 'chat',
    anchorSeq: state.seq,
    location: contextLocation(context),
    visibility: 'visible',
    groupTree: 'input',
    data: state,
  }
}

/**
 * The Definition to register with `ctx.uiConversation.events.register(...)`.
 *
 * A fresh object per call keeps registration idempotent for a plugin that
 * re-mounts; the engine keys Definitions by `kind`.
 */
export function createAdviceNodeDefinition() {
  return {
    kind: ADVICE_KIND,
    target: 'chat',
    // Table form: the registry routes only `user/message` events to us.
    match: { 'user/message': matchAdvice },
    start: (_context, match) => adviceState(match.event),
    update: (context) => context.state,
    buildViewNode: (context) => buildAdviceNode(context),
  }
}

/**
 * View model for the renderer registered under `ADVICE_KIND`.
 *
 * The UI author maps this to JSX; keeping it plain keeps the definition module
 * testable without React and without a browser.
 *
 * @param {any} node Chat Node produced by `buildAdviceNode`
 */
export function adviceViewProps(node) {
  const data = isRecord(node?.data) ? node.data : {}
  const replacement = data.replacement ?? null
  return {
    kind: ADVICE_KIND,
    nodeKey: typeof node?.key === 'string' ? node.key : '',
    anchorSeq: typeof node?.anchorSeq === 'number' ? node.anchorSeq : 0,
    text: adviceDisplayText(data.text, data.source),
    // Cards label themselves by form; unknown or absent forms read as advice.
    form: data.form === REVIEW_FORM ? REVIEW_FORM : ADVICE_FORM,
    preset: data.preset ?? null,
    routeKey: data.routeKey ?? null,
    replacesEarlier: replacement !== null,
    replacedFrom: replacement?.from ?? null,
    time: data.time ?? null,
    // Advice is never a user turn; renderers must not reuse user-row affordances.
    role: 'advice',
  }
}

/**
 * Register the Definition on an owning ui-conversation fiber.
 *
 * The caller's client entry must inject `@deepseek-ai/dsh-client-ui-conversation`
 * (it is the provider of `uiConversation`); `effect` keeps the registration tied
 * to the plugin lifetime.
 *
 * @param {{ uiConversation: { events: { register(definition: unknown): unknown } }, effect?(fn: () => unknown): unknown }} ctx
 */
export function registerAdviceDefinition(ctx) {
  const register = () => ctx.uiConversation.events.register(createAdviceNodeDefinition())
  return typeof ctx.effect === 'function' ? ctx.effect(register) : register()
}

/**
 * Register the renderer entry for our kind.
 *
 * Chat itself adds every one of its kinds this way (an `inject` of the slot
 * name plus a `register({ name, key })`), so an extra key is the supported
 * pattern rather than a hijack: `user`, `steering`, `context`, … keep their
 * owners. Without this entry the flow renders our Node through Chat's
 * `fallback` (`message.unknownSurface`) JSON block — visible, but not ours.
 *
 * @param {any} ctx owning client fiber with `slots`
 * @param {any} Component React component receiving the `adviceViewProps` payload
 * @param {{ locale?: string, priority?: number }} [options]
 */
export function registerAdviceRenderer(ctx, Component, options = {}) {
  if (Component === undefined || Component === null) throw new Error('registerAdviceRenderer requires a component')
  const entry = { name: ADVICE_SLOT, key: ADVICE_KIND }
  if (options.locale !== undefined) entry.locale = options.locale
  if (options.priority !== undefined) entry.priority = options.priority
  const register = () => ctx.slots.register(entry, Component)
  return typeof ctx.slots.inject === 'function' ? ctx.slots.inject(ADVICE_SLOT, register) : register()
}

/** Kinds that must stay Chat-owned; exported for the offline guard test. */
export function isReservedChatKind(kind) {
  return CHAT_RESERVED_KINDS.has(kind)
}