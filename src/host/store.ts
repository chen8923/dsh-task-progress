/**
 * The Host half's whole state: which directories to read, what their files last
 * said, and what the browser should be told.
 *
 * Two deliberate simplifications keep this maintainable:
 *
 * - **No file watching.** A tick re-reads any file whose size or mtime moved.
 *   `fs.watch` is platform-specific, fires duplicates, and loses events across
 *   rename-on-write; a 1 s poll of a couple of small files costs nothing and
 *   behaves identically everywhere. The browser polls the endpoint anyway.
 * - **Refold from scratch.** A changed file is re-read and re-folded rather than
 *   tracked by byte offset, so a truncated, rotated, or hand-edited file can
 *   never desynchronize the store. Progress files are tiny and bounded.
 *
 * @module dsh-task-progress/host/store
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  PROTOCOL_VERSION,
  WIRE_HISTORY,
  clampPct,
  isTerminal,
  isValidSessionSegment,
  isValidTaskId,
  parseEvent,
  type ProgressState,
  type ProgressTask,
  type TaskState,
} from '../protocol.ts'
import type { TaskProgressConfig } from './config.ts'

/** Suffix of a progress file. */
const FILE_SUFFIX = '.jsonl'

/** Most progress directories the host half will track at once. */
const MAX_DIRS = 64

/** Most progress files tracked per directory. */
const MAX_FILES_PER_DIR = 64

/** One directory being tracked: where it is and whose session it belongs to. */
interface TrackedDir {
  readonly root: string
  readonly sessionId: string
}

/** One file's last fold, keyed by the change signal that produced it. */
interface FileRecord {
  /** Size plus mtime, so a same-size rewrite is still noticed. */
  signal: string
  tasks: Map<string, ProgressTask>
}

/** Diagnostics for the plugin's own status line and tests. */
export interface StoreStats {
  /** Directories currently tracked. */
  readonly dirs: number
  /** Progress files currently folded. */
  readonly files: number
  /** Tasks currently held. */
  readonly tasks: number
}

/** The store's public surface. */
export interface TaskStore {
  /**
   * Track `<root>/<dirName>/<sessionId>` and make sure it exists, so the
   * producer that is about to be handed this path can write to it.
   * @returns the directory, or null when the arguments are unusable.
   */
  remember(root: string, sessionId: string): string | null
  /** Discover every `<root>/<dirName>/<session>` under one extra root. */
  addRoot(root: string): void
  /** Replace the extra discovery roots; directories only those roots found are forgotten. */
  setRoots(roots: readonly string[]): void
  /** Replace the live configuration after a settings change. */
  reconfigure(next: TaskProgressConfig): void
  /**
   * The current scan period, in milliseconds.
   *
   * The scan loop reads this every tick instead of capturing an interval, which
   * is what makes a settings change to `scanMs` take effect without re-arming
   * anything.
   */
  periodMs(): number
  /** Re-read changed files and drop what has aged out. */
  scan(now?: number): void
  /** The document the browser half receives. */
  snapshot(now?: number): ProgressState
  /** How much is being tracked right now. */
  stats(): StoreStats
}

/** Read at most `maxBytes` from the tail of a file, dropping a partial first line. */
function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size
  const start = size > maxBytes ? size - maxBytes : 0
  if (size === 0) return ''
  const length = size - start
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  const text = buffer.toString('utf8')
  // A tail read starts mid-line whenever the file outgrew the ceiling; that
  // fragment is not a JSON object and would be dropped anyway, but slicing it
  // off keeps the fold's line count honest.
  return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
}

/** Fold one file's lines into task records. */
function fold(
  text: string,
  base: { sessionId: string; root: string; fallbackTask: string; fallbackAt: number; historyLimit: number },
): Map<string, ProgressTask> {
  const tasks = new Map<string, ProgressTask>()
  for (const line of text.split('\n')) {
    const event = parseEvent(line)
    if (event === null) continue
    const id = event.task ?? base.fallbackTask
    if (!isValidTaskId(id)) continue
    const at = event.at ?? base.fallbackAt
    let current = tasks.get(id)
    if (current === undefined) {
      current = {
        sessionId: base.sessionId,
        root: base.root,
        task: id,
        state: 'running',
        pct: null,
        msg: '',
        done: null,
        total: null,
        unit: '',
        startedAt: at,
        updatedAt: at,
        recent: [],
      }
    } else if (isTerminal(current.state) && event.state === 'running') {
      // The same id started again after finishing: a new run, not an undo.
      current = { ...current, state: 'running', pct: null, msg: '', done: null, total: null, startedAt: at, updatedAt: at, recent: [] }
    }

    let next: ProgressTask = { ...current, updatedAt: Math.max(current.updatedAt, at) }
    let state: TaskState = next.state
    if (event.state !== undefined) state = event.state
    let pct = next.pct
    if (event.pct !== undefined) pct = event.pct
    else if (event.total !== undefined && event.done !== undefined && event.total > 0) {
      pct = clampPct((event.done / event.total) * 100)
    }
    // A clean finish with no reported percentage is a complete bar.
    if (state === 'done' && pct === null) pct = 100
    if (event.done !== undefined) next = { ...next, done: event.done }
    if (event.total !== undefined) next = { ...next, total: event.total }
    if (event.unit !== undefined) next = { ...next, unit: event.unit }
    if (event.msg !== undefined && event.msg !== next.msg) {
      next = { ...next, msg: event.msg, recent: [...next.recent, event.msg].slice(-base.historyLimit) }
    }
    tasks.set(id, { ...next, state, pct })
  }
  return tasks
}

/**
 * Create the store.
 * @param initial - the resolved configuration this store starts from.
 * @returns the store the rest of the Host half uses.
 */
export function createTaskStore(initial: TaskProgressConfig): TaskStore {
  /**
   * The live configuration. Every read below goes through this binding, so a
   * settings change takes effect on the next tick without rebuilding the store
   * — which matters because the HTTP route holds a reference to it.
   */
  let config: TaskProgressConfig = { ...initial }
  const dirs = new Map<string, TrackedDir>()
  /** Directories handed out through `remember`; discovery never claims these. */
  const remembered = new Set<string>()
  const files = new Map<string, FileRecord>()
  const extraRoots = new Set<string>()

  const remember = (root: string, sessionId: string): string | null => {
    if (root.length === 0 || !isValidSessionSegment(sessionId)) return null
    const dir = join(root, config.dirName, sessionId)
    if (!dirs.has(dir) && dirs.size >= MAX_DIRS) return dir
    dirs.set(dir, { root, sessionId })
    remembered.add(dir)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // A read-only or vanished workspace is not this plugin's problem to
      // report: the directory simply yields no files, and the next scan skips it.
    }
    return dir
  }

  const discover = (): void => {
    for (const root of extraRoots) {
      const parent = join(root, config.dirName)
      let entries: ReturnType<typeof readdirSync>
      try {
        entries = readdirSync(parent, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (dirs.size >= MAX_DIRS) return
        if (!entry.isDirectory() || !isValidSessionSegment(entry.name)) continue
        const dir = join(parent, entry.name)
        if (!dirs.has(dir)) dirs.set(dir, { root, sessionId: entry.name })
      }
    }
  }

  /** Stop tracking one directory and forget every file folded under it. */
  const forgetDir = (dir: string): void => {
    dirs.delete(dir)
    for (const path of [...files.keys()]) if (dirname(path) === dir) files.delete(path)
  }

  const scanDir = (dir: string, tracked: TrackedDir, now: number): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // Gone (or never writable): stop tracking it and forget its files.
      forgetDir(dir)
      return
    }
    let seen = 0
    for (const entry of entries) {
      if (seen >= MAX_FILES_PER_DIR) break
      if (!entry.isFile() || !entry.name.endsWith(FILE_SUFFIX)) continue
      seen += 1
      const path = join(dir, entry.name)
      let stats: ReturnType<typeof statSync>
      try {
        stats = statSync(path)
      } catch {
        files.delete(path)
        continue
      }
      const signal = `${stats.size}:${stats.mtimeMs}`
      if (files.get(path)?.signal === signal) continue
      let tasks: Map<string, ProgressTask>
      try {
        tasks = fold(readTail(path, config.maxFileBytes), {
          sessionId: tracked.sessionId,
          root: tracked.root,
          fallbackTask: entry.name.slice(0, -FILE_SUFFIX.length),
          fallbackAt: Math.round(stats.mtimeMs),
          historyLimit: config.historyLimit,
        })
      } catch {
        // An unreadable file keeps its previous fold; the next tick retries.
        continue
      }
      files.set(path, { signal, tasks })
      prune(tasks, now)
    }
  }

  const prune = (tasks: Map<string, ProgressTask>, now: number): void => {
    for (const [id, task] of tasks) {
      if (isTerminal(task.state) && now - task.updatedAt > config.retainMs) tasks.delete(id)
    }
  }

  const scan = (now = Date.now()): void => {
    discover()
    for (const [dir, tracked] of [...dirs]) {
      if (!existsSync(dir)) {
        forgetDir(dir)
        continue
      }
      scanDir(dir, tracked, now)
    }
  }

  const snapshot = (now = Date.now()): ProgressState => {
    const all: ProgressTask[] = []
    for (const record of files.values()) {
      for (const task of record.tasks.values()) {
        if (isTerminal(task.state) && now - task.updatedAt > config.retainMs) continue
        all.push(task)
      }
    }
    // Running work first, then the most recently touched — the order the panel
    // reads top to bottom.
    all.sort((left, right) => {
      const leftLive = isTerminal(left.state) ? 1 : 0
      const rightLive = isTerminal(right.state) ? 1 : 0
      if (leftLive !== rightLive) return leftLive - rightLive
      if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
      return left.task.localeCompare(right.task)
    })
    return {
      v: PROTOCOL_VERSION,
      generatedAt: now,
      pollMs: config.pollMs,
      tasks: all.slice(0, config.maxTasks).map(task => ({ ...task, recent: task.recent.slice(-WIRE_HISTORY) })),
    }
  }

  return {
    remember,
    addRoot: (root: string) => {
      if (root.length > 0) extraRoots.add(root)
    },
    setRoots: (roots: readonly string[]) => {
      extraRoots.clear()
      for (const root of roots.slice(0, 32)) if (root.length > 0) extraRoots.add(root)
      // A directory that only the removed roots had discovered is stale now;
      // one a session reported through `remember` stays, because that session
      // is still running and will keep writing there.
      for (const dir of [...dirs.keys()]) if (!remembered.has(dir)) forgetDir(dir)
    },
    reconfigure: (next: TaskProgressConfig) => {
      config = { ...next }
    },
    periodMs: () => config.scanMs,
    scan,
    snapshot,
    stats: () => {
      let tasks = 0
      for (const record of files.values()) tasks += record.tasks.size
      return { dirs: dirs.size, files: files.size, tasks }
    },
  }
}
