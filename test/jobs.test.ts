/**
 * The shared job-reconciliation rule.
 *
 * Both halves import it: the Host uses it to decide whether a long job deserves
 * a notice in the model's context, and the browser uses it to decide whether a
 * mirror row is a duplicate of a task that already reports. A drift between the
 * two would show one thing and say another, so the rule is one function and
 * these are its edges.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  jobCanReport, jobElapsedMs, jobIsLive, labelNamesTask, unreportedJobs, type JobView,
} from '../src/jobs.ts'

const job = (over: Partial<JobView> = {}): JobView => ({
  id: 'bash-1',
  kind: 'bash',
  label: 'python backfill.py --task kline-backfill',
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
  assert.equal(labelNamesTask('python backfill.py --task kline-backfill', 'kline-backfill'), true)
  assert.equal(labelNamesTask('python Backfill.py --task KLINE-BACKFILL', 'kline-backfill'), true)
  assert.equal(labelNamesTask('python backfill.py', 'kline-backfill'), false)
})

test('a name too short to be evidence is never matched', () => {
  // "up" appears in half the commands ever written; matching it would hide a job
  // that reported nothing, which is the failure this plugin exists to fix.
  assert.equal(labelNamesTask('docker compose up -d', 'up'), false)
  assert.equal(labelNamesTask('docker compose up -d', 'co'), false)
  assert.equal(labelNamesTask('docker compose up -d', 'com'), true)
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
