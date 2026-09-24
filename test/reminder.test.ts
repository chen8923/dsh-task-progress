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
  label: 'python sync_catalog.py',
  status: 'running',
  startedAt: 0,
  // The registry's own field name, matching `@deepseek-ai/dsh-jobs/view`:
  // `owner` is the owning session id, absent on an unowned job.
  owner: 'session-1',
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

/**
 * A store that answers only for the session it is asked about.
 *
 * `silent` and `reporting` ignore their session argument, which is fine for the
 * rules they pin — but it would hide a projection reading the wrong field name,
 * so the coverage rules below are judged against this one.
 */
const reportingOnly = (sessionId: string, task: string) => ({
  snapshot: (_now?: number, asked?: string): ProgressState => ({
    v: 1,
    sessionId,
    generatedAt: 0,
    pollMs: 2000,
    tasks: asked === sessionId
      ? [{ sessionId, task, state: 'running', pct: 10, msg: '', at: 0, done: null, total: null, unit: null, history: [] }]
      : [],
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
  const candidate = job({ label: 'python sync_catalog.py --task sync-catalog', startedAt: 0 })
  assert.deepEqual(dueForReminder([candidate], reporting('sync-catalog'), now, 30_000, new Set()), [])
  assert.deepEqual(
    dueForReminder([candidate], reporting('something-else'), now, 30_000, new Set()).map(entry => entry.id),
    ['bash-1'],
    'an unrelated report does not cover this job',
  )
})

test('a report whose name is only glued into the label does not cover the job', () => {
  // Coverage runs through the same rule as the row and the settle. Under a plain
  // substring match, a task called `com` would cover a `docker compose` job, and the
  // reminder — the one thing this notice exists to send — would stay silent for work
  // nobody is reporting for.
  const now = 100_000
  const composer = job({ label: 'docker compose up -d', startedAt: 0 })
  assert.deepEqual(
    dueForReminder([composer], reporting('com'), now, 30_000, new Set()).map(entry => entry.id),
    ['bash-1'],
  )
})

test('coverage is judged against the job owner the registry reports', () => {
  // The field the registry spells `owner` is the session the reported task
  // belongs to. Read under any other name it is always undefined, the task store
  // is then asked about no session at all, and every live job looks uncovered —
  // the reminder would nag for work that is reporting perfectly well.
  const now = 100_000
  const covered = job({ label: 'python sync_catalog.py --task sync-catalog', startedAt: 0 })
  assert.deepEqual(
    dueForReminder([covered], reportingOnly('session-1', 'sync-catalog'), now, 30_000, new Set()),
    [],
    'a task reported by the job owner covers it',
  )
  assert.deepEqual(
    dueForReminder([job({ owner: 'session-2', label: 'python sync_catalog.py --task sync-catalog', startedAt: 0 })],
      reportingOnly('session-1', 'sync-catalog'), now, 30_000, new Set()).map(entry => entry.id),
    ['bash-1'],
    'another session publishing the same task name does not cover this job',
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
  const text = reminderText([job({ label: 'python sync_catalog.py' })], 30_000)
  assert.match(text, /Do not restart a job that is already running/)
  assert.match(text, /progress panel shows nothing/)
  assert.match(text, /\$DSH_PROGRESS_DIR/)
  // The threshold is quoted at the resolution it was given. This asked for
  // `/1 min/` and so pinned the bug rather than catching it: a 30-second bar was
  // announced as "over 1 min", overstating how long the job had been quiet and
  // hiding that the deployment had asked for a much shorter one.
  assert.match(text, /over 30 s/, 'a 30-second threshold is quoted in seconds')
  assert.doesNotMatch(text, /1 min/, 'and never rounded up into a whole minute')
  assert.match(text, /bash-1 \(python sync_catalog\.py\)/)
})

test('the notice offers saying so in the conversation as a way to discharge it', () => {
  // The convention is "report progress", and a job that genuinely cannot report has
  // no way to satisfy it — a compiled tool with no hook, work already too far along.
  // The notice names the honest fallback for that case rather than leaving the model
  // to invent one. This clause is the whole of "acknowledged in the conversation
  // counts": the plugin cannot observe what the model says to the user, so the policy
  // is this sentence plus the per-job memory above, which is what stops the reminder
  // repeating whether the model reports or explains.
  //
  // It is red by mutation rather than by having been written first: the sentence
  // shipped before anything asserted it, so deleting it was invisible.
  const text = reminderText([job({ label: 'hsdpkg --status' })], 30_000)
  assert.match(text, /have it append progress events/, 'the preferred path is still reporting')
  assert.match(text, /if it cannot, tell the user these jobs have no progress detail/, 'and the fallback is saying so')
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

/**
 * A registry standing in for `ctx.jobs`, with the caller filter the real one has.
 *
 * `JobRegistry.list(caller?: SessionId)` answers the calling *session*: an owned
 * job is visible only when `job.owner.id === caller`, and a caller it does not
 * recognise sees unowned jobs alone. The fake therefore answers only for the id
 * below, so a caller that hands over anything else — an agent object, say — is
 * answered with nothing, exactly as the registry would.
 */
const jobsOf = (list: readonly JobView[]): JobsLike => ({
  list: (caller?: string) => caller === 'session-1' ? list : [],
})

test('the registry is asked as the calling session, which is what its filter compares', async () => {
  const seen: unknown[] = []
  const host = fakeHost()
  registerProgressReminder(host.ctx, { list: (caller?: string) => { seen.push(caller); return [] } }, silent, 30_000)
  await host.fire({ agent: AGENT, messages: [] })
  assert.deepEqual(seen, ['session-1'], 'the caller is the session id the registry compares against job.owner.id')
})

test('a step whose agent carries no session is left alone rather than asked with nothing', async () => {
  const seen: unknown[] = []
  const host = fakeHost()
  registerProgressReminder(host.ctx, { list: (caller?: string) => { seen.push(caller); return [] } }, silent, 30_000)
  const decision = await host.fire({ agent: {}, messages: [] })
  assert.deepEqual(decision.messages, [{ id: 'user-1' }], 'the step keeps exactly the messages it already had')
  assert.deepEqual(seen, [], 'the registry is never consulted without a session to ask about')
})

test('the listener delegates first and changes nothing when no job is due', async () => {
  const host = fakeHost()
  registerProgressReminder(host.ctx, jobsOf([]), silent, 30_000)
  const decision = await host.fire({ agent: AGENT, messages: [] })
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
  const decision = await host.fire({ agent: AGENT }, { kind: 'reject' })
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
  const decision = await host.fire({ agent: AGENT, messages: [] })
  assert.equal(host.calls, 1)
  assert.deepEqual(decision.messages, [{ id: 'user-1' }])

  const throwingStore = { snapshot(): ProgressState { throw new Error('store gone') } }
  const other = fakeHost()
  registerProgressReminder(other.ctx, jobsOf([job({ startedAt: 0 })]), throwingStore, 30_000)
  const second = await other.fire({ agent: AGENT, messages: [] })
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
