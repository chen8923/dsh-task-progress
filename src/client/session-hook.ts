/**
 * The two session facts both surfaces read out of the standard slot props.
 *
 * They live together because they share one subtlety: a slot's standard props
 * are fixed for the life of the mounted entry, so a hook that is present is
 * present on every render — which is what makes the guarded call below a
 * stable branch rather than a conditional hook.
 *
 * @module dsh-task-progress/client/session-hook
 */

/** One job row as the session list mirror carries it. */
export interface SessionJobView {
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
}

/** The shared empty slice: one stable reference, so a selector never re-fires. */
const NO_JOBS: readonly SessionJobView[] = []

/** The slice of the session list state these hooks select from. */
export interface SessionsState {
  /** The session currently in view. */
  readonly current?: unknown
  /** Background jobs by session, the browser-side projection DSH pushes. */
  readonly jobsBySession?: Readonly<Record<string, readonly SessionJobView[]>>
}

/** The selector hook a slot's standard props provide. */
export type SessionsHook = <T>(selector: (state: SessionsState) => T) => T

/**
 * Read the session in view.
 * @param hook - the slot's selector hook, when it provides one.
 * @returns the session id, or undefined when the surface has no session in view.
 */
export function useCurrentSession(hook: SessionsHook | undefined): string | undefined {
  const current = hook !== undefined ? hook(state => state.current) : undefined
  return typeof current === 'string' && current.length > 0 ? current : undefined
}

/**
 * Count the live jobs in one session's mirror slice.
 * @param jobs - the session's job rows, or undefined when it has none.
 * @returns how many are running or stopping.
 */
export function countRunningJobs(jobs: readonly SessionJobView[] | undefined): number {
  if (jobs === undefined) return 0
  return jobs.reduce((total, job) => total + (job.status === 'running' || job.status === 'stopping' ? 1 : 0), 0)
}

/**
 * Count the session's running background jobs.
 *
 * This is the browser-side job **mirror** — a snapshot DSH pushes for display —
 * not the job registry's output cursor. Reading it is free and steals nothing:
 * the plugin still never reads a job's output, which belongs to the model's
 * `job_output` tool alone. The count exists to explain an empty panel: a job
 * that runs without reporting progress is invisible here by design, and saying
 * so is better than looking broken.
 *
 * @param hook - the slot's selector hook, when it provides one.
 * @param sessionId - the session to count; undefined counts nothing.
 * @returns how many of that session's jobs are live.
 */
export function useRunningJobCount(hook: SessionsHook | undefined, sessionId: string | undefined): number {
  return hook !== undefined
    ? hook(state => countRunningJobs(sessionId === undefined ? undefined : state.jobsBySession?.[sessionId]))
    : 0
}

/**
 * The session's background jobs, straight out of the browser-side mirror.
 *
 * The mirror is what DSH itself draws the session's job list from: it carries
 * the command line, the lifecycle state, and the start time, and it is pushed to
 * the browser whether or not any script reports progress. Reading it is what
 * lets this plugin show a background job **without depending on the model
 * remembering a convention** — the reported tasks only add the detail on top.
 *
 * It is not the registry's output cursor, so nothing here can steal a byte the
 * model would have read.
 *
 * @param hook - the slot's selector hook, when it provides one.
 * @param sessionId - the session in view; undefined selects nothing.
 * @returns that session's rows, in the mirror's order.
 */
export function useSessionJobs(
  hook: SessionsHook | undefined,
  sessionId: string | undefined,
): readonly SessionJobView[] {
  if (hook === undefined) return NO_JOBS
  return hook(state => (sessionId === undefined ? NO_JOBS : state.jobsBySession?.[sessionId] ?? NO_JOBS))
}
