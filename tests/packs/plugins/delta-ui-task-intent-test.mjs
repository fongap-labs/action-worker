import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideTaskIntentMode, TaskIntentTracker,
} from '#target/packages/delta-ui/lib/task-intent-policy.js'
import { installHostTaskIntent } from '#target/packages/delta-ui/lib/host-task-intent.js'

function harnessFixture(availablePrompt = true) {
  const listeners = new Map()
  let dynamic
  let removed = 0
  const ctx = {
    on(name, callback) {
      listeners.set(name, callback)
      return () => { listeners.delete(name); removed++ }
    },
    inject(services, install) {
      assert.deepEqual(services, ['systemPrompt'])
      const cleanup = install(availablePrompt ? {
        systemPrompt: {
          context(entry) {
            assert.equal(entry.name, 'delta-ui:task-intent')
            assert.equal(entry.interpolate, false)
            dynamic = entry
            return () => { dynamic = undefined }
          },
        },
      } : {})
      return () => { cleanup?.(); dynamic = undefined }
    },
  }
  const dispose = installHostTaskIntent(ctx)
  return {
    listeners, dispose,
    claim(agent, message, source = 'user', turn = 1) {
      listeners.get('agent/inbox/claimed')?.({
        agent, turn, message: { source: { kind: source }, content: [{ type: 'text', text: message }] },
      })
    },
    idle(agent) { listeners.get('agent/status')?.({ agent, status: 'idle' }) },
    release(agent) { listeners.get('agent/disposed')?.({ agent }) },
    guidance(agent) { return dynamic?.text({ agent }) ?? '' },
    get removed() { return removed },
  }
}

describe('Delta Suite universal task intent policy', () => {
  it('covers both substantial coding and non-coding tasks using the same signals', () => {
    const research = 'Prepare a research report\n1. Compare five regulations\n2. Explain their differences\n3. Draft recommendations'
    const coding = 'Refactor the service\n1. Keep compatibility\n2. Add regression tests\n3. Validate the security boundary'
    assert.equal(decideTaskIntentMode(research), 'restate')
    assert.equal(decideTaskIntentMode(coding), 'restate')
    assert.equal(decideTaskIntentMode('Perform an end-to-end workflow implementation'), 'restate')
    assert.equal(decideTaskIntentMode('Rewrite git history'), 'restate')
  })

  it('does not restate ordinary questions just because they are long or technical', () => {
    assert.equal(decideTaskIntentMode('What is a TypeScript interface?'), 'evaluate')
    assert.equal(decideTaskIntentMode('Explain why DROP DATABASE is dangerous'), 'evaluate')
    assert.equal(decideTaskIntentMode('Please explain why rewriting git history is dangerous'), 'evaluate')
    assert.equal(decideTaskIntentMode('Explain why DROP DATABASE is dangerous; then drop database'), 'restate')
    assert.equal(decideTaskIntentMode('Delete the production database'), 'restate')
    assert.equal(decideTaskIntentMode('Hello'), 'evaluate')
    assert.equal(decideTaskIntentMode('a'.repeat(900)), 'evaluate')
    assert.equal(decideTaskIntentMode(''), 'skip')
  })

  it('distinguishes read-only risk questions from consequential instructions', () => {
    assert.equal(decideTaskIntentMode('\u89e3\u91ca\u4e3a\u4ec0\u4e48\u91cd\u5199 git \u5386\u53f2\u5f88\u5371\u9669'), 'evaluate')
    assert.equal(decideTaskIntentMode('Why is force-push risky?'), 'evaluate')
    assert.equal(decideTaskIntentMode('\u89e3\u91ca\u4e3a\u4ec0\u4e48\u91cd\u5199 git \u5386\u53f2\u5f88\u5371\u9669\uff0c\u7136\u540e\u5f3a\u63a8\u4e3b\u5206\u652f'), 'restate')
    assert.equal(decideTaskIntentMode('Force-push and rewrite git history'), 'restate')
  })
  it('honors explicit restatement, user-approved wait and opt-out', () => {
    assert.equal(decideTaskIntentMode('Please restate my instructions'), 'restate')
    assert.equal(decideTaskIntentMode('Please restate my task, wait for my confirmation'), 'wait')
    assert.equal(decideTaskIntentMode('Do not restate my instructions, continue'), 'skip')
    assert.equal(decideTaskIntentMode('\u5148\u590d\u8ff0\u4efb\u52a1\uff0c\u7b49\u6211\u786e\u8ba4'), 'wait')
    assert.equal(decideTaskIntentMode('\u4e0d\u7528\u590d\u8ff0\uff0c\u76f4\u63a5\u505a'), 'skip')
  })

  it('distinguishes continuations, revised requirements, and missing history', () => {
    assert.equal(decideTaskIntentMode('Continue', true), 'skip')
    assert.equal(decideTaskIntentMode('Continue', false), 'evaluate')
    assert.equal(decideTaskIntentMode('\u7ee7\u7eed\u63a8\u8fdb\u4efb\u52a1\u94fe', true), 'skip')
    assert.equal(decideTaskIntentMode('\u7ee7\u7eed\uff0c\u4fdd\u7559\u73b0\u6709\u95e8\u7981', true), 'change')
    assert.equal(decideTaskIntentMode('Change the output to PDF', true), 'change')
    assert.equal(decideTaskIntentMode('Change the output to PDF', false), 'evaluate')
  })

  it('remembers only bounded metadata and isolates per-Agent restatement hints', () => {
    const tracker = new TaskIntentTracker()
    const one = {}, two = {}
    tracker.capture(one, 'SECRET_EXAMPLE: Please restate my task', 3)
    tracker.capture(two, 'Hello', 3)
    assert.match(tracker.guidance(one), /one-time alignment update/)
    assert.doesNotMatch(tracker.guidance(one), /SECRET_EXAMPLE/)
    assert.match(tracker.guidance(two), /clear small tasks/)
    tracker.capture(one, 'Continue', 4)
    assert.equal(tracker.guidance(one), '')
    tracker.capture(one, 'Change the output to PDF', 5)
    assert.match(tracker.guidance(one), /material change/)
    tracker.finishTurn(one)
    assert.equal(tracker.guidance(one), '')
    tracker.release(two)
    assert.equal(tracker.guidance(two), '')
    tracker.dispose()
    assert.equal(tracker.guidance(one), '')
  })
})

describe('Delta Suite native task-intent Host integration', () => {
  it('uses only actual user claims and native prompt context, not tool or injected text', () => {
    const f = harnessFixture()
    const agent = {}, other = {}
    try {
      f.claim(agent, '1. Research\n2. Compare\n3. Deliver', 'tool', 1)
      assert.equal(f.guidance(agent), '')
      f.claim(agent, '1. Research\n2. Compare\n3. Deliver', 'user', 1)
      assert.match(f.guidance(agent), /task-intent coordination/)
      assert.equal(f.guidance(other), '')
      f.claim(agent, '1. Research\n2. Compare\n3. Deliver', 'user', 1)
      assert.match(f.guidance(agent), /briefly restate/)
      f.idle(agent)
      assert.equal(f.guidance(agent), '')
      f.claim(agent, 'Continue', 'user', 2)
      assert.equal(f.guidance(agent), '')
      f.claim(agent, 'Change the acceptance criteria', 'user', 3)
      assert.match(f.guidance(agent), /material change/)
      f.release(agent)
      assert.equal(f.guidance(agent), '')
    } finally {
      f.dispose()
    }
    assert.equal(f.listeners.size, 0)
    assert.equal(f.removed, 3)
  })

  it('does not create another approval gate and respects explicit wait-for-confirmation', () => {
    const f = harnessFixture()
    const agent = {}
    try {
      f.claim(agent, 'Please restate my task, wait for my confirmation')
      assert.match(f.guidance(agent), /do not begin the requested consequential work/)
      assert.match(f.guidance(agent), /Native Host permission decisions remain authoritative/)
      f.claim(agent, 'Review the update\n1. Inspect\n2. Design\n3. Deliver', 'user', 2)
      assert.match(f.guidance(agent), /not a request to wait for approval/)
    } finally {
      f.dispose()
    }
  })

  it('fails closed without optional Host services and detaches handlers on dispose', () => {
    const missingPrompt = harnessFixture(false)
    const agent = {}
    missingPrompt.claim(agent, '1. Research\n2. Compare\n3. Deliver')
    assert.equal(missingPrompt.guidance(agent), '')
    missingPrompt.dispose()
    assert.equal(missingPrompt.listeners.size, 0)
    const disabled = installHostTaskIntent({})
    assert.doesNotThrow(() => disabled())
  })
})
