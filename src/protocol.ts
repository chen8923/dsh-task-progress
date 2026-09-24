/**
 * The one contract both halves of `dsh-task-progress` share.
 *
 * Producers (any script, any language) append JSON lines to a file; the Host
 * half folds those lines into task records and serves them; the browser half
 * renders them. Everything in this module is pure — no `node:` imports, no DOM —
 * so it is bundled into both halves and unit-tested directly.
 *
 * @module dsh-task-progress/protocol
 */

/** Wire and file protocol version. Bumped when a field changes meaning. */
export const PROTOCOL_VERSION = 1

/** The read-only state endpoint the Host half serves and the browser half polls. */
export const STATE_ROUTE = '/plugins/task-progress/state'

/**
 * The settings namespace this plugin registered **before DSH 0.1.7**.
 *
 * Kept as the name of a fact rather than as a seam: since 0.1.7 a plugin's settings
 * are addressed by the id of its own profile entry (`dsh-task-progress`), because the
 * form is derived from the `Config` schema that entry exports — there is no
 * registration call left for a namespace like this one to be keyed on. It survives
 * because a settings document written by an older version is keyed by this string, so
 * a reader looking for where those values went needs the old spelling to find them.
 */
export const SETTINGS_NAMESPACE = 'task-progress'

/**
 * The state URL for one session.
 *
 * The session is a required part of the request rather than a filter applied
 * after the fact: the endpoint answers for exactly the session asked about, so a
 * caller cannot read a sibling session's task names by asking for everything.
 * Omitting it is a valid request that returns no tasks at all.
 * @param sessionId - the session whose tasks to read.
 * @returns the relative URL to fetch.
 */
export function stateUrl(sessionId: string): string {
  return `${STATE_ROUTE}?session=${encodeURIComponent(sessionId)}`
}

/** Where a task is in its life. A terminal state ends one run. */
export type TaskState = 'running' | 'done' | 'failed' | 'cancelled'

/** Every state a producer may report, in the order the UI ranks them. */
export const TASK_STATES: readonly TaskState[] = ['running', 'failed', 'cancelled', 'done']

/** Default directory (relative to a workspace root) that holds progress files. */
export const DEFAULT_DIR_NAME = '.dsh-progress'

/** Task id: what a file is named after, and what the row is keyed by. */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/** Session id segment: the directory level between the root and the files. */
const SESSION_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** Longest progress message kept, in characters. */
export const MAX_MESSAGE_CHARS = 200

/** Longest message history kept per task on the wire. */
export const WIRE_HISTORY = 5

/**
 * One parsed progress line. Only `state` is mandatory in practice: a producer
 * may report a percentage, a message, or both, and the fold keeps the previous
 * value for whatever the line omits.
 */
export interface ProgressEvent {
  /** Protocol version the producer wrote. Absent is accepted as current. */
  readonly v?: number
  /** Task id; defaults to the file's own name. */
  readonly task?: string
  /** Lifecycle state of this line. */
  readonly state?: TaskState
  /** Completion percentage, 0–100. Clamped. */
  readonly pct?: number
  /** Human-readable status line, e.g. `linking objects`. */
  readonly msg?: string
  /** Producer clock, epoch milliseconds. Absent falls back to the file's mtime. */
  readonly at?: number
  /** Completed units, paired with `total` for a derived percentage. */
  readonly done?: number
  /** Total units. */
  readonly total?: number
  /** Unit name, e.g. `frames`. */
  readonly unit?: string
}

/** How a task's writer was found to have ended, when it never said so itself. */
export interface TaskEnding {
  /** Registry id of the job that was writing the task. */
  readonly job: string
  /** How that job ended. */
  readonly status: 'completed' | 'killed' | 'failed'
  /** The job's own detail line, when it published one (`exit code: 3`). */
  readonly detail?: string
}

/** One task as the browser receives it. */
export interface ProgressTask {
  /** Session that reported it, taken from the directory name. */
  readonly sessionId: string
  /** Task id. */
  readonly task: string
  /**
   * Current state.
   *
   * Normally the producer's own last word. When {@link ProgressTask.ended} is
   * present it instead comes from the job registry — the producer was killed
   * before it could say anything, and the reading says what the record proves.
   */
  readonly state: TaskState
  /** Percentage, or null when the producer never reported one. */
  readonly pct: number | null
  /** Latest message, empty when none. */
  readonly msg: string
  /** Completed units, or null. */
  readonly done: number | null
  /** Total units, or null. */
  readonly total: number | null
  /** Unit name, empty when unknown. */
  readonly unit: string
  /** First event's clock (or first sighting), epoch milliseconds. */
  readonly startedAt: number
  /** Last event's clock (or last sighting), epoch milliseconds. */
  readonly updatedAt: number
  /** Most recent distinct messages, oldest first. */
  readonly recent: readonly string[]
  /**
   * Present exactly when the state above was **inferred** rather than reported:
   * the job writing this task ended, and the producer never wrote an ending.
   *
   * The distinction is the point of the field. A reader that only sees a
   * terminal `state` cannot tell a script that finished from one that was
   * killed mid-sentence, and the panel says so out loud rather than passing the
   * inference off as the producer's own report.
   */
  readonly ended?: TaskEnding
}

/** The whole state document. */
export interface ProgressState {
  /** Protocol version. */
  readonly v: number
  /** When the Host half produced this document, epoch milliseconds. */
  readonly generatedAt: number
  /** Interval the browser half should poll at, milliseconds. */
  readonly pollMs: number
  /**
   * Whether the floating panel may appear for a background job whose script
   * reports nothing.
   *
   * It rides this document rather than the settings transport because every
   * surface already polls here, and a panel that had to fetch its own
   * configuration before deciding whether to render would be a second data path
   * to keep correct. Absent means false: never interrupt anybody by accident.
   */
  readonly overlayUnreported: boolean
  /** Every task the Host half currently sees. */
  readonly tasks: readonly ProgressTask[]
}

/** True when `value` is usable as a task id (and therefore as a file name). */
export function isValidTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_RE.test(value)
}

/** True when `value` is usable as the session directory segment. */
export function isValidSessionSegment(value: unknown): value is string {
  return typeof value === 'string' && SESSION_SEGMENT_RE.test(value)
}

/** Normalize an unknown value to a known state, or null when it is not one. */
export function normalizeState(value: unknown): TaskState | null {
  return value === 'running' || value === 'done' || value === 'failed' || value === 'cancelled'
    ? value
    : null
}

/** True for the states that end a run. */
export function isTerminal(state: TaskState): boolean {
  return state !== 'running'
}

/** Clamp an unknown percentage into 0–100, or null when it is not a number. */
export function clampPct(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

/** Trim an unknown value to a bounded single-line message, or ''. */
export function normalizeMessage(value: unknown): string {
  if (typeof value !== 'string') return ''
  const single = value.replace(/[\r\n\t]+/g, ' ').trim()
  return single.length > MAX_MESSAGE_CHARS ? `${single.slice(0, MAX_MESSAGE_CHARS - 1)}…` : single
}

/** A finite non-negative number, or null. */
function nonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

/**
 * Parse one produced line. Tolerant by design: a producer that writes a banner,
 * a blank line, or a half-flushed tail must never break the fold, and a line
 * that carries nothing usable is dropped rather than reported.
 * @param line - one raw line from a progress file.
 * @returns the event, or null when the line carries no usable event.
 */
export function parseEvent(line: string): ProgressEvent | null {
  const text = line.trim()
  if (text.length === 0 || text[0] !== '{') return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // A torn tail is expected: the producer may be mid-append.
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const state = normalizeState(record['state'])
  const pct = clampPct(record['pct'])
  const msg = normalizeMessage(record['msg'])
  const done = nonNegative(record['done'])
  const total = nonNegative(record['total'])
  const at = nonNegative(record['at'])
  const task = isValidTaskId(record['task']) ? record['task'] : undefined
  const unit = typeof record['unit'] === 'string' ? record['unit'].slice(0, 24) : undefined
  // A line that changes nothing is not worth carrying through the fold, but a
  // lone `at` bump is not a change either — require one of the real fields.
  if (state === null && pct === null && msg.length === 0 && done === null && total === null) return null
  return {
    v: typeof record['v'] === 'number' ? record['v'] : undefined,
    task,
    state: state ?? undefined,
    pct: pct ?? undefined,
    msg: msg.length > 0 ? msg : undefined,
    at: at ?? undefined,
    done: done ?? undefined,
    total: total ?? undefined,
    unit: unit !== undefined && unit.length > 0 ? unit : undefined,
  }
}

/**
 * Parse a state document received over the wire. The browser half treats any
 * unusable result as "no data yet" rather than as an error: the endpoint is
 * same-origin and authenticated, so a bad body means a version mismatch or a
 * proxy, and the next poll is the remedy.
 * @param text - raw response body.
 * @returns the state, or null when it cannot be trusted.
 */
export function parseState(text: string): ProgressState | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const tasks = record['tasks']
  if (!Array.isArray(tasks)) return null
  const pollMs = nonNegative(record['pollMs'])
  return {
    v: typeof record['v'] === 'number' ? record['v'] : PROTOCOL_VERSION,
    generatedAt: nonNegative(record['generatedAt']) ?? Date.now(),
    pollMs: pollMs === null ? 2000 : Math.min(10_000, Math.max(500, pollMs)),
    // Strictly `true`: a deployment that never configured this must not have its
    // panel start summoning itself because a proxy echoed a truthy string.
    overlayUnreported: record['overlayUnreported'] === true,
    tasks: tasks.map(parseTask).filter((task): task is ProgressTask => task !== null),
  }
}

/** Parse one task row, dropping anything structurally wrong. */
function parseTask(raw: unknown): ProgressTask | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const state = normalizeState(record['state'])
  const task = record['task']
  if (state === null || typeof task !== 'string' || task.length === 0) return null
  // Depth in one place: the Host half already rejects an unusable id and bounds
  // the unit, and a browser that re-checks costs nothing — the row is rendered
  // from producer text, so the reader is the last gate that should trust it.
  if (!isValidTaskId(task)) return null
  const recent = Array.isArray(record['recent'])
    ? record['recent'].filter((line): line is string => typeof line === 'string').slice(-WIRE_HISTORY)
    : []
  const ended = parseEnding(record['ended'])
  return {
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : '',
    task,
    state,
    pct: clampPct(record['pct']),
    msg: normalizeMessage(record['msg']),
    done: nonNegative(record['done']),
    total: nonNegative(record['total']),
    unit: typeof record['unit'] === 'string' ? record['unit'].slice(0, 24) : '',
    startedAt: nonNegative(record['startedAt']) ?? 0,
    updatedAt: nonNegative(record['updatedAt']) ?? 0,
    recent,
    ...ended === null ? {} : { ended },
  }
}

/**
 * Parse the inferred-ending marker, dropping anything that does not name a job
 * and a known outcome: a marker without evidence would make the panel claim an
 * inference it cannot justify.
 * @param raw - the `ended` field as received.
 * @returns the ending, or null when it is absent or unusable.
 */
function parseEnding(raw: unknown): TaskEnding | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const job = record['job']
  const status = record['status']
  if (typeof job !== 'string' || job.length === 0) return null
  if (status !== 'completed' && status !== 'killed' && status !== 'failed') return null
  const detail = typeof record['detail'] === 'string' ? normalizeMessage(record['detail']) : ''
  return detail.length > 0 ? { job, status, detail } : { job, status }
}
