/**
 * Store tests: the fold rules, the change detection, and the caps — the parts a
 * producer can get wrong in a way that only shows up as a stuck bar.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DEFAULTS, readConfig } from '../src/host/config.ts'
import { createTaskStore } from '../src/host/store.ts'

/** A store over a throwaway workspace, plus the paths a test writes to. */
function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dtp-'))
  const resolved = readConfig({ ...config, dirName: '.dsh-progress' })
  const store = createTaskStore(resolved)
  store.addRoot(root)
  const sessionId = 'session-1'
  const dir = store.remember(root, sessionId)
  assert.ok(dir, 'remember() must return the session directory')
  return {
    root,
    store,
    dir,
    sessionId,
    file: (task: string) => join(dir, `${task}.jsonl`),
    write: (task: string, lines: readonly unknown[]) => {
      writeFileSync(join(dir, `${task}.jsonl`), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    },
    append: (task: string, line: unknown) => {
      appendFileSync(join(dir, `${task}.jsonl`), `${JSON.stringify(line)}\n`, 'utf8')
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('remember() creates the directory a producer will write to', () => {
  const f = fixture()
  try {
    assert.ok(f.dir.startsWith(f.root))
  } finally {
    f.cleanup()
  }
})

test('remember() refuses a session id that is not a safe path segment', () => {
  const f = fixture()
  try {
    assert.equal(f.store.remember(f.root, '../escape'), null)
    assert.equal(f.store.remember(f.root, ''), null)
  } finally {
    f.cleanup()
  }
})

test('the fold keeps the latest value of every field', () => {
  const f = fixture()
  try {
    f.write('build', [
      { v: 1, task: 'build', state: 'running', pct: 10, msg: 'first', at: 1000 },
      { v: 1, task: 'build', pct: 60, msg: 'second', at: 2000 },
    ])
    f.store.scan(3000)
    const [task] = f.store.snapshot(3000).tasks
    assert.equal(task?.task, 'build')
    assert.equal(task?.state, 'running')
    assert.equal(task?.pct, 60)
    assert.equal(task?.msg, 'second')
    assert.equal(task?.startedAt, 1000)
    assert.equal(task?.updatedAt, 2000)
    assert.deepEqual(task?.recent, ['first', 'second'])
  } finally {
    f.cleanup()
  }
})

test('done without a percentage fills the bar, and a fresh run resets the clock', () => {
  const f = fixture()
  try {
    f.write('job', [{ task: 'job', state: 'done', msg: 'ok', at: 1000 }])
    f.store.scan(1000)
    assert.equal(f.store.snapshot(1000).tasks[0]?.pct, 100)

    f.append('job', { task: 'job', state: 'running', msg: 'again', at: 5000 })
    f.store.scan(5000)
    const [task] = f.store.snapshot(5000).tasks
    assert.equal(task?.state, 'running')
    assert.equal(task?.pct, null)
    assert.equal(task?.startedAt, 5000)
    assert.deepEqual(task?.recent, ['again'])
  } finally {
    f.cleanup()
  }
})

test('a percentage is derived from done/total when it is not reported', () => {
  const f = fixture()
  try {
    f.write('job', [{ task: 'job', done: 3, total: 4, unit: 'files', at: 1 }])
    f.store.scan(1)
    assert.equal(f.store.snapshot(1).tasks[0]?.pct, 75)
    assert.equal(f.store.snapshot(1).tasks[0]?.unit, 'files')
  } finally {
    f.cleanup()
  }
})

test('the file name is the default task id', () => {
  const f = fixture()
  try {
    f.write('nightly', [{ pct: 5, at: 1 }])
    f.store.scan(1)
    assert.equal(f.store.snapshot(1).tasks[0]?.task, 'nightly')
  } finally {
    f.cleanup()
  }
})

test('unchanged files are not re-folded, and a moved clock still is', () => {
  const f = fixture()
  try {
    f.write('build', [{ task: 'build', pct: 10, at: 1 }])
    f.store.scan(1)
    const first = f.store.snapshot(1).tasks[0]
    f.store.scan(2)
    // Nothing moved, so the second scan reports exactly the same task. (The
    // skip itself is a cost optimization: snapshot() copies every row it
    // returns, so identity is deliberately not the observable.)
    assert.deepEqual(f.store.snapshot(2).tasks[0], first)

    // A rewrite that keeps the byte count must still be seen: the change signal
    // is size AND mtime, so a newer clock is enough on its own.
    f.write('build', [{ task: 'build', pct: 90, at: 9 }])
    utimesSync(f.file('build'), new Date(2000), new Date(2000))
    f.store.scan(3)
    assert.equal(f.store.snapshot(3).tasks[0]?.pct, 90)

    // An append changes the size, which is what producers normally do.
    f.append('build', { task: 'build', pct: 95, at: 10 })
    f.store.scan(4)
    assert.equal(f.store.snapshot(4).tasks[0]?.pct, 95)
  } finally {
    f.cleanup()
  }
})

test('terminal tasks age out; running ones never do', () => {
  const f = fixture({ retainMs: 1000 })
  try {
    f.write('old', [{ task: 'old', state: 'done', at: 1000 }])
    f.write('live', [{ task: 'live', state: 'running', at: 1000 }])
    f.store.scan(1500)
    assert.equal(f.store.snapshot(1500).tasks.length, 2)
    f.store.scan(1000 + 1001 + 1000)
    const tasks = f.store.snapshot(3001).tasks
    assert.deepEqual(tasks.map(task => task.task), ['live'])
  } finally {
    f.cleanup()
  }
})

test('a vanished directory stops being tracked', () => {
  const f = fixture()
  try {
    f.write('build', [{ task: 'build', pct: 10, at: 1 }])
    f.store.scan(1)
    assert.equal(f.store.stats().files, 1)
    rmSync(f.dir, { recursive: true, force: true })
    f.store.scan(2)
    assert.equal(f.store.stats().files, 0)
    assert.equal(f.store.snapshot(2).tasks.length, 0)
  } finally {
    f.cleanup()
  }
})

test('only files whose last bytes fit the ceiling are read, and the torn head is dropped', () => {
  const f = fixture({ maxFileBytes: 4096 })
  try {
    const big = 'x'.repeat(2000)
    const lines = [
      { task: 'big', state: 'running', pct: 1, msg: big, at: 1 },
      { task: 'big', pct: 2, msg: big, at: 2 },
      { task: 'big', pct: 3, msg: big, at: 3 },
    ]
    f.write('big', lines)
    f.store.scan(3)
    // The surviving record is the last one written before the ceiling cut in,
    // and no fragment of a partial line was parsed as a task.
    const tasks = f.store.snapshot(3).tasks
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]?.pct, 3)
  } finally {
    f.cleanup()
  }
})

test('snapshot ranks running tasks first and caps the list', () => {
  const f = fixture({ maxTasks: 2 })
  try {
    f.write('a', [{ task: 'a', state: 'done', at: 5000 }])
    f.write('b', [{ task: 'b', state: 'running', at: 1000 }])
    f.write('c', [{ task: 'c', state: 'done', at: 9000 }])
    f.store.scan(9000)
    const tasks = f.store.snapshot(9000).tasks
    assert.equal(tasks.length, 2)
    assert.equal(tasks[0]?.task, 'b')
    assert.equal(tasks[1]?.task, 'c')
  } finally {
    f.cleanup()
  }
})

test('recent messages are bounded on the wire', () => {
  const f = fixture({ historyLimit: 50 })
  try {
    const lines = Array.from({ length: 20 }, (_, index) => ({ task: 'chatty', msg: `m${index}`, at: index }))
    f.write('chatty', lines)
    f.store.scan(20)
    assert.equal(f.store.snapshot(20).tasks[0]?.recent.length, 5)
  } finally {
    f.cleanup()
  }
})

test('a scan of a root with no progress directory is harmless', () => {
  const root = mkdtempSync(join(tmpdir(), 'dtp-empty-'))
  try {
    const store = createTaskStore(readConfig({}))
    store.addRoot(root)
    store.addRoot(join(root, 'does-not-exist'))
    store.scan(1)
    assert.deepEqual(store.snapshot(1).tasks, [])
    assert.equal(store.stats().dirs, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a discovered root picks up session directories it did not remember', () => {
  const root = mkdtempSync(join(tmpdir(), 'dtp-discover-'))
  try {
    const dir = join(root, CONFIG_DEFAULTS.dirName, 'other-session')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'build.jsonl'), '{"task":"build","pct":7}\n', 'utf8')
    const store = createTaskStore(readConfig({}))
    store.addRoot(root)
    store.scan(1)
    const [task] = store.snapshot(1).tasks
    assert.equal(task?.task, 'build')
    assert.equal(task?.sessionId, 'other-session')
    assert.equal(task?.pct, 7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('config falls back to defaults and clamps hostile values', () => {
  assert.deepEqual(readConfig(undefined), CONFIG_DEFAULTS)
  assert.deepEqual(readConfig('nonsense'), CONFIG_DEFAULTS)
  const clamped = readConfig({ scanMs: 1, pollMs: 10 ** 9, dirName: '../evil', roots: ['a', 'b'] })
  assert.equal(clamped.scanMs, 250)
  assert.equal(clamped.pollMs, 10_000)
  assert.equal(clamped.dirName, CONFIG_DEFAULTS.dirName)
  assert.deepEqual(clamped.roots, ['a', 'b'])
})
