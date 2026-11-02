import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeScheduler, schedulerFromDecision } from '../scheduler.js'
import { openAiSchedulerRequest } from '../scheduler-openai.js'

for (const api of ['openai-completions', 'anthropic-messages', 'openai-responses', undefined]) {
  test(`modern compatible judge requires an explicit model (${api ?? 'default protocol'})`, () => {
    const config = schedulerFromDecision({ kind: 'openai-compatible', api })
    assert.equal(config.openaiModel, '')
    assert.throws(() => openAiSchedulerRequest(config, 'test'), /model is required/)
  })
}
test('legacy dedicated Luna and explicit configured models retain their routes', () => {
  assert.equal(openAiSchedulerRequest(normalizeScheduler({kind: 'openai'}), 'test').body.model, 'gpt-6-luna')
  const config = schedulerFromDecision({kind: 'openai-compatible', api: 'anthropic-messages', model: 'my-judge'})
  assert.equal(openAiSchedulerRequest(config, 'test').body.model, 'my-judge')
})
