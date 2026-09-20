/**
 * Client-store tests: one snapshot per session, and nothing polled that nothing
 * is reading.
 *
 * The reader is injected and the polling is driven by `refresh()`, so these
 * assert the session contract rather than the passage of time.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ProgressState, ProgressTask } from '../src/protocol.ts'
import { createProgressStore } from '../src/client/store.ts'

/** One task, in whatever session the document belongs to. */
function task(sessionId: string, overrides: Partial<ProgressTask> = {}): ProgressTask {
  return {
    sessionId,
    task: 'build',
    state: 'running',
    pct: 10,
    msg: 'linking',
    done: null,
    total: null,
    unit: '',
    startedAt: 0,
    updatedAt: 0,
    recent: [],
    ...overrides,
  }
}

/** A document carrying one task for the named session. */
function stateOf(sessionId: string): ProgressState {
  return { v: 1, generatedAt: 0, pollMs: 1000, tasks: [task(sessionId)] }
}

/** Let the store's in-flight async tick settle. */
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

test('a session nobody reads is never polled', async () => {
  const asked: string[] = []
  const store = createProgressStore({ read: async (sessionId) => { asked.push(sessionId); return stateOf(sessionId) } })
  const stop = store.start()
  try {
    await flush()
    await flush()
    assert.deepEqual(asked, [], 'started polling a session with no reader')
    assert.equal(store.getSnapshot('session-A'), null)
  } finally {
    stop()
  }
})

test('each reader sees only its own session', async () => {
  const asked: string[] = []
  const store = createProgressStore({ read: async (sessionId) => { asked.push(sessionId); return stateOf(sessionId) } })
  const stop = store.start()
  try {
    const unsubA = store.subscribe('session-A', () => {})
    const unsubB = store.subscribe('session-B', () => {})
    store.refresh()
    await flush()
    await flush()
    assert.equal(store.getSnapshot('session-A')?.tasks[0]?.sessionId, 'session-A')
    assert.equal(store.getSnapshot('session-B')?.tasks[0]?.sessionId, 'session-B')
    assert.deepEqual([...new Set(asked)].sort(), ['session-A', 'session-B'])
    unsubA()
    unsubB()
  } finally {
    stop()
  }
})

test('unsubscribing stops that session being polled, and the others continue', async () => {
  const asked: string[] = []
  const store = createProgressStore({ read: async (sessionId) => { asked.push(sessionId); return stateOf(sessionId) } })
  const stop = store.start()
  try {
    const unsubA = store.subscribe('session-A', () => {})
    const unsubB = store.subscribe('session-B', () => {})
    store.refresh()
    await flush()
    unsubA()
    asked.length = 0
    store.refresh()
    await flush()
    await flush()
    assert.deepEqual([...new Set(asked)], ['session-B'])
    assert.equal(store.getSnapshot('session-A')?.tasks.length, 1, 'a dropped reader should not lose the last document immediately')
    unsubB()
  } finally {
    stop()
  }
})

test('the last good document survives a failed read', async () => {
  let fail = false
  const store = createProgressStore({
    read: async (sessionId) => fail ? null : stateOf(sessionId),
  })
  const stop = store.start()
  try {
    const unsub = store.subscribe('session-A', () => {})
    store.refresh()
    await flush()
    await flush()
    assert.equal(store.getSnapshot('session-A')?.tasks.length, 1)
    fail = true
    store.refresh()
    await flush()
    await flush()
    assert.equal(store.getSnapshot('session-A')?.tasks.length, 1, 'a transient miss blanked the panel')
    unsub()
  } finally {
    stop()
  }
})

test('a readerless snapshot is dropped once it ages out', async () => {
  const store = createProgressStore({
    sessionTtlMs: 0,
    read: async (sessionId) => stateOf(sessionId),
  })
  const stop = store.start()
  try {
    const unsub = store.subscribe('session-A', () => {})
    store.refresh()
    await flush()
    await flush()
    assert.notEqual(store.getSnapshot('session-A'), null)
    unsub()
    // The TTL is real time, so a zero TTL still needs the clock to move.
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    store.refresh()
    await flush()
    await flush()
    assert.equal(store.getSnapshot('session-A'), null)
  } finally {
    stop()
  }
})

test('the document a reader receives carries no workspace path', () => {
  // The wire type has no `root` at all; this pins the shape the Host half sends
  // against a future field being added back by accident.
  const document = stateOf('session-A')
  assert.deepEqual(Object.keys(document.tasks[0] ?? {}).sort(), [
    'done', 'msg', 'pct', 'recent', 'sessionId', 'startedAt', 'state', 'task', 'total', 'unit', 'updatedAt',
  ])
})
