/**
 * The reminder that reaches the model without anyone editing a file.
 *
 * Most of what is asserted here is not the feature but its containment: a
 * reminder is a courtesy, and a courtesy that can break a model step, nag every
 * turn, or talk the model into restarting finished work is worse than silence.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProgressState } from '../src/protocol.ts'
import type { JobView } from '../src/jobs.ts'
import {
  createReminderMessage, dueForReminder, registerProgressReminder, reminderText,
  type AgentLoopLike, type JobsLike, type PreStepDecisionLike, type PreStepPayload,
} from '../src/host/reminder.ts'

const job = (over: Partial<JobView> = {}): JobView => ({
  id: 'bash-1',
  kind: 'bash',
  label: 'python backfill.py',
  status: 'running',
  startedAt: 0,
  ownerSession: 'session-1',
  ...over,
})

/** A store with no reports at all, which is the incident this exists for. */
const silent = { snapshot: (): ProgressState => ({ v: 1, sessionId: 'session-1', generatedAt: 0, pollMs: 2000, tasks: [] }) }
/** A store reporting one live task by name. */
const reporting = (task: string) => ({
  snapshot: (): ProgressState => ({
    v: 1,
    sessionId: 'session-1',
    generatedAt: 0,
    pollMs: 2000,
    tasks: [{ sessionId: 'session-1', task, state: 'running', pct: 10, msg: '', at: 0, done: null, total: null, unit: null, history: [] }],
  }),
})

test('only a job past the threshold, with nothing reporting for it, is due', () => {
  const now = 100_000
  assert.deepEqual(dueForReminder([job({ startedAt: now - 29_000 })], silent, now, 30_000, new Set()), [])
  assert.deepEqual(
    dueForReminder([job({ startedAt: now - 30_000 })], silent, now, 30_000, new Set()).map(entry => entry.id),
    ['bash-1'],
  )
})

test('a settled job, a delegated agent, and a job with no start time are never due', () => {
  const now = 100_000
  assert.deepEqual(dueForReminder([job({ status: 'completed' })], silent, now, 30_000, new Set()), [])
  assert.deepEqual(dueForReminder([job({ kind: 'subagent' })], silent, now, 30_000, new Set()), [])
  assert.deepEqual(dueForReminder([{ id: 'x', status: 'running' }], silent, now, 30_000, new Set()), [])
})

test('a job the scripts already report for is left alone', () => {
  const now = 100_000
  const candidate = job({ label: 'python backfill.py --task kline-backfill', startedAt: 0 })
  assert.deepEqual(dueForReminder([candidate], reporting('kline-backfill'), now, 30_000, new Set()), [])
  assert.deepEqual(
    dueForReminder([candidate], reporting('something-else'), now, 30_000, new Set()).map(entry => entry.id),
    ['bash-1'],
    'an unrelated report does not cover this job',
  )
})

test('a already-mentioned job stays mentioned', () => {
  const now = 100_000
  assert.deepEqual(dueForReminder([job({ startedAt: 0 })], silent, now, 30_000, new Set(['bash-1'])), [])
})

test('zero disables the reminder rather than meaning "immediately"', () => {
  const now = 100_000
  assert.deepEqual(dueForReminder([job({ startedAt: 0 })], silent, now, 0, new Set()), [])
})

test('the notice forbids the one destructive reading it could invite', () => {
  const text = reminderText([job({ label: 'python backfill.py' })], 30_000)
  assert.match(text, /Do not restart a job that is already running/)
  assert.match(text, /progress panel shows nothing/)
  assert.match(text, /\$DSH_PROGRESS_DIR/)
  assert.match(text, /1 min/, 'the threshold is quoted in minutes')
  assert.match(text, /bash-1 \(python backfill\.py\)/)
})

test('the notice bounds itself: three labels, then a count', () => {
  const many = [1, 2, 3, 4, 5].map(n => job({ id: `bash-${n}`, label: `step ${n}` }))
  const text = reminderText(many, 60_000)
  assert.match(text, /5 background jobs have/)
  assert.match(text, /and 2 more/)
  assert.match(text, /step 1/)
  assert.doesNotMatch(text, /step 4/)
})

test('a long command label is truncated rather than quoted whole', () => {
  const text = reminderText([job({ label: 'x'.repeat(400) })], 30_000)
  assert.ok(text.length < 700, 'the notice stays a notice')
  assert.match(text, /…/)
})

test('the injected message is shaped the way DSH makes user messages', () => {
  const message = createReminderMessage('hello')
  assert.equal(message.role, 'user')
  assert.equal(message.id.length, 36, 'a uuid, like createUserMessage stamps')
  assert.deepEqual(message.source, {
    kind: 'plugin', plugin: 'dsh-task-progress', form: 'notice', summary: 'hello',
  })
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.notEqual(createReminderMessage('hello').id, message.id, 'every notice has its own identity')
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.source), 'messages are frozen before publication')
})

/** A stand-in for the host context, recording what the listener is asked. */
const AGENT = { id: 'session-1' }

function fakeHost(): { ctx: AgentLoopLike, calls: number, fire: (payload: PreStepPayload, decision?: PreStepDecisionLike) => Promise<PreStepDecisionLike> } {
  const state = { calls: 0, listener: null as null | ((p: PreStepPayload, n: () => Promise<PreStepDecisionLike>) => unknown) }
  const ctx: AgentLoopLike = {
    on(_event, listener) {
      state.listener = listener
      return () => { state.listener = null }
    },
  }
  return {
    ctx,
    get calls() { return state.calls },
    // The payload is passed through verbatim; tests that depend on the per-agent
    // memory hand over the same stable agent object every time, the way the host
    // context does across steps of one session.
    async fire(payload, decision = { kind: 'enter', messages: [{ id: 'user-1' }] }) {
      const listener = state.listener
      assert.ok(listener, 'the listener is registered')
      return await listener(payload, async () => { state.calls += 1; return decision }) as PreStepDecisionLike
    },
  }
}

const jobsOf = (list: readonly JobView[]): JobsLike => ({ list: () => list })

test('the listener delegates first and changes nothing when no job is due', async () => {
  const host = fakeHost()
  registerProgressReminder(host.ctx, jobsOf([]), silent, 30_000)
  const decision = await host.fire({ agent: {}, messages: [] })
  assert.equal(host.calls, 1, 'the downstream decision is taken exactly once')
  assert.deepEqual(decision.messages, [{ id: 'user-1' }])
})

test('the listener appends one notice, and only once per job', async () => {
  const host = fakeHost()
  registerProgressReminder(host.ctx, jobsOf([job({ startedAt: Date.now() - 60_000 })]), silent, 30_000)
  const first = await host.fire({ agent: AGENT, messages: [] })
  assert.equal(first.messages?.length, 2, 'the notice rides along with the step')
  const second = await host.fire({ agent: AGENT, messages: [] })
  assert.equal(second.messages?.length, 1, 'the same job is never mentioned twice')
})

test('a rejected step is returned untouched', async () => {
  const host = fakeHost()
  registerProgressReminder(host.ctx, jobsOf([job({ startedAt: 0 })]), silent, 30_000)
  const decision = await host.fire({ agent: {} }, { kind: 'reject' })
  assert.equal(decision.kind, 'reject')
  assert.equal(decision.messages, undefined, 'a veto is not ours to decorate')
})

test('a payload without an agent is left untouched', async () => {
  const host = fakeHost()
  registerProgressReminder(host.ctx, jobsOf([job({ startedAt: 0 })]), silent, 30_000)
  const decision = await host.fire({}, { kind: 'enter', messages: [] })
  assert.deepEqual(decision.messages, [])
})

test('anything failing on our side leaves the step exactly as it was', async () => {
  const throwingJobs: JobsLike = { list() { throw new Error('registry gone') } }
  const host = fakeHost()
  registerProgressReminder(host.ctx, throwingJobs, silent, 30_000)
  const decision = await host.fire({ agent: {}, messages: [] })
  assert.equal(host.calls, 1)
  assert.deepEqual(decision.messages, [{ id: 'user-1' }])

  const throwingStore = { snapshot(): ProgressState { throw new Error('store gone') } }
  const other = fakeHost()
  registerProgressReminder(other.ctx, jobsOf([job({ startedAt: 0 })]), throwingStore, 30_000)
  const second = await other.fire({ agent: {}, messages: [] })
  assert.deepEqual(second.messages, [{ id: 'user-1' }], 'a broken store is not a broken step')
})

test('zero afterMs registers nothing at all', () => {
  let registered = 0
  const ctx: AgentLoopLike = { on() { registered += 1; return () => {} } }
  const dispose = registerProgressReminder(ctx, jobsOf([]), silent, 0)
  assert.equal(registered, 0, 'a disabled reminder holds no listener')
  dispose()
})

test('a job that disappears and returns is mentioned again', async () => {
  const host = fakeHost()
  let list: JobView[] = [job({ startedAt: Date.now() - 60_000 })]
  registerProgressReminder(host.ctx, { list: () => list }, silent, 30_000)
  await host.fire({ agent: AGENT, messages: [] })
  list = []
  await host.fire({ agent: AGENT, messages: [] })
  list = [job({ startedAt: Date.now() - 60_000 })]
  const third = await host.fire({ agent: AGENT, messages: [] })
  assert.equal(third.messages?.length, 2, 'the memory forgets ids that are no longer live, so it stays bounded')
})
