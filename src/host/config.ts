/**
 * Host-side configuration, read defensively.
 *
 * This plugin deliberately exports no `Config` schema: a schema would make the
 * package depend on DSH's validation library, and the whole point of the layout
 * is that the plugin installs and builds with zero dependencies of its own.
 * Every key below has a default, so an unconfigured plugin row is fully
 * functional, and a wrong value is clamped rather than fatal.
 *
 * @module dsh-task-progress/host/config
 */

/** Where progress files live inside a workspace root. */
export const DEFAULT_DIR_NAME = '.dsh-progress'

/** How a `dsh-task-progress` row may be configured. */
export interface TaskProgressConfig {
  /** Directory name under each root that holds `<session>/<task>.jsonl`. */
  readonly dirName: string
  /** How often the Host half re-reads changed files, milliseconds. */
  readonly scanMs: number
  /** Poll interval advertised to the browser half, milliseconds. */
  readonly pollMs: number
  /** How long a finished task stays visible after its last update, milliseconds. */
  readonly retainMs: number
  /** Distinct messages kept per task, as the expanded panel's recent lines. */
  readonly historyLimit: number
  /** Hard cap on tasks in one state document. */
  readonly maxTasks: number
  /** Bytes read from the tail of one progress file. */
  readonly maxFileBytes: number
  /** Extra absolute roots to discover progress directories under. */
  readonly roots: readonly string[]
  /**
   * How long a background job may run with nothing reported before the model is
   * told once about it, milliseconds. `0` disables the reminder entirely.
   */
  readonly remindAfterMs: number
}

/** The configuration every deployment gets when it configures nothing. */
export const CONFIG_DEFAULTS: TaskProgressConfig = {
  dirName: DEFAULT_DIR_NAME,
  scanMs: 1000,
  pollMs: 2000,
  retainMs: 30 * 60_000,
  historyLimit: 30,
  maxTasks: 200,
  maxFileBytes: 256 * 1024,
  roots: [],
  remindAfterMs: 30_000,
}

/** Directory names that are a single safe path segment. */
const DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/** Clamp a number into a range, falling back to the default when unusable. */
function bounded(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Read the plugin row's configuration.
 * @param raw - the config object DSH passed to `apply`, of unknown shape.
 * @returns a complete configuration; unusable keys fall back to their defaults.
 */
export function readConfig(raw: unknown): TaskProgressConfig {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const dirName = typeof record['dirName'] === 'string' && DIR_NAME_RE.test(record['dirName'])
    ? record['dirName']
    : CONFIG_DEFAULTS.dirName
  const roots = Array.isArray(record['roots'])
    ? record['roots'].filter((root): root is string => typeof root === 'string' && root.length > 0)
    : CONFIG_DEFAULTS.roots
  return {
    dirName,
    scanMs: bounded(record['scanMs'], CONFIG_DEFAULTS.scanMs, 250, 60_000),
    pollMs: bounded(record['pollMs'], CONFIG_DEFAULTS.pollMs, 500, 10_000),
    retainMs: bounded(record['retainMs'], CONFIG_DEFAULTS.retainMs, 0, 24 * 3_600_000),
    historyLimit: bounded(record['historyLimit'], CONFIG_DEFAULTS.historyLimit, 1, 200),
    maxTasks: bounded(record['maxTasks'], CONFIG_DEFAULTS.maxTasks, 1, 2000),
    maxFileBytes: bounded(record['maxFileBytes'], CONFIG_DEFAULTS.maxFileBytes, 4096, 8 * 1024 * 1024),
    roots: roots.slice(0, 32),
    // Zero is a real value here: it is how a deployment turns the reminder off.
    remindAfterMs: bounded(record['remindAfterMs'], CONFIG_DEFAULTS.remindAfterMs, 0, 3_600_000),
  }
}
