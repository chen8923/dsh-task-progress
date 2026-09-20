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
 * The settings namespace this plugin registers on the Host and keys its browser
 * card on. Spelled once, here, because both halves must agree on it and the two
 * halves must not import each other (the browser bundle may not pull Node code).
 */
export const SETTINGS_NAMESPACE = 'task-progress'

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

/** One task as the browser receives it. */
export interface ProgressTask {
  /** Session that reported it, taken from the directory name. */
  readonly sessionId: string
  /** Workspace root that owns the progress directory. */
  readonly root: string
  /** Task id. */
  readonly task: string
  /** Current state. */
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
}

/** The whole state document. */
export interface ProgressState {
  /** Protocol version. */
  readonly v: number
  /** When the Host half produced this document, epoch milliseconds. */
  readonly generatedAt: number
  /** Interval the browser half should poll at, milliseconds. */
  readonly pollMs: number
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
  const recent = Array.isArray(record['recent'])
    ? record['recent'].filter((line): line is string => typeof line === 'string').slice(-WIRE_HISTORY)
    : []
  return {
    sessionId: typeof record['sessionId'] === 'string' ? record['sessionId'] : '',
    root: typeof record['root'] === 'string' ? record['root'] : '',
    task,
    state,
    pct: clampPct(record['pct']),
    msg: normalizeMessage(record['msg']),
    done: nonNegative(record['done']),
    total: nonNegative(record['total']),
    unit: typeof record['unit'] === 'string' ? record['unit'] : '',
    startedAt: nonNegative(record['startedAt']) ?? 0,
    updatedAt: nonNegative(record['updatedAt']) ?? 0,
    recent,
  }
}
