/**
 * The shared job-reconciliation rule.
 *
 * Both halves import it: the Host uses it to decide whether a long job deserves
 * a notice in the model's context, and the browser uses it to decide whether a
 * mirror row is a duplicate of a task that already reports. A drift between the
 * two would show one thing and say another, so the rule is one function and
 * these are its edges.
 *
 * The second half of this file covers {@link settleTask}, which is the same
 * question asked about a job that has *ended*: whether the registry proves that
 * a task still saying `running` has no writer left. That rule decides whether a
 * killed script leaves a row that lies forever, so its edges matter more than
 * its happy path — every case below that returns null is a row deliberately left
 * alone.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  jobCanReport, jobElapsedMs, jobIsLive, jobOutcome, labelNamesTask, settledState, settleTask,
  unreportedJobs, type JobView,
} from '../src/jobs.ts'

const job = (over: Partial<JobView> = {}): JobView => ({
  id: 'bash-1',
  kind: 'bash',
  label: 'python sync_catalog.py --task sync-catalog',
  status: 'running',
  startedAt: 1_000,
  ...over,
})

test('a job is live only while running or stopping', () => {
  assert.equal(jobIsLive(job()), true)
  assert.equal(jobIsLive(job({ status: 'stopping' })), true)
  assert.equal(jobIsLive(job({ status: 'completed' })), false)
  assert.equal(jobIsLive(job({ status: 'killed' })), false)
  assert.equal(jobIsLive(job({ status: 'failed' })), false)
  assert.equal(jobIsLive({ id: 'x' }), false, 'a job with no status is not live')
})

test('a delegated agent is a job that never reports in this panel', () => {
  assert.equal(jobCanReport(job()), true)
  assert.equal(jobCanReport(job({ kind: 'subagent' })), false)
})

test('a task name is recognised inside a command label, case aside', () => {
  assert.equal(labelNamesTask('python sync_catalog.py --task sync-catalog', 'sync-catalog'), true)
  assert.equal(labelNamesTask('python Sync_catalog.py --task SYNC-CATALOG', 'sync-catalog'), true)
  assert.equal(labelNamesTask('python sync_catalog.py', 'sync-catalog'), false)
})

test('a name too short to be evidence is never matched', () => {
  // "up" appears in half the commands ever written; matching it would hide a job
  // that reported nothing, which is the failure this plugin exists to fix.
  assert.equal(labelNamesTask('docker compose up -d', 'up'), false)
  assert.equal(labelNamesTask('docker compose up -d', 'co'), false)
})

test('a name glued into a longer word is not a match', () => {
  // The match used to be a plain substring search, so `com` matched `compose`,
  // `load` matched `payload`, and `test` matched `latest`. Each of those is a false
  // positive, and a false positive is the expensive direction: the job counts as
  // covered, so it neither reminds the model nor appears as a reported-nothing row
  // — it simply disappears. A false negative costs one grey row or one reminder, so
  // the doubt resolves against the match. The assertion that used to sit in the test
  // above (`com` inside `compose` is a match) was pinning the behaviour rather than
  // a rule, which is why it moved here as the case that must now fail.
  assert.equal(labelNamesTask('docker compose up -d', 'com'), false)
  assert.equal(labelNamesTask('node payload.mjs', 'load'), false)
  assert.equal(labelNamesTask('npm run latest', 'test'), false)
  assert.equal(labelNamesTask('git commit -m "rebuild the cache"', 'build'), false)
  // A separator is what makes it a name, so the same word inside a path still counts.
  assert.equal(labelNamesTask('node build.mjs', 'build'), true)
  assert.equal(labelNamesTask('python sync_catalog.py --task sync-catalog', 'sync-catalog'), true)
})

test('a name with a dot in it is not a pattern', () => {
  // A task id may contain `.`, and an unescaped `.` in a regular expression matches
  // any character — the same false positive in a different costume. So the name goes
  // into the pattern escaped. (This one is red by mutation rather than by having been
  // written before the fix: the escaping landed with the boundaries.)
  assert.equal(labelNamesTask('run crack.rar now', 'crack.rar'), true)
  assert.equal(labelNamesTask('run crackXrar now', 'crack.rar'), false)
})

test('a name only glued into a longer word still leaves the job unreported', () => {
  // The same rule at the call site where a false match costs something visible: the
  // row would vanish from the panel and the reminder would go quiet, so a job with
  // no reporter would read as reported.
  const composer = job({ id: 'bash-9', label: 'docker compose up -d' })
  assert.deepEqual(unreportedJobs([composer], ['com']).map(entry => entry.id), ['bash-9'])
})

test('a glued name is not proof that a writer existed', () => {
  // And at the settle, where a false match is worse than a missing row: it would
  // stamp an ending onto work that is still running.
  const rebuilt = job({ id: 'bash-9', label: 'npm run rebuild', status: 'killed', startedAt: 1_000, finishedAt: 9_000 })
  assert.equal(settleTask(task({ task: 'build' }), [rebuilt]), null)
})

test('a missing or empty label matches nothing', () => {
  assert.equal(labelNamesTask(undefined, 'build'), false)
  assert.equal(labelNamesTask('', 'build'), false)
  assert.equal(labelNamesTask('build everything', ''), false)
})

test('unreported jobs are live, reportable, and unaccounted for', () => {
  const jobs: JobView[] = [
    job({ id: 'bash-1' }),
    job({ id: 'bash-2', label: 'npm run build', status: 'completed' }),
    job({ id: 'bash-3', kind: 'subagent', label: 'delegate: research' }),
    job({ id: 'bash-4', label: 'node build.mjs' }),
  ]
  const live = unreportedJobs(jobs, ['build'])
  assert.deepEqual(live.map(entry => entry.id), ['bash-1'], 'bash-4 is reporting as "build"')

  assert.deepEqual(unreportedJobs(undefined, ['x']), [], 'no mirror means no rows')
  assert.deepEqual(unreportedJobs(jobs, []).map(entry => entry.id), ['bash-1', 'bash-4'])
})

test('elapsed time comes from the job itself, not from when a report arrived', () => {
  assert.equal(jobElapsedMs(job(), 61_000), 60_000)
  assert.equal(jobElapsedMs(job({ finishedAt: 30_000 }), 61_000), 29_000, 'a settled job keeps its own span')
  assert.equal(jobElapsedMs({ id: 'x' }, 61_000), null, 'no start time, no claim')
  assert.equal(jobElapsedMs(job({ startedAt: 90_000 }), 61_000), 0, 'clock skew never yields a negative span')
})

/** A task that last spoke while a job was running it. */
const task = (over: Partial<{ task: string, updatedAt: number }> = {}) => ({
  task: 'sync-catalog',
  updatedAt: 5_000,
  ...over,
})

test('a terminal job status is the whole outcome vocabulary', () => {
  assert.equal(jobOutcome(job({ status: 'running' })), null)
  assert.equal(jobOutcome(job({ status: 'stopping' })), null)
  assert.equal(jobOutcome(job({ status: 'completed' })), 'completed')
  assert.equal(jobOutcome(job({ status: 'killed' })), 'killed')
  assert.equal(jobOutcome(job({ status: 'failed' })), 'failed')
  assert.equal(jobOutcome({ id: 'x' }), null, 'a status nobody published is not an outcome')
})

test('how a job ended is how the task is read', () => {
  assert.equal(settledState('completed'), 'done')
  assert.equal(settledState('killed'), 'cancelled')
  assert.equal(settledState('failed'), 'failed')
})

test('a task whose job ended is settled from that record', () => {
  const ended = job({ status: 'killed', startedAt: 1_000, finishedAt: 9_000, detail: 'signal: SIGTERM' })
  const settlement = settleTask(task(), [ended])
  assert.equal(settlement?.job.id, 'bash-1')
  assert.equal(settlement?.outcome, 'killed')
  assert.equal(settlement?.state, 'cancelled')
})

test('a live job is never a reason to settle', () => {
  // The reported failure, one step short: the job that was killed is gone, but a
  // second writer with the same name is still working. Settling here would hide
  // work somebody is waiting on, which is the worse failure of the two.
  const killed = job({ id: 'bash-1', status: 'killed', startedAt: 1_000, finishedAt: 9_000 })
  const working = job({ id: 'bash-2', status: 'running', startedAt: 4_000 })
  assert.equal(settleTask(task(), [killed, working]), null)
  assert.equal(settleTask(task(), [working]), null, 'a running job proves nothing')
  assert.equal(settleTask(task(), [job({ id: 'bash-3', status: 'stopping', startedAt: 4_000 })]), null)
})

test('only a job that spanned the task can claim its ending', () => {
  const last = task({ updatedAt: 5_000 })
  // Started after the task's last word: it cannot have written that word.
  assert.equal(settleTask(last, [job({ status: 'killed', startedAt: 6_000, finishedAt: 9_000 })]), null)
  // Ended before the task's last word: something wrote after it, so something
  // was still alive when this job died.
  assert.equal(settleTask(last, [job({ status: 'killed', startedAt: 1_000, finishedAt: 4_000 })]), null)
  // The boundary counts as spanning: a job that ended in the same millisecond as
  // the last report is still the one that stopped writing.
  assert.equal(settleTask(last, [job({ status: 'killed', startedAt: 1_000, finishedAt: 5_000 })])?.outcome, 'killed')
})

test('a record without a finish is not evidence', () => {
  // The registry invariant is that a terminal status carries `finishedAt`; a
  // record violating it is a record to leave alone, not one to guess about.
  assert.equal(settleTask(task(), [job({ status: 'killed', startedAt: 1_000, finishedAt: undefined })]), null)
  assert.equal(settleTask(task(), [job({ status: 'killed', startedAt: undefined, finishedAt: 9_000 })]), null)
  assert.equal(settleTask(task(), undefined), null, 'no mirror means no claim')
  assert.equal(settleTask(task(), []), null)
})

test('the latest ending closes a task that several runs wrote', () => {
  const first = job({ id: 'bash-1', status: 'failed', startedAt: 1_000, finishedAt: 3_000 })
  const second = job({ id: 'bash-2', status: 'killed', startedAt: 4_000, finishedAt: 9_000 })
  assert.equal(settleTask(task({ updatedAt: 8_000 }), [first, second])?.job.id, 'bash-2')
  // Whichever order the registry lists them in.
  assert.equal(settleTask(task({ updatedAt: 8_000 }), [second, first])?.job.id, 'bash-2')
})

test('a job that cannot report is not the writer of a progress file', () => {
  const subagent = job({ kind: 'subagent', label: 'delegate: sync-catalog', status: 'killed', startedAt: 1_000, finishedAt: 9_000 })
  assert.equal(settleTask(task(), [subagent]), null)
})

test('a task no job names is left to its own devices', () => {
  // The panel's job rows read the label the same way: a script whose command
  // line never mentions its task id is invisible to this rule by design, and the
  // honest outcome is a row that keeps reporting whatever the file says.
  assert.equal(settleTask(task({ task: 'nightly' }), [job({ status: 'killed', startedAt: 1_000, finishedAt: 9_000 })]), null)
  assert.equal(settleTask(task({ task: 'ku' }), [job({ status: 'killed', startedAt: 1_000, finishedAt: 9_000 })]), null, 'too short to match')
})
