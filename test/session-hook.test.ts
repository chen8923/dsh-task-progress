/**
 * Session-hook tests: the count that explains an empty panel.
 *
 * Only the pure selector is covered; the hook around it is a one-line binding to
 * the slot's standard prop.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countRunningJobs } from '../src/client/session-hook.ts'

test('live jobs are running and stopping; everything else is settled', () => {
  assert.equal(countRunningJobs([
    { status: 'running' },
    { status: 'stopping' },
    { status: 'completed' },
    { status: 'failed' },
    { status: 'killed' },
  ]), 2)
})

test('a session with no jobs, or no mirror at all, counts zero', () => {
  assert.equal(countRunningJobs(undefined), 0)
  assert.equal(countRunningJobs([]), 0)
  assert.equal(countRunningJobs([{ status: 'completed' }]), 0)
})

test('a row without a status is not counted as live', () => {
  assert.equal(countRunningJobs([{}, { status: 'running' }]), 1)
})
