/**
 * Deterministic isolation of transcript-shaped advisory output.
 *
 * Port of Hermes `magpie-moa-suite/output_guard.py` v4.2.0. A reference advisor has no tools;
 * when it returns a tool record, an execution log or a first-person "I ran the tests" claim, that
 * text must not reach the acting agent as guidance. Not a factual-correctness classifier:
 *
 *   clean      ordinary advice, proposals ("Proposed: run pytest -q"), citations of actor
 *              evidence ("per S4.R2", "根据工具结果") and conditionals
 *   candidate  a rule matched but the sentence carries a proposal, attribution or quotation
 *              marker; recorded, delivered unchanged (the false-positive brake)
 *   quarantine an unambiguous execution record: bracket/XML tool syntax, JSON/CLI tool record,
 *              scaffold echo, bare exit status, or an uncited perfective action claim, including
 *              subject-less ("已运行 pytest") and English past-tense ("Ran pytest -q") forms
 *   empty      blank / sentinel output (Hermes: quarantine with category 'degenerate')
 *
 * Regex translation notes (Python `re` on str → JS RegExp with the `u` flag):
 *   - Python `\b`, `\s`, `\d` are Unicode-aware; JS ones are ASCII. `\b` becomes explicit
 *     lookarounds over [\p{L}\p{N}_] (so CJK counts as a word char, as in Python), `\s` the
 *     str.isspace() set, `\d` \p{Nd}.
 *   - `(?m)^` / `$` match only at '\n' in Python, so they become (?<![^\n]) / (?![^\n]).
 */
import { createHash } from 'node:crypto'

export const GUARD_VERSION = '4.2.0-js'

const CLEAN = 'clean'
const CANDIDATE = 'candidate'
const QUARANTINE = 'quarantine'

// Python str.isspace() set, usable inside a character class.
const SPACE_CHARS = '\\t-\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const S = `[${SPACE_CHARS}]`
const NOT_S = `[^${SPACE_CHARS}]`
const D = '\\p{Nd}'
const W = '[\\p{L}\\p{N}_]'
const WORD_START = `(?<!${W})` // `\b` before a token that starts with a word char
const WORD_END = `(?!${W})` // `\b` after a token that ends with a word char
const BOL = '(?<![^\\n])'
const EOL = '(?![^\\n])'

const ZH_ACTIONS = '运行|执行|跑|打开|读取|读|检查|查看|修改|写入|写|创建|删除|安装|测试|' +
  '拉取|克隆|搜索|下载|部署|提交|合并|验证|确认|复现|构建|编译|调用|' +
  '完成|修复|解决|处理|通过|回滚|重启|升级|清理|备份|恢复'
const ZH_DONE = '已经|已|刚刚|刚|刚才|方才'
const ZH_FIRST = '我|本人|我们'
const ZH_PROPOSAL = '建议|可以|不妨|如果|若|应当|应该|需要你|请你|请尝试|推荐|建议你|' +
  '需要进一步|还需要'
const ZH_ATTRIBUTION = `根据|依据|按照|据(?:S${D}|工具结果|工具输出|记录|来源|报道|称)|S${D}|工具结果|工具输出|` +
  '记录显示|转录|来源|引文|演员|执行者|主代理|用户说|用户表示|用户原话|引用|原话|' +
  '转述|声称|写道'
const EN_ACTIONS = 'ran|run|executed|opened|read|checked|verified|tested|modified|edited|' +
  'wrote|created|deleted|installed|deployed|committed|downloaded|fetched|' +
  'patched|reverted|migrated|finished|completed|fixed|resolved|passed|' +
  'merged|restarted|upgraded|cleaned'
const EN_PROPOSAL = `${WORD_START}(?:suggest|recommend|propose|proposed|could|would|should|if you|consider|try)${WORD_END}`
const EN_ATTRIBUTION = `${WORD_START}(?:according to|per the|per S${D}|the transcript|the source|S${D}+|` +
  'the actor|acting agent|quoted|evidence shows|as shown|the user said|' +
  `user said|reportedly|in the quoted)${WORD_END}`

// Sentence-initial, subject-less perfective claims. Deliberately excludes ambiguous
// imperatives ("Read the file", "Run the suite"): only forms asserting a completed action.
const EN_PAST = 'Ran|Checked|Verified|Modified|Edited|Wrote|Created|Deleted|Installed|' +
  'Deployed|Committed|Finished|Completed|Fixed|Resolved|Tested|Patched|' +
  'Migrated|Merged|Reverted|Restarted|Upgraded|Passed|Succeeded|Saved|' +
  'Updated|Opened|Added|Removed|Built'
const ZH_PAST = '运行|执行|跑|检查|修改|写入|创建|删除|安装|测试|部署|提交|合并|验证|' +
  '复现|构建|编译|完成|修复|解决|处理|回滚|重启|升级|清理|备份|恢复|' +
  '通过|读取|打开|查看|下载|搜索|调用'

// Past participles that are also adjectives: only a claim when the sentence names an artifact
// or takes a determiner object ("Updated config.yaml", "Opened the file"), not in
// "Fixed costs are rising".
const EN_AMBIGUOUS = new Set([
  'Fixed', 'Checked', 'Created', 'Tested', 'Merged', 'Updated', 'Saved',
  'Opened', 'Added', 'Removed', 'Built',
])
const ARTIFACT = new RegExp(`${WORD_START}(?:test|tests|file|files|log|logs|repo|repository|branch|pr|config|` +
  'command|build|migration|suite|diff|code|script|deploy|commit|pytest|' +
  'clause|module|function|class|handler|check|validator|param|flag|' +
  'endpoint|database|table|column|line|patch|release|version|package|' +
  `plugin|server|bug|issue|error|failure|schema|record|row)${WORD_END}`, 'iu')
const EN_DETERMINER_OBJECT = new RegExp(
  `^${S}+(?:the|a|an|this|that|these|those|my|our|its|their|his|her|${D}+)${WORD_END}`, 'iu')
const PARTICIPLE_PREFIX = new RegExp(`^[${SPACE_CHARS}>\\-*•${D}.)、]+`, 'u')

// "I found/think/noticed ..." introduces an observation; the perfective verb inside is
// reported, not performed.
const ZH_OBSERVE = new RegExp(`^[${SPACE_CHARS}>*\\-•${D}.)、]*(?:我|本人|我们)(?:发现|认为|觉得|判断|推测|估计|看|读到)`, 'u')

// A bare machine-result summary ("测试全部通过", "构建成功") is an execution record even when
// its grammatical subject is the artifact.
const ZH_RESULT_SUMMARY = `${BOL}${S}*(?:[>\\-*\\u2022]${S}*|${D}+[.)、]${S}*)?` +
  '(?:测试|检查|构建|编译|部署|迁移|验证|运行|执行|安装|修复|实现|审计|回归)' +
  '[^。！？!?\\n]{0,16}?(?:全部|全都|均|都)?(?:通过|成功|完成|失败|正常)' +
  `${S}*[。.!！?]?${S}*${EOL}`

// Rules where a quoted sentence is more likely a citation than a claim.
const QUOTE_SENSITIVE = new Set([
  'cn_first_person_execution', 'cn_first_person_perfective',
  'cn_omitted_subject_execution', 'en_first_person_execution',
  'en_omitted_subject_execution', 'exit_status_claim',
  'cn_result_summary',
])

// Only execution *claims* can be excused by a marker. Tool syntax, scaffold echoes and the
// like stay quarantined even inside a quotation: the old accident was a "quoted" forged record.
const MARKER_EXCUSABLE = new Set([...QUOTE_SENSITIVE, 'shell_prompt_block'])

const rule = (name, category, level, source, flags = '') =>
  ({ name, category, level, pattern: new RegExp(source, `gu${flags}`) })

const RULES = [
  rule('bracket_tool_record', 'fabricated_tool_record', QUARANTINE,
    `\\[(?:called tool|tool result|tool_call|tool_use|assistant${S}+(?:tool_call|tool_use))${WORD_END}|` +
    `<tool_call${WORD_END}|` +
    `<function_call${WORD_END}|<tool_use${WORD_END}|<\\|tool`, 'i'),
  rule('xml_invoke_tool_record', 'fabricated_tool_record', QUARANTINE,
    `<tool[ _]?calls?${WORD_END}|<invoke${S}+name${S}*=|` +
    `${BOL}${S}*call_[A-Za-z0-9_-]+${S}*\\{`, 'i'),
  rule('dsml_tool_record', 'fabricated_tool_record', QUARANTINE,
    `<\\uFF5C(?:DSML|tool)\\uFF5C${S}*(?:tool[ _]?calls?|calls?|invoke|parameter)${WORD_END}`, 'i'),
  rule('xml_tool_record', 'fabricated_tool_record', QUARANTINE,
    `<(?:read|write|edit|multiedit|bash|shell|grep|glob|task|search|webfetch)${S}+` +
    `[A-Za-z_][\\w-]*${S}*=`, 'i'),
  rule('cli_tool_transcript', 'fabricated_tool_record', QUARANTINE,
    `${BOL}${S}*(?:>${S}*)?(?:⏺|●|⎿)${S}*(?:Read|Bash|Write|Edit|MultiEdit|Grep|Glob|Task|` +
    `Tool|Search|WebFetch)${S}*[(:]`),
  rule('json_tool_record', 'fabricated_tool_record', QUARANTINE,
    `"(?:tool_calls|function_call)"${S}*:` +
    `|"role"${S}*:${S}*"tool"` +
    `|"name"${S}*:${S}*"[A-Za-z0-9_.\\-]{1,40}"${S}*,${S}*"(?:arguments|parameters|input)"${S}*:`),
  rule('scaffold_echo', 'scaffold_echo', QUARANTINE,
    `${BOL}${S}*(?:<<<EVIDENCE|=== S${D}+ (?:user|assistant) ===)`),
  rule('cn_first_person_execution', 'fabricated_execution', QUARANTINE,
    `(?:${ZH_FIRST})[^。！？!?\\n]{0,10}?(?:${ZH_DONE})[^。！？!?\\n]{0,6}?(?:${ZH_ACTIONS})`),
  rule('cn_first_person_perfective', 'fabricated_execution', QUARANTINE,
    `(?:${ZH_FIRST})[^。！？!?\\n]{0,8}?(?:${ZH_ACTIONS})了`),
  rule('en_first_person_execution', 'fabricated_execution', QUARANTINE,
    `${WORD_START}I(?:${S}+have|['’]ve)?${S}+(?:already${S}+|just${S}+)?(?:${EN_ACTIONS})${WORD_END}`, 'i'),
  rule('cn_omitted_subject_execution', 'fabricated_execution', QUARANTINE,
    `${BOL}${S}*(?:[>\\-*\\u2022]${S}*|${D}+[.)、]${S}*)?` +
    `(?:(?:已经|已|刚刚|刚|方才)(?:${ZH_PAST})` +
    `|(?:已经|已|刚刚|刚|方才)(?:将|把)[^。！？!?\\n]{0,10}?(?:${ZH_PAST})` +
    `|(?:${ZH_PAST})(?:了|过))`),
  rule('en_omitted_subject_execution', 'fabricated_execution', QUARANTINE,
    `${BOL}${S}*(?:[>\\-*\\u2022]${S}*|${D}+[.)]${S}*)?(?:${EN_PAST})${WORD_END}`, 'i'),
  rule('cn_result_summary', 'fabricated_execution', QUARANTINE, ZH_RESULT_SUMMARY),
  rule('exit_status_claim', 'fabricated_execution', QUARANTINE,
    `${BOL}${S}*(?:exit[_ ]?code|退出码|返回码)${S}*[:=]${S}*-?${D}+`, 'i'),
  rule('shell_prompt_block', 'fabricated_execution', CANDIDATE,
    `${BOL}${S}*\\$${S}+${NOT_S}+`),
]

const ZH_SENTENCE = /[^。！？!?\n]+/gu
const EN_SENTENCE = /[^.!?\n]+/gu
const QUOTED = /["“”「」『』]/u
const ZH_PROPOSAL_RE = new RegExp(ZH_PROPOSAL, 'u')
const EN_PROPOSAL_RE = new RegExp(EN_PROPOSAL, 'iu')
const ZH_ATTRIBUTION_RE = new RegExp(ZH_ATTRIBUTION, 'u')
const EN_ATTRIBUTION_RE = new RegExp(EN_ATTRIBUTION, 'iu')
const STRIP_RE = new RegExp(`^${S}+|${S}+$`, 'gu')
const SPLIT_RE = new RegExp(`${S}+`, 'u')

const FAILURE = ({ category, rule, digest }) =>
  `[failed: advisory output quarantined (${category}/${rule}); sha256=${digest}. ` +
  'No advice text was delivered. Continue on actual tool evidence.]'
const DEGENERATE = ({ category }) =>
  `[failed: advisor returned no usable text (${category}); no advice was delivered.]`

// Python str.strip() / str.split() whitespace semantics.
const pyStrip = (value) => value.replace(STRIP_RE, '')
const pySplit = (value) => value.split(SPLIT_RE).filter(Boolean)
const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()

// Python encodes with errors='replace', which turns lone surrogates into '?'.
const sha256 = (value) =>
  createHash('sha256').update(value.replace(/[\uD800-\uDFFF]/gu, '?'), 'utf8').digest('hex')

function* sentences(text) {
  for (const pattern of [ZH_SENTENCE, EN_SENTENCE]) {
    for (const match of text.matchAll(pattern)) {
      yield [match.index, match.index + match[0].length, match[0]]
    }
  }
}

// Step `count` code points from `index` (Python slices by code point, JS by code unit).
function stepCodePoints(text, index, count) {
  let i = index
  for (let n = 0; n < Math.abs(count); n++) {
    if (count < 0) {
      if (i <= 0) break
      const low = text.charCodeAt(i - 1)
      i -= low >= 0xdc00 && low <= 0xdfff && i >= 2 && text.charCodeAt(i - 2) >= 0xd800 &&
        text.charCodeAt(i - 2) <= 0xdbff ? 2 : 1
    } else {
      if (i >= text.length) break
      i += text.codePointAt(i) > 0xffff ? 2 : 1
    }
  }
  return i
}

function sentenceAt(text, position) {
  for (const [start, end, sentence] of sentences(text)) {
    if (start <= position && position < end) return sentence
  }
  return text.slice(stepCodePoints(text, position, -200), stepCodePoints(text, position, 200))
}

function markers(sentence, ruleName = '') {
  const found = []
  if (ZH_PROPOSAL_RE.test(sentence) || EN_PROPOSAL_RE.test(sentence)) found.push('proposal')
  if (ZH_ATTRIBUTION_RE.test(sentence) || EN_ATTRIBUTION_RE.test(sentence)) found.push('attribution')
  if (QUOTE_SENSITIVE.has(ruleName) && QUOTED.test(sentence)) found.push('quotation')
  return found
}

// Whether a sentence-initial past participle is an adjective, not a claim.
function adjectiveParticiple(matchText, sentence) {
  const parts = pySplit(matchText.replace(PARTICIPLE_PREFIX, ''))
  const verb = parts.length ? capitalize(parts[0].split('-')[0]) : ''
  if (!EN_AMBIGUOUS.has(verb)) return false
  if (ARTIFACT.test(sentence)) return false
  // Like Python's str.find, a miss (-1) still slices from verb.length - 1.
  const tail = sentence.slice(sentence.indexOf(verb) + verb.length)
  return !EN_DETERMINER_OBJECT.test(tail)
}

const isDegenerate = (value) => {
  const stripped = pyStrip(value)
  return !stripped || ['(empty response)', 'None', 'null'].includes(stripped)
}

const degenerate = (digest) =>
  ({ version: GUARD_VERSION, verdict: 'empty', category: 'degenerate', rule: 'empty', digest, hits: [] })

// Guard disabled: deliver everything except output with no usable text.
function passthrough(value) {
  const digest = sha256(value).slice(0, 16)
  if (isDegenerate(value)) return degenerate(digest)
  return { version: GUARD_VERSION, verdict: CLEAN, category: '', rule: '', digest, hits: [] }
}

/**
 * Classify `text` without side effects (Hermes `inspect`).
 * @param {string} text
 * @returns {{ version: string, verdict: string, category: string, rule: string, digest: string, hits: object[] }}
 */
export function inspectAdvice(text) {
  const value = String(text || '')
  const digest = sha256(value).slice(0, 16)
  if (isDegenerate(value)) return degenerate(digest)
  const hits = []
  for (const { name, category, level, pattern } of RULES) {
    for (const match of value.matchAll(pattern)) {
      const start = match.index
      const end = start + match[0].length
      const sentence = sentenceAt(value, start)
      const found = markers(sentence, name)
      let effective = level === QUARANTINE && found.length && MARKER_EXCUSABLE.has(name) ? CANDIDATE : level
      // "Fixed costs are rising" / "Tested components ship separately" are prose.
      if (effective === QUARANTINE && name === 'en_omitted_subject_execution' &&
        adjectiveParticiple(match[0], sentence)) {
        effective = CANDIDATE
      }
      // A nominalized verb ("已完成的部分") is not a completed action, and an observation
      // verb ("我发现测试通过了") reports rather than acts.
      if (effective === QUARANTINE && name === 'cn_omitted_subject_execution') {
        if (value.slice(end, end + 1) === '的') effective = CANDIDATE
        else if (ZH_OBSERVE.test(pyStrip(sentence))) effective = CANDIDATE
      }
      if (effective === QUARANTINE &&
        (name === 'cn_first_person_execution' || name === 'cn_first_person_perfective') &&
        ZH_OBSERVE.test(pyStrip(sentence))) {
        effective = CANDIDATE
      }
      hits.push({
        rule: name,
        category,
        level: effective,
        markers: found,
        span: [start, end],
        snippetSha256: sha256(pyStrip(sentence)).slice(0, 12),
      })
    }
  }
  if (!hits.length) {
    return { version: GUARD_VERSION, verdict: CLEAN, category: '', rule: '', digest, hits }
  }
  const verdict = hits.some((hit) => hit.level === QUARANTINE) ? QUARANTINE : CANDIDATE
  const lead = hits.find((hit) => hit.level === verdict) ?? hits[0]
  return { version: GUARD_VERSION, verdict, category: lead.category, rule: lead.rule, digest, hits }
}

/**
 * Decide what reaches the acting agent (Hermes `isolate`, minus the audit file).
 * @param {string} text  raw reference output
 * @param {{ enabled?: boolean }} [options]  enabled=false → always clean passthrough (still 'empty' on blank)
 * @returns {{ verdict: 'clean'|'candidate'|'quarantine'|'empty', category?: string, rule?: string, digest?: string, text: string, hits?: object[] }}
 */
export function guardAdvice(text, options = {}) {
  const value = String(text || '')
  const result = options.enabled === false ? passthrough(value) : inspectAdvice(value)
  const { verdict, category, rule: ruleName, digest, hits } = result
  let delivered
  if (verdict === 'empty') delivered = DEGENERATE({ category: 'empty' })
  else if (verdict === QUARANTINE) delivered = FAILURE({ category, rule: ruleName, digest })
  else delivered = value.trim()
  return { verdict, category, rule: ruleName, digest, text: delivered, hits }
}
