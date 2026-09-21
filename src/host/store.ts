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
import { basename, dirname, join } from 'node:path'
import {
  PROTOCOL_VERSION,
  WIRE_HISTORY,
  clampPct,
  isTerminal,
  isValidSessionSegment,
  isValidTaskId,
  normalizeMessage,
  parseEvent,
  type ProgressState,
  type ProgressTask,
  type TaskEnding,
  type TaskState,
} from '../protocol.ts'
import { settleTask, type JobView } from '../jobs.ts'
import type { TaskProgressConfig } from './config.ts'

/** Suffix of a progress file. */
const FILE_SUFFIX = '.jsonl'

/**
 * Most progress directories the host half watches at once.
 *
 * A long-lived instance sees a new session id for every session, fork and
 * subagent, so this cap is reached in normal use. It is a working-set bound, not
 * a refusal: the least recently used directory is evicted to make room, because
 * silently leaving a live session untracked would lose its progress with no
 * symptom anywhere.
 */
const MAX_DIRS = 64

/** Most progress files tracked per directory. */
const MAX_FILES_PER_DIR = 64

/** One directory being tracked: where it is and whose session it belongs to. */
interface TrackedDir {
  readonly root: string
  readonly sessionId: string
  /** Last time a session reported through it or a scan visited it; the eviction key. */
  lastUsedAt: number
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

/**
 * Where the store asks what happened to the jobs writing these tasks.
 *
 * Supplied by the composition rather than imported: the job registry is an
 * optional service, and a deployment without one must keep serving exactly what
 * the files say. It is a function of the *session* because that is the key the
 * store already holds — every progress directory is named after one.
 */
export interface SessionJobSource {
  /**
   * This session's job projections, terminal ones included.
   * @param sessionId - the session whose jobs to list.
   * @returns the jobs, or undefined when this deployment cannot answer.
   */
  jobsFor(sessionId: string): readonly JobView[] | undefined
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
   * Point the store at the job registry, or at nothing.
   *
   * Nothing is a legitimate state, not a failure: a composition without the job
   * service keeps the pre-settle behaviour, where a task's ending is whatever
   * the producer managed to write before it died.
   * @param source - the reader, or null to stop asking.
   */
  setJobSource(source: SessionJobSource | null): void
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
  /** The document one session receives. */
  snapshot(now?: number, sessionId?: string): ProgressState
  /** How much is being tracked right now. */
  stats(): StoreStats
}

/**
 * Read at most `maxBytes` from the tail of a file, dropping a partial first line.
 *
 * The buffer is zero-filled and the read count is honoured, rather than reading
 * into `allocUnsafe` and decoding the whole buffer: a file truncated between the
 * `stat` and the read (a producer rewriting its own file, an editor saving it)
 * would otherwise fold whatever was in those heap bytes — and a stray run of them
 * that happened to parse would go on the wire as a task message.
 */
function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size
  const start = size > maxBytes ? size - maxBytes : 0
  if (size === 0) return ''
  const length = size - start
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    read = readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  const text = buffer.subarray(0, read).toString('utf8')
  // A tail read starts mid-line whenever the file outgrew the ceiling; that
  // fragment is not a JSON object and would be dropped anyway, but slicing it
  // off keeps the fold's line count honest.
  return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
}

/** Fold one file's lines into task records. */
function fold(
  text: string,
  base: { sessionId: string; fallbackTask: string; fallbackAt: number; historyLimit: number },
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
  /** The job registry reader, once a composition supplies one; null asks nobody. */
  let jobs: SessionJobSource | null = null
  const dirs = new Map<string, TrackedDir>()
  /** Directories handed out through `remember`; discovery never claims these. */
  const remembered = new Set<string>()
  const files = new Map<string, FileRecord>()
  /**
   * Roots the plugin always looks under, added by the composition itself (its
   * working directory). Kept apart from the configured roots so a settings write
   * that replaces those cannot also drop these.
   */
  const baseRoots = new Set<string>()
  /** Roots the settings namespace configures; `setRoots` replaces exactly these. */
  const configRoots = new Set<string>()

  const remember = (root: string, sessionId: string): string | null => {
    if (root.length === 0 || !isValidSessionSegment(sessionId)) return null
    const dir = join(root, config.dirName, sessionId)
    if (!dirs.has(dir) && dirs.size >= MAX_DIRS) evictLeastRecent()
    dirs.set(dir, { root, sessionId, lastUsedAt: Date.now() })
    remembered.add(dir)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // A read-only or vanished workspace is not this plugin's problem to
      // report: the directory simply yields no files, and the next scan skips it.
    }
    return dir
  }

  /** Drop the directory nothing has touched for longest, to make room for a new one. */
  const evictLeastRecent = (): void => {
    let oldest: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [dir, tracked] of dirs) {
      if (tracked.lastUsedAt < oldestAt) {
        oldest = dir
        oldestAt = tracked.lastUsedAt
      }
    }
    if (oldest === undefined) return
    forgetDir(oldest)
    remembered.delete(oldest)
  }

  const discover = (): void => {
    for (const root of new Set([...baseRoots, ...configRoots])) {
      const parent = join(root, config.dirName)
      let entries: ReturnType<typeof readdirSync>
      try {
        entries = readdirSync(parent, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !isValidSessionSegment(entry.name)) continue
        const dir = join(parent, entry.name)
        const existing = dirs.get(dir)
        if (existing !== undefined) {
          existing.lastUsedAt = Date.now()
          continue
        }
        if (dirs.size >= MAX_DIRS) evictLeastRecent()
        dirs.set(dir, { root, sessionId: entry.name, lastUsedAt: Date.now() })
      }
    }
  }

  /** Stop tracking one directory and forget every file folded under it. */
  const forgetDir = (dir: string): void => {
    dirs.delete(dir)
    for (const path of [...files.keys()]) if (dirname(path) === dir) files.delete(path)
  }

  const scanDir = (dir: string, tracked: TrackedDir, now: number): void => {
    tracked.lastUsedAt = now
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // Gone (or never writable): stop tracking it and forget its files.
      forgetDir(dir)
      return
    }
    let seen = 0
    /** Every file this directory holds right now, cap aside: the pruning key below. */
    const held = new Set<string>()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(FILE_SUFFIX)) continue
      held.add(entry.name)
      if (seen >= MAX_FILES_PER_DIR) continue
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
    // A file this directory no longer holds is gone — cleared by its producer,
    // rotated away, or renamed. Its folded record has to go with it: keeping it
    // would serve a task whose file nobody can read, and the protocol promises
    // that deleting the file deletes the task. `held` is built from the whole
    // listing rather than from the files actually read, so the read cap can
    // never look like a deletion.
    for (const path of [...files.keys()]) {
      if (dirname(path) === dir && !held.has(basename(path))) files.delete(path)
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
    enforceBudget()
  }

  /**
   * A task as it should be read, once the job registry has been consulted.
   *
   * The fold never invents an ending: what the file says is what the file says.
   * This is the *reading*, and it exists because a producer can be killed
   * between two lines — on Windows by `taskkill`, which runs no user code, so
   * the terminal event is not late, it is never coming. The registry holds the
   * one fact that settles it: how the writing job ended.
   *
   * Three things move, and each is deliberate:
   *
   * - the **state**, from the job's outcome (`killed` reads as `cancelled`,
   *   `failed` as `failed`, a clean exit as `done`);
   * - **`updatedAt`**, to the job's finish, because that is when the reader
   *   learned the ending: the retention window then starts there instead of at
   *   a last report that may be hours old, and the row's duration becomes the
   *   run's real duration;
   * - **`ended`**, the marker that says this state was inferred, so nobody
   *   mistakes it for the producer's own last word.
   *
   * A percentage is never invented for a killed or failed run — the bar stops
   * where the producer left it. A `done` with no reported percentage fills the
   * bar, exactly as the fold does for a producer that says `done` itself.
   * @param task - one folded task.
   * @param source - the job registry reader, or null to read the file alone.
   * @returns the row to publish; the task itself when nothing proves it ended.
   */
  const settle = (task: ProgressTask, source: SessionJobSource | null): ProgressTask => {
    if (task.state !== 'running' || source === null) return task
    let found: readonly JobView[] | undefined
    try {
      found = source.jobsFor(task.sessionId)
    } catch {
      // A registry that cannot answer is no reason to change what the file
      // says: the row keeps its reported state and the next read asks again.
      return task
    }
    const settlement = settleTask(task, found)
    if (settlement === null) return task
    const { job, outcome, state } = settlement
    // The registry's own detail line is bounded here rather than only where it is
    // rendered: everything this store publishes is a document, and a document
    // should not be able to grow a field because another service grew one.
    const detail = job.detail === undefined ? '' : normalizeMessage(job.detail)
    const ended: TaskEnding = detail.length === 0
      ? { job: job.id, status: outcome }
      : { job: job.id, status: outcome, detail }
    return {
      ...task,
      state,
      pct: state === 'done' && task.pct === null ? 100 : task.pct,
      updatedAt: Math.max(task.updatedAt, job.finishedAt ?? task.updatedAt),
      ended,
    }
  }

  /** Running work first, then the most recently touched, then by id — a total order. */
  const better = (left: ProgressTask, right: ProgressTask): number => {
    const leftLive = isTerminal(left.state) ? 1 : 0
    const rightLive = isTerminal(right.state) ? 1 : 0
    if (leftLive !== rightLive) return leftLive - rightLive
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
    return left.task.localeCompare(right.task)
  }

  /**
   * Keep the in-memory task set inside the bound the wire document already uses.
   *
   * `maxTasks` is the deployment's statement about how many tasks are worth
   * showing, and holding more than that serves nobody; the fold alone cannot
   * bound it, because a file may legally carry a new task id on every line.
   * Eviction drops the least interesting rows first (settled, then oldest), and a
   * running task evicted here returns on its next append — that append changes
   * the file, and a changed file is re-folded from scratch.
   */
  const enforceBudget = (): void => {
    const budget = Math.max(1, config.maxTasks)
    let total = 0
    for (const record of files.values()) total += record.tasks.size
    if (total <= budget) return
    const rows: { tasks: Map<string, ProgressTask>, task: ProgressTask }[] = []
    for (const record of files.values()) {
      for (const task of record.tasks.values()) rows.push({ tasks: record.tasks, task })
    }
    rows.sort((left, right) => better(left.task, right.task))
    for (const row of rows.slice(budget)) row.tasks.delete(row.task.task)
  }

  /**
   * The document one session receives.
   *
   * The session is required, not optional: answering "everything this process
   * knows" would hand any authenticated caller every other session's task names
   * and messages — the fence is the instance's login, not a session. A caller
   * that names no session gets an empty document, which is exactly what a
   * session with nothing to report gets.
   *
   * Every row is settled before it is published (see {@link settle}): a task
   * whose writer's job has ended is answered as ended, because the alternative
   * is a row that says `running` for the rest of the process's life.
   * @param now - current clock, epoch milliseconds.
   * @param sessionId - the session to answer for; absent answers for none.
   * @returns the session's tasks, ranked the way the panel reads them.
   */
  const snapshot = (now = Date.now(), sessionId?: string): ProgressState => {
    const all: ProgressTask[] = []
    if (sessionId !== undefined && sessionId.length > 0) {
      for (const record of files.values()) {
        for (const task of record.tasks.values()) {
          if (task.sessionId !== sessionId) continue
          const row = settle(task, jobs)
          if (isTerminal(row.state) && now - row.updatedAt > config.retainMs) continue
          all.push(row)
        }
      }
    }
    all.sort(better)
    return {
      v: PROTOCOL_VERSION,
      generatedAt: now,
      pollMs: config.pollMs,
      overlayUnreported: config.overlayUnreported,
      tasks: all.slice(0, config.maxTasks).map(task => ({ ...task, recent: task.recent.slice(-WIRE_HISTORY) })),
    }
  }

  return {
    remember,
    addRoot: (root: string) => {
      if (root.length > 0) baseRoots.add(root)
    },
    setRoots: (roots: readonly string[]) => {
      configRoots.clear()
      for (const root of roots.slice(0, 32)) if (root.length > 0) configRoots.add(root)
      // A discovered directory whose root is gone is stale now; one a session
      // reported through `remember` stays, because that session is still running
      // and will keep writing there — and so does anything under a base root.
      const live = new Set([...baseRoots, ...configRoots])
      for (const [dir, tracked] of [...dirs]) {
        if (!remembered.has(dir) && !live.has(tracked.root)) forgetDir(dir)
      }
    },
    reconfigure: (next: TaskProgressConfig) => {
      config = { ...next }
    },
    setJobSource: (source: SessionJobSource | null) => {
      jobs = source
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
