/**
 * Presentation tests: the selection rules both surfaces share, and the derived
 * figures. These are the rules a user actually notices when they are wrong.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProgressState, ProgressTask } from '../src/protocol.ts'
import {
  OVERLAY_LINGER_MS,
  countRunning,
  estimateRemainingMs,
  formatClock,
  formatDuration,
  formatPct,
  headlineTask,
  isStalled,
  overlayPolicy,
  selectTasks,
  tailLines,
  unitText,
} from '../src/client/format.ts'

/** A task with sane defaults, overridden per test. */
function task(overrides: Partial<ProgressTask> = {}): ProgressTask {
  return {
    sessionId: 's1',
    root: '/w',
    task: 'build',
    state: 'running',
    pct: 50,
    msg: '',
    done: null,
    total: null,
    unit: '',
    startedAt: 0,
    updatedAt: 0,
    recent: [],
    ...overrides,
  }
}

/** A one-session document around the given tasks. */
function state(tasks: readonly ProgressTask[]): ProgressState {
  return { v: 1, generatedAt: 0, pollMs: 2000, tasks }
}

test('durations stay in at most two units', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(12_400), '12s')
  assert.equal(formatDuration(184_000), '3m04s')
  assert.equal(formatDuration(3_720_000), '1h02m')
  assert.equal(formatDuration(-5), '0s')
})

test('percentages are rounded and never invented', () => {
  assert.equal(formatPct(42.4), '42%')
  assert.equal(formatPct(0), '0%')
  assert.equal(formatPct(null), '—')
})

test('unit text needs both numbers', () => {
  assert.equal(unitText(task({ done: 3, total: 9, unit: 'files' })), '3/9 files')
  assert.equal(unitText(task({ done: 3, total: 9 })), '3/9')
  assert.equal(unitText(task({ done: 3 })), null)
  assert.equal(unitText(task({ done: 0, total: 0 })), null)
})

test('a remaining estimate needs both movement and time', () => {
  assert.equal(estimateRemainingMs(task({ pct: 50, startedAt: 0 }), 4_000), null)
  assert.equal(estimateRemainingMs(task({ pct: 2, startedAt: 0 }), 60_000), null)
  assert.equal(estimateRemainingMs(task({ pct: 100, startedAt: 0 }), 60_000), null)
  assert.equal(estimateRemainingMs(task({ state: 'done', pct: 50, startedAt: 0 }), 60_000), null)
  assert.equal(estimateRemainingMs(task({ pct: 50, startedAt: 0 }), 100_000), 100_000)
})

test('a quiet running task is called out', () => {
  assert.equal(isStalled(task({ state: 'running', updatedAt: 0 }), 90_000), true)
  assert.equal(isStalled(task({ state: 'running', updatedAt: 0 }), 30_000), false)
  assert.equal(isStalled(task({ state: 'done', updatedAt: 0 }), 90_000), false)
})

test('selection scopes to one session', () => {
  const tasks = [task({ task: 'a', sessionId: 's1' }), task({ task: 'b', sessionId: 's2' })]
  assert.deepEqual(selectTasks(state(tasks), 's2', 0, 'all').map(row => row.task), ['b'])
  assert.deepEqual(selectTasks(state(tasks), undefined, 0, 'all').map(row => row.task), ['a', 'b'])
})

test('the compact mode keeps a short tail of finished work', () => {
  const tasks = [task({ task: 'done', state: 'done', updatedAt: 1000 }), task({ task: 'old', state: 'done', updatedAt: 0 })]
  const now = 1000 + OVERLAY_LINGER_MS - 1
  assert.deepEqual(selectTasks(state(tasks), undefined, now, 'active').map(row => row.task), ['done'])
  assert.deepEqual(
    selectTasks(state(tasks), undefined, 1000 + OVERLAY_LINGER_MS + 1, 'active').map(row => row.task),
    [],
  )
  // The sidebar keeps everything the Host half still retains.
  assert.equal(selectTasks(state(tasks), undefined, 10 ** 9, 'all').length, 2)
})

test('an empty or missing document selects nothing', () => {
  assert.deepEqual(selectTasks(null, 's1', 0, 'all'), [])
  assert.deepEqual(selectTasks(state([]), 's1', 0, 'active'), [])
})

test('counts and headline pick the moving task', () => {
  const running = task({ task: 'r', state: 'running', updatedAt: 10 })
  const finished = task({ task: 'f', state: 'done', updatedAt: 99 })
  assert.equal(countRunning([running, finished]), 1)
  assert.equal(headlineTask([finished, running])?.task, 'r')
  // With nothing running, the newest row speaks for the group.
  assert.equal(headlineTask([finished, task({ task: 'f2', state: 'done', updatedAt: 100 })])?.task, 'f2')
  assert.equal(headlineTask([]), null)
})

test('the clock is local wall time', () => {
  const stamp = new Date(2024, 0, 2, 3, 4, 5).getTime()
  assert.equal(formatClock(stamp), '03:04:05')
})

test('the floating surface only summons itself for work the user asked to watch', () => {
  // Nothing at all: an idle session grows no widget.
  assert.deepEqual(overlayPolicy({ reported: 0, unreported: 0, allowUnreported: false }), { visible: false, warn: false })

  // Reported work: the pill is the point of the plugin, so it shows.
  assert.deepEqual(overlayPolicy({ reported: 2, unreported: 0, allowUnreported: false }), { visible: true, warn: false })
  assert.deepEqual(overlayPolicy({ reported: 1, unreported: 3, allowUnreported: false }), { visible: true, warn: false })

  // Only unreported jobs: by default that is not a reason to interrupt anybody —
  // the sidebar tab still lists them, which is where a reader who cares looks.
  assert.deepEqual(overlayPolicy({ reported: 0, unreported: 3, allowUnreported: false }), { visible: false, warn: false })

  // Opted in, the same state shows and shows in the attention colour: the row is
  // a job nobody is reporting for, and saying so is the whole reason it is there.
  assert.deepEqual(overlayPolicy({ reported: 0, unreported: 3, allowUnreported: true }), { visible: true, warn: true })
})

test('an observed output tail is reduced to its last few lines', () => {
  // The tail is whatever DSH streamed, so it can be thousands of lines and any
  // width at all. A row shows the most recent few, clipped: the question it
  // answers is "what is this doing right now", not "show me the log".
  assert.deepEqual(tailLines('a\nb\nc\nd\ne'), ['c', 'd', 'e'], 'the most recent lines win')
  assert.deepEqual(tailLines('a\nb\n'), ['a', 'b'], 'a trailing newline is not an empty line')
  assert.deepEqual(tailLines('a\n\n\n'), ['a'], 'and neither is a run of them')
  assert.deepEqual(tailLines('  a  \n  b  '), ['a', 'b'], 'each line is trimmed for display')
  assert.deepEqual(tailLines(''), [], 'nothing to show is nothing')
  assert.deepEqual(tailLines('   \n  '), [], 'whitespace alone is nothing to show')
  assert.deepEqual(tailLines('one\ntwo', 1), ['two'], 'the line cap is honoured')
})

test('a very wide tail line is clipped rather than wrapped', () => {
  const long = 'x'.repeat(400)
  const [line] = tailLines(long)
  assert.ok(line !== undefined)
  assert.ok(line.length <= 96, 'a row stays one line high')
  assert.match(line, /…$/, 'and says so when it clipped')
})
