/**
 * The one background-job projection both halves share.
 *
 * The Host half sees DSH's job-registry snapshots; the browser half sees the
 * mirror DSH pushes for display. They carry the same field names on purpose, and
 * the reconciliation rule lives here rather than twice — so the row the panel
 * draws and the reminder the model gets can never disagree about what counts as
 * "already reported".
 *
 * The same projections answer a second question, and it is the reason this
 * module grew: a task whose writer's job has **ended** while the file still says
 * `running`. See {@link settlingJob} — the ending a killed producer never got to
 * write.
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
  /**
   * Owning session id, absent on an unowned job.
   *
   * Spelled `owner` because that is the registry's own field
   * (`@deepseek-ai/dsh-jobs/view`): it is what `list(caller)` compares a caller
   * against, so a projection reading it under another name sees `undefined` on
   * every job and every live job then looks unreported.
   */
  readonly owner?: string
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

/** How a job's record says it ended. */
export type JobOutcome = 'completed' | 'killed' | 'failed'

/**
 * The job's terminal status, or null while it is live (or unknown).
 *
 * Spelled here rather than compared to string literals at each call site,
 * because two halves and three readings depend on agreeing about it: a job that
 * ended is what the settle below turns into a task's ending.
 * @param job - one job projection.
 * @returns the outcome, or null for a job that is still live.
 */
export function jobOutcome(job: JobView): JobOutcome | null {
  const status = job.status
  return status === 'completed' || status === 'killed' || status === 'failed' ? status : null
}

/**
 * The task state a job's outcome is read as.
 *
 * A job that exited on its own leaves work that finished; a killed one leaves
 * work that was stopped; a failed one leaves work that broke. Nothing here
 * consults the producer: it never got to speak.
 * @param outcome - the job's terminal status.
 * @returns the state the task is read as.
 */
export function settledState(outcome: JobOutcome): 'done' | 'failed' | 'cancelled' {
  if (outcome === 'failed') return 'failed'
  if (outcome === 'killed') return 'cancelled'
  return 'done'
}

/** The two task facts the settle reads: what it is called, and when it last spoke. */
export interface SettleCandidate {
  /** Task id, which is also the file's base name. */
  readonly task: string
  /** Epoch ms of the task's last event. */
  readonly updatedAt: number
}

/** What the registry proves about a task whose writer is gone. */
export interface JobSettlement {
  /** The job that was writing the task. */
  readonly job: JobView
  /** How it ended. */
  readonly outcome: JobOutcome
  /** The state the task is read as. */
  readonly state: 'done' | 'failed' | 'cancelled'
}

/**
 * What the job registry proves about a task that still says `running`.
 *
 * A producer that is killed forces the question this protocol used to leave
 * open: a task's ending was written by the script, so a script that never
 * reached its last line leaves a row that says `running` forever. `job_kill`
 * terminates the process tree — measured on Windows, it runs no user code at
 * all, so neither `finally` nor any handler gets to report anything. The
 * terminal line is not "missing yet"; it is never coming.
 *
 * The registry does know: a job's record outlives its process and says how it
 * ended. So a `running` task whose writer's job has ended is *settled* from that
 * record — in the reading, never in the file, which stays exactly what the
 * producer wrote.
 *
 * The rule is deliberately narrow, because a false settle would hide work the
 * user is waiting on, which is the failure this plugin exists to prevent:
 *
 * 1. the job's label must name the task (the same heuristic the unreported-job
 *    rows use, and the reason a task id worth reporting is one that appears in
 *    the command line);
 * 2. **no live job may name that task** — a second writer still running means
 *    the row is not orphaned, whatever an earlier one did;
 * 3. the job must have existed before the task's last event and ended after it,
 *    so a job from an earlier run (or a later one) cannot claim this ending;
 * 4. the job must publish a start and a finish. `finishedAt` is the registry
 *    invariant's "a terminal status has a finish", so a record without one is
 *    not evidence.
 *
 * @param task - the task as the file folded it.
 * @param jobs - this session's job projections, terminal ones included.
 * @returns the settlement, or null when nothing proves the writer is gone.
 */
export function settleTask(
  task: SettleCandidate,
  jobs: readonly JobView[] | undefined,
): JobSettlement | null {
  if (jobs === undefined) return null
  const named = jobs.filter(job => jobCanReport(job) && labelNamesTask(job.label, task.task))
  if (named.length === 0) return null
  if (named.some(jobIsLive)) return null
  let best: JobView | null = null
  let bestOutcome: JobOutcome | null = null
  for (const job of named) {
    const outcome = jobOutcome(job)
    const startedAt = job.startedAt
    const finishedAt = job.finishedAt
    if (outcome === null || typeof startedAt !== 'number' || typeof finishedAt !== 'number') continue
    if (startedAt > task.updatedAt || finishedAt < task.updatedAt) continue
    // Two runs of the same task id: the latest ending is the one that closes it.
    if (best === null || finishedAt > (best.finishedAt ?? 0)) {
      best = job
      bestOutcome = outcome
    }
  }
  if (best === null || bestOutcome === null) return null
  return { job: best, outcome: bestOutcome, state: settledState(bestOutcome) }
}

/**
 * What makes an occurrence part of a longer word rather than the word itself.
 *
 * `_` counts, because it is what most languages glue an identifier with; `-` and `.`
 * do not, because a command line separates with them (`--task sync-catalog`,
 * `node build.mjs`) and the name has to be findable there.
 */
const GLUING_CHARACTERS = 'A-Za-z0-9_'

/** The task name as something a regular expression matches literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
}

/**
 * Whether one reported task name is recognisable inside a job's command label.
 *
 * This is the reconciliation heuristic, and it is deliberately one-directional:
 * a script that names its task after something in its own command line (the
 * usual `--task sync-catalog` for `sync_catalog.py`) is recognised, and anything
 * less obvious is treated as *not* reported. A false negative costs one extra
 * reminder or one extra grey row; a false positive would hide a job the user is
 * waiting on, which is the failure this whole plugin exists to fix.
 *
 * That asymmetry is why the occurrence has to be a **whole word**. A plain
 * substring search made `com` match `compose`, `load` match `payload` and `test`
 * match `latest` — each one a job silently counted as covered, and therefore one
 * that neither reminded the model nor appeared as a reported-nothing row. The
 * boundaries are lookarounds rather than `\b` because a task id may legitimately
 * end in `.`, `-` or `_`, where `\b` would demand a word character on the far side
 * and never match at all.
 *
 * @param label - the job's label, usually the command line.
 * @param task - a task name some producer reported.
 * @returns true when the label names the task.
 */
export function labelNamesTask(label: string | undefined, task: string): boolean {
  if (typeof label !== 'string' || label.length === 0) return false
  if (task.length < MIN_MATCH_LENGTH) return false
  const boundary = new RegExp(`(?<![${GLUING_CHARACTERS}])${escapeRegExp(task)}(?![${GLUING_CHARACTERS}])`, 'i')
  return boundary.test(label)
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
