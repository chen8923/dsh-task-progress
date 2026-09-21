/**
 * The one background-job projection both halves share.
 *
 * The Host half sees DSH's job-registry snapshots; the browser half sees the
 * mirror DSH pushes for display. They carry the same field names on purpose, and
 * the reconciliation rule lives here rather than twice — so the row the panel
 * draws and the reminder the model gets can never disagree about what counts as
 * "already reported".
 *
 * Neither shape carries a job's *output*: `ctx.jobs.read()` is a
 * single-consumer cursor that belongs to the model's `job_output` tool, and this
 * plugin has no business consuming it. Only lifecycle facts cross this module.
 *
 * @module dsh-task-progress/jobs
 */

/** One background job, as either the registry or the browser mirror spells it. */
export interface JobView {
  /** Registry id (`bash-7`, `subagent-2`). */
  readonly id: string
  /** Producer kind; a delegated agent is `subagent`. */
  readonly kind?: string
  /** Producer-supplied one-line label — for a shell job, the command itself. */
  readonly label?: string
  /** Lifecycle state; `running` and `stopping` are the live ones. */
  readonly status?: string
  /** Kind-specific detail once a producer supplied one (`exit code: 3`). */
  readonly detail?: string
  /** Epoch ms the job was registered. */
  readonly startedAt?: number
  /** Epoch ms the job settled; absent while it is live. */
  readonly finishedAt?: number
  /** Owning session id, present on registry snapshots and absent from the mirror. */
  readonly ownerSession?: string
}

/** The two live statuses, spelled the same by the registry and the mirror. */
const LIVE_STATUSES = new Set(['running', 'stopping'])

/** A delegated agent is a job, but it has no script of its own to report from. */
const NON_REPORTING_KIND = 'subagent'

/**
 * Shortest task name allowed to match inside a command label.
 *
 * A one- or two-character name (`a`, `up`) appears in almost every command line,
 * so matching on it would silently hide jobs that never reported anything.
 */
const MIN_MATCH_LENGTH = 3

/**
 * Whether a job is still live.
 * @param job - one job projection.
 * @returns true for `running` and `stopping`.
 */
export function jobIsLive(job: JobView): boolean {
  return typeof job.status === 'string' && LIVE_STATUSES.has(job.status)
}

/**
 * Whether this job's producer could report progress at all.
 * @param job - one job projection.
 * @returns false for a delegated agent, which reports through its own transcript.
 */
export function jobCanReport(job: JobView): boolean {
  return job.kind !== NON_REPORTING_KIND
}

/**
 * Whether one reported task name is recognisable inside a job's command label.
 *
 * This is the reconciliation heuristic, and it is deliberately one-directional:
 * a script that names its task after something in its own command line (the
 * usual `--task kline-backfill` for `backfill.py`) is recognised, and anything
 * less obvious is treated as *not* reported. A false negative costs one extra
 * reminder or one extra grey row; a false positive would hide a job the user is
 * waiting on, which is the failure this whole plugin exists to fix.
 *
 * @param label - the job's label, usually the command line.
 * @param task - a task name some producer reported.
 * @returns true when the label mentions the task.
 */
export function labelNamesTask(label: string | undefined, task: string): boolean {
  if (typeof label !== 'string' || label.length === 0) return false
  if (task.length < MIN_MATCH_LENGTH) return false
  return label.toLowerCase().includes(task.toLowerCase())
}

/**
 * The live jobs that no reported task accounts for.
 * @param jobs - job projections from either half; undefined means "none known".
 * @param taskNames - the names of the tasks this session currently reports.
 * @returns the jobs worth showing, in the order given.
 */
export function unreportedJobs(
  jobs: readonly JobView[] | undefined,
  taskNames: readonly string[],
): JobView[] {
  if (jobs === undefined) return []
  return jobs.filter(job =>
    jobIsLive(job)
    && jobCanReport(job)
    && !taskNames.some(name => labelNamesTask(job.label, name)))
}

/**
 * How long a job has been running, or ran.
 * @param job - one job projection.
 * @param now - current epoch ms.
 * @returns milliseconds, or null when the producer published no start time.
 */
export function jobElapsedMs(job: JobView, now: number): number | null {
  if (typeof job.startedAt !== 'number') return null
  const end = typeof job.finishedAt === 'number' ? job.finishedAt : now
  return Math.max(0, end - job.startedAt)
}
