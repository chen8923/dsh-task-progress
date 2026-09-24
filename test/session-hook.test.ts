/**
 * Session-hook tests: the two facts the surfaces read out of DSH's own client,
 * and the count that explains an empty panel.
 *
 * Only the pure selectors are covered; the React binding around them is a
 * one-line wrapper in `job-roster.ts`.
 *
 * These exist because DSH 0.1.7 moved both facts: the session list no longer
 * carries `current` (the session in view is the one the main view *retains*),
 * and the per-session job mirror left the list for the `ctx.jobs` service. A
 * test that pinned the old spellings would have passed all the way to a blank
 * overlay in production.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countRunningJobs, createRosterSlot, jobRowsOf, mainSessionId } from '../src/client/session-hook.ts'

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

test('the session in view is the one the main view retains', () => {
  // The selector's contract, taken from DSH's own readers of the same state
  // (`ui-layout/DocumentTitle.tsx`, `ui-session`'s `isMain`): a row is in view
  // when something holds it under the `mainView` source. The list's order is
  // not a view; only that hold is.
  assert.equal(mainSessionId({
    byId: {
      'session-a': { retainedBy: {} },
      'session-b': { retainedBy: { mainView: 1 } },
      'session-c': { retainedBy: { mainView: 2 } },
    },
  }), 'session-b', 'the retained session wins over list order')
})

test('no session is in view while nothing holds one', () => {
  assert.equal(mainSessionId(undefined), undefined)
  assert.equal(mainSessionId({}), undefined)
  assert.equal(mainSessionId({ byId: {} }), undefined)
  assert.equal(mainSessionId({ byId: { 'session-a': { retainedBy: {} } } }), undefined)
  assert.equal(mainSessionId({ byId: { 'session-a': {} } }), undefined, 'a row without retention is not in view')
})

test("one session's rows come out of the client roster snapshot", () => {
  const rows = { 'session-a': [{ id: 'bash-1' }, { id: 'bash-2' }] }
  assert.deepEqual(jobRowsOf({ rows }, 'session-a'), [{ id: 'bash-1' }, { id: 'bash-2' }])
  assert.deepEqual(jobRowsOf({ rows }, 'session-b'), [], 'an unwatched session has no key at all')
  assert.deepEqual(jobRowsOf(undefined, 'session-a'), [])
  assert.deepEqual(jobRowsOf({ rows }, undefined), [])
})

test('an absent slice keeps one stable reference, so a selector cannot loop', () => {
  assert.equal(jobRowsOf({ rows: {} }, 'session-a'), jobRowsOf({ rows: {} }, 'session-b'))
})

test('the roster slot starts empty, announces an arrival, and stops on the last unsubscribe', () => {
  const slot = createRosterSlot()
  assert.equal(slot.get(), undefined)
  let notified = 0
  const off = slot.subscribe(() => { notified += 1 })
  const roster = {
    state: { getSnapshot: () => ({ rows: {} }), subscribe: () => () => {} },
    watchRows: () => () => {},
  }

  slot.set(roster)
  assert.equal(slot.get(), roster)
  assert.equal(notified, 1)

  slot.set(roster)
  assert.equal(notified, 1, 'the same reference is not a change')

  off()
  slot.set(undefined)
  assert.equal(notified, 1, 'a released listener is not called')
  off()
  assert.equal(slot.get(), undefined)
})
