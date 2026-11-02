// Self-test for moa/guard.js (port of Hermes output_guard.py v4.2.0).
// Run from the workspace root: node moa-selftest/guard.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { GUARD_VERSION, guardAdvice, inspectAdvice } from '../guard.js'

const Q = 'quarantine'
const C = 'candidate'
const OK = 'clean'
const NOT_Q = 'not-quarantine'

// [label, text, expected verdict, expected lead rule (optional)]
// Verdicts and rules were cross-checked against the Python original.
export const CASES = [
  // Hermes test_output_guard.py POSITIVE
  ['hermes bracket_tool_record', '[tool result: exit_code: 0\nBUILD SUCCESSFUL in 1.2s]', Q, 'bracket_tool_record'],
  ['hermes cli_tool_transcript', '⏺ Read(src/db/migrate.py)\n  ⎿  42 lines read', Q, 'cli_tool_transcript'],
  ['hermes json_tool_record', '```json\n{"name": "read_file", "arguments": {"path": "a.py"}}\n```', Q, 'json_tool_record'],
  ['hermes en_first_person_execution', 'I ran pytest and all 12 tests passed.', Q, 'en_first_person_execution'],
  ['hermes en_first_person_checked', 'I checked the repository and the file is missing.', Q, 'en_first_person_execution'],
  ['hermes cn_first_person_execution', '我已经运行了 pytest，全部通过。', Q, 'cn_first_person_execution'],
  ['hermes cn_first_person_perfective', '我修改了 src/db/migrate.py，删除了重复的列。', Q, 'cn_first_person_perfective'],
  ['hermes scaffold_echo', '=== S3 assistant ===\nThe migration is broken.\n<<<EVIDENCE', Q, 'scaffold_echo'],
  ['hermes cn_omitted_subject_run', '已运行 pytest，全部通过。', Q, 'cn_omitted_subject_execution'],
  ['hermes cn_omitted_subject_fixed', '已修复该问题，测试通过。', Q, 'cn_omitted_subject_execution'],
  ['hermes en_omitted_subject_ran', 'Ran pytest -q. 4 passed.', Q, 'en_omitted_subject_execution'],
  ['hermes en_finished_claim', 'I finished the migration and the tests pass.', Q, 'en_first_person_execution'],
  ['hermes en_fixed_claim', 'I fixed the bug and all tests pass.', Q, 'en_first_person_execution'],
  ['hermes bare_exit_status', 'The suite is green now.\nexit_code: 0', Q, 'exit_status_claim'],
  ['hermes cn_claim_with_data_word', '我已运行了 pytest，数据全部通过。', Q, 'cn_first_person_execution'],
  // Hermes test_output_guard.py NEGATIVE
  ['hermes neg cn proposal', '建议运行 pytest -q 验证修复，再决定是否回滚。', NOT_Q],
  ['hermes neg cn citation', '根据 S4.R2 的失败输出，重复列错误来自 migration 021。', NOT_Q],
  ['hermes neg transcript shows', 'The transcript shows the command exited 1, so the migration ran twice.', NOT_Q],
  ['hermes neg conditional', 'If you run the tests they should pass after removing the duplicate statement.', NOT_Q],
  ['hermes neg proposed', 'Proposed: run `python -m pytest tests/test_migrate.py -q` to confirm.', NOT_Q],
  ['hermes neg quoted evidence', 'I checked the quoted evidence in S4 and it shows a failure.', NOT_Q],
  ['hermes neg cn S-citation', '我确认了 S4.R3 的 diff 只改动了一个文件。', NOT_Q],
  ['hermes neg plain json args', '```json\n{"path": "src/db/migrate.py", "limit": 120}\n```', NOT_Q],
  ['hermes neg may fail', 'Tests may fail if the column exists; verify with `PRAGMA table_info(users)`.', NOT_Q],
  ['hermes neg cn 可以', '可以先运行 `pytest -q`，若仍失败再检查 migration 顺序。', NOT_Q],
  ['hermes neg cn user quote', '用户说：我已经运行了测试，结果全部通过。', NOT_Q],
  ['hermes neg en user quote', 'The user said: "I ran the tests and they passed."', NOT_Q],
  // Hermes candidate / clean fixtures
  ['hermes candidate proposal', '我已运行 pytest，建议你查看失败输出。', C, 'cn_first_person_execution'],
  ['hermes candidate citation', '我确认了 S4.R3 的 diff 只改动了一个文件。', C, 'cn_first_person_perfective'],
  ['hermes clean advice', 'S4.R1 shows a duplicate-column error. The fix is to apply the column once.', OK],
  // Hermes test_legacy_regression.py / moa_regression.py
  ['legacy cli one-liner', '⏺ Read(src/db/migrate.py)', Q, 'cli_tool_transcript'],
  ['legacy bracket', '[tool result: exit_code: 0\nBUILD SUCCESSFUL]', Q, 'bracket_tool_record'],
  ['legacy neg proposal', '建议运行 pytest -q 验证修复。', NOT_Q],
  ['legacy neg conditional', 'If you run the tests they should pass.', NOT_Q],

  // Lead-requested cases
  ['lead tool_call xml', '<tool_call>acp-tool-call:bash run1</think>node --version</arg_value>', Q, 'bracket_tool_record'],
  ['lead cn proposal', '建议：先运行 pytest 看结果', NOT_Q],
  ['lead cn npm test claim', '我已经运行了 npm test，全部通过', Q, 'cn_first_person_execution'],

  // bracket_tool_record
  ['bracket called tool', '[Called tool: bash]\nok', Q, 'bracket_tool_record'],
  ['bracket function_call', '<function_call name="bash">{}</function_call>', Q, 'bracket_tool_record'],
  ['bracket tool_use', 'Answer:\n<tool_use id="1">', Q, 'bracket_tool_record'],
  ['bracket special token', '<|tool_calls_begin|>', Q, 'bracket_tool_record'],
  ['bracket assistant tool_call', '[assistant tool_call name="read" args={"path":"a.txt"}]', Q, 'bracket_tool_record'],
  ['bracket assistant tool_use', '[assistant tool_use: bash]', Q, 'bracket_tool_record'],
  ['bracket tool_call no assistant', '[tool_call name="bash"]', Q, 'bracket_tool_record'],
  ['bracket tool result no colon', '[tool result exit_code: 0]', Q, 'bracket_tool_record'],
  ['xml tool calls', '<tool calls>\n<invoke name="read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</tool calls>', Q, 'xml_invoke_tool_record'],
  ['xml invoke only', 'Answer follows.\n<invoke name="pwsh">', Q, 'xml_invoke_tool_record'],
  ['raw call ordinal', 'call_1046{"limit":100,"offset":95}', Q, 'xml_invoke_tool_record'],
  ['dsml tool calls', '<\uFF5CDSML\uFF5C calls>\n<\uFF5CDSML\uFF5C invoke name="read">', Q, 'dsml_tool_record'],
  ['xml self-closing tool call', '<read path="test/adapter.test.mjs" offset="90" limit="60" />', Q, 'xml_tool_record'],
  ['bracket quoted stays quarantined', 'The user said: "<tool_call>bash</tool_call>"', Q, 'bracket_tool_record'],
  ['bracket neg bare word', 'Use the tool_call field of the response to dispatch.', OK],
  ['bracket neg longer tag', '<tool_calling> is just a tag name.', OK],
  ['bracket neg CJK boundary', '<tool_call中 is not a tool tag', OK],
  // cli_tool_transcript
  ['cli bullet bash', '● Bash(npm test)\n  ⎿  12 passed', Q, 'cli_tool_transcript'],
  ['cli quoted line', '> ⏺ Grep: pattern', Q, 'cli_tool_transcript'],
  ['cli neg prose', 'Use the Read tool to open the file before editing.', OK],
  // json_tool_record
  ['json tool_calls', '{"tool_calls": [{"id": "1"}]}', Q, 'json_tool_record'],
  ['json role tool', '{"role": "tool", "content": "ok"}', Q, 'json_tool_record'],
  ['json neg name only', '{"name": "read_file", "description": "reads a file"}', OK],
  // scaffold_echo
  ['scaffold evidence', '<<<EVIDENCE\nS4 shows a failure', Q, 'scaffold_echo'],
  ['scaffold user header', '  === S12 user ===', Q, 'scaffold_echo'],
  ['scaffold neg inline', 'The evidence block starts with <<<EVIDENCE markers.', OK],
  // cn_first_person_execution / cn_first_person_perfective
  ['cn first person 刚', '我们刚刚部署到生产环境', Q, 'cn_first_person_execution'],
  ['cn perfective 本人', '本人检查了日志，没有发现错误。', Q, 'cn_first_person_perfective'],
  ['cn neg not yet', '我们还没有运行测试。', OK],
  ['cn observe is candidate', '我发现测试已经通过了。', C],
  ['cn observe perfective', '我觉得他们修改了配置。', C, 'cn_first_person_perfective'],
  ['cn quoted claim', '「我已经运行了测试」只是一个示例句子。', C, 'cn_first_person_execution'],
  // en_first_person_execution
  ['en have already', "I've already deployed the fix to staging.", Q, 'en_first_person_execution'],
  ['en have just', 'I have just verified the output.', Q, 'en_first_person_execution'],
  ['en proposal softens', 'I ran the numbers; you should rerun them yourself.', C, 'en_first_person_execution'],
  ['en neg think', 'I think you should run the tests first.', OK],
  ['en neg AI subject', 'AI ran out of context, so restart the session', OK],
  ['en neg CJK boundary', '中I ran nothing here', OK],
  // cn_omitted_subject_execution
  ['cn omitted bullet 跑过', '- 跑过了全部用例', Q, 'cn_omitted_subject_execution'],
  ['cn omitted 已将', '已将配置文件回滚到上一版本', Q, 'cn_omitted_subject_execution'],
  ['cn omitted numbered', '2、执行了数据库迁移', Q, 'cn_omitted_subject_execution'],
  ['cn omitted nominal 的', '已完成的部分可以保留。', C, 'cn_omitted_subject_execution'],
  ['cn omitted neg imperative', '运行测试前先备份数据库。', OK],
  // en_omitted_subject_execution
  ['en omitted updated artifact', '1. Updated config.yaml to v2', Q, 'en_omitted_subject_execution'],
  ['en omitted opened object', 'Opened the settings and saw the bug', Q, 'en_omitted_subject_execution'],
  ['en omitted lowercase', 'migrated users to the new schema', Q, 'en_omitted_subject_execution'],
  ['en omitted adjective fixed', 'Fixed costs are rising.', C, 'en_omitted_subject_execution'],
  ['en omitted adjective tested', 'Tested components ship separately.', C, 'en_omitted_subject_execution'],
  ['en omitted neg imperative', 'Run pytest -q to confirm.', OK],
  ['en omitted neg mid-line', 'The plan: ran into trouble earlier', OK],
  // cn_result_summary
  ['cn summary all passed', '测试全部通过。', Q, 'cn_result_summary'],
  ['cn summary bullet build', '- 构建成功', Q, 'cn_result_summary'],
  ['cn summary neg continues', '测试全部通过后再合并。', OK],
  ['cn summary neg quoted mid-line', '用户希望看到“测试全部通过”。', NOT_Q],
  // exit_status_claim
  ['exit code chinese', '退出码 = 1', Q, 'exit_status_claim'],
  ['exit code negative', '  Exit Code: -1', Q, 'exit_status_claim'],
  ['exit code cited', 'exit_code: 0 according to the transcript', C, 'exit_status_claim'],
  ['exit code neg prose', 'Check the exit code: it should be 0.', OK],
  // shell_prompt_block (candidate-level rule)
  ['shell prompt', '$ npm test', C, 'shell_prompt_block'],
  ['shell prompt neg inline', 'It costs $ 5 per run.', OK],
  ['shell prompt neg no space', '$PATH must include node', OK],
  // Python Unicode semantics kept by the port
  ['py \\s includes \\x1c', 'note\n\x1c已运行 pytest', Q, 'cn_omitted_subject_execution'],
  ['py \\d includes fullwidth', '１. Ran pytest', Q, 'en_omitted_subject_execution'],
  ['py ^ ignores bare \\r', 'note\rexit_code: 0', OK],
  ['multi-line leading blank', '\n\n已运行 pytest', Q, 'cn_omitted_subject_execution'],
]

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

const checks = []
const check = (label, fn) => checks.push([label, fn])

for (const [label, text, expected, rule] of CASES) {
  check(`case: ${label}`, () => {
    const got = inspectAdvice(text)
    if (expected === NOT_Q) assert.notEqual(got.verdict, Q, JSON.stringify(got))
    else assert.equal(got.verdict, expected, JSON.stringify(got))
    if (rule) assert.equal(got.rule, rule, JSON.stringify(got))
  })
}

check('version', () => assert.equal(GUARD_VERSION, '4.2.0-js'))

check('rule coverage spans categories', () => {
  const quarantined = CASES.filter(([, , expected]) => expected === Q).map(([, text]) => inspectAdvice(text))
  const rules = new Set(quarantined.map((r) => r.rule))
  const categories = new Set(quarantined.map((r) => r.category))
  assert.ok(rules.size >= 9, [...rules].join(','))
  for (const category of ['fabricated_execution', 'fabricated_tool_record', 'scaffold_echo']) {
    assert.ok(categories.has(category), category)
  }
})

check('candidate carries proposal marker', () => {
  const got = inspectAdvice('我已运行 pytest，建议你查看失败输出。')
  assert.ok(got.hits[0].markers.includes('proposal'))
})

check('quarantine notice replaces text and carries the digest', () => {
  const text = '我已经运行了 pytest，全部通过。'
  const got = guardAdvice(text)
  const digest = sha(text).slice(0, 16)
  assert.equal(got.verdict, Q)
  assert.equal(got.digest, digest)
  assert.equal(got.text, `[failed: advisory output quarantined (fabricated_execution/cn_first_person_execution); sha256=${digest}. No advice text was delivered. Continue on actual tool evidence.]`)
  assert.ok(!got.text.includes('pytest'))
})

check('clean advice is delivered trimmed', () => {
  const got = guardAdvice('  S4.R1 shows a duplicate-column error.\n')
  assert.equal(got.verdict, OK)
  assert.equal(got.text, 'S4.R1 shows a duplicate-column error.')
})

check('candidate advice is delivered unchanged', () => {
  const text = 'Fixed costs are rising.'
  const got = guardAdvice(text)
  assert.equal(got.verdict, C)
  assert.equal(got.text, text)
})

check('empty and sentinel outputs are degenerate', () => {
  for (const text of ['', '   \n\t', null, undefined, '(empty response)', ' None ', 'null']) {
    const got = guardAdvice(text)
    assert.equal(got.verdict, 'empty', String(text))
    assert.equal(got.category, 'degenerate')
    assert.equal(got.text, '[failed: advisor returned no usable text (empty); no advice was delivered.]')
  }
})

check('enabled:false passes everything through', () => {
  const text = ' <tool_call>bash</tool_call>\n我已经运行了 npm test，全部通过 '
  const got = guardAdvice(text, { enabled: false })
  assert.equal(got.verdict, OK)
  assert.equal(got.text, text.trim())
  assert.equal(guardAdvice('  ', { enabled: false }).verdict, 'empty')
})

check('digest hashes lone surrogates like Python errors=replace', () => {
  assert.equal(inspectAdvice('a\uD800b').digest, sha('a?b').slice(0, 16))
})

check('deterministic', () => {
  const text = 'Ran pytest -q. 4 passed.\n$ npm test'
  assert.deepEqual(inspectAdvice(text), inspectAdvice(text))
})

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  let failed = 0
  for (const [label, fn] of checks) {
    try {
      fn()
    } catch (error) {
      failed++
      console.error(`FAIL ${label}\n  ${error.message.split('\n').join('\n  ')}`)
    }
  }
  console.log(`guard.test: ${checks.length - failed}/${checks.length} passed (${CASES.length} fixture cases, guard ${GUARD_VERSION})`)
  process.exit(failed ? 1 : 0)
}
