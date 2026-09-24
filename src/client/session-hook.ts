/**
 * The DSH client facts both surfaces read: which session is in view, and which
 * background jobs it has.
 *
 * They live together because they share a history. Until DSH 0.1.7 both came out
 * of one selector over the session list — `current` for the session, and
 * `jobsBySession` for its jobs. That list now carries neither: the session in
 * view is the row the **main view retains**, and the job roster moved to the
 * `ctx.jobs` service, which streams a session's rows only while a surface
 * watches them.
 *
 * Both spellings are DSH's own, read out of
 * `packages/api/session-controller/src/client/sessions/service.ts` and
 * `packages/api/job-controller/src/client/model.ts`, and both are pinned by
 * `test/client-contract.test.ts` — because a rename here produces no error at
 * all, just a surface that stops drawing.
 *
 * Nothing here imports React: the pure selectors are what the suite drives, and
 * the bindings live in `job-roster.ts`.
 *
 * @module dsh-task-progress/client/session-hook
 */

/** One job row as the client roster carries it. */
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

/** One session-list row, as far as "which session is in view" needs it. */
export interface SessionRowLike {
  /**
   * Local reference counts by consumer source.
   *
   * `mainView` is the conversation column's own hold on a session, and it is the
   * only thing that means "the user is looking at this one": the list is ordered,
   * but order is not a view.
   */
  readonly retainedBy?: Readonly<Record<string, number>>
}

/** The slice of the session list state these selectors read. */
export interface SessionsState {
  /** Catalog rows by session id; absent only outside the shell. */
  readonly byId?: Readonly<Record<string, SessionRowLike>>
}

/** The selector hook a slot's standard props provide. */
export type SessionsHook = <T>(selector: (state: SessionsState) => T) => T

/**
 * Which session the frame is showing.
 *
 * The judgement is DSH's own, taken from every shipped reader of the same state
 * (`ui-layout`'s document title, `ui-workspace`'s browser rows, `ui-session`'s
 * `isMain`): a row is in view while something holds it under the `mainView`
 * source. `SessionListState` has no `current` field to read instead, and reading
 * a missing field through a selector is silent — the surface simply renders
 * nothing, forever.
 *
 * @param state - the session list snapshot, or undefined before the slot binds.
 * @returns the session id in view, or undefined when none is.
 */
export function mainSessionId(state: SessionsState | undefined): string | undefined {
  const byId = state?.byId
  if (byId === undefined) return undefined
  for (const [id, row] of Object.entries(byId)) {
    if ((row?.retainedBy?.mainView ?? 0) > 0) return id
  }
  return undefined
}

/**
 * Read the session in view.
 * @param hook - the slot's selector hook, when it provides one.
 * @returns the session id, or undefined when the surface has no session in view.
 */
export function useCurrentSession(hook: SessionsHook | undefined): string | undefined {
  return hook !== undefined ? hook(state => mainSessionId(state)) : undefined
}

/**
 * Count the live jobs in one session's roster slice.
 * @param jobs - the session's job rows, or undefined when it has none.
 * @returns how many are running or stopping.
 */
export function countRunningJobs(jobs: readonly SessionJobView[] | undefined): number {
  if (jobs === undefined) return 0
  return jobs.reduce((total, job) => total + (job.status === 'running' || job.status === 'stopping' ? 1 : 0), 0)
}

/**
 * One session's job rows, as `ctx.jobs` publishes them.
 *
 * This is DSH's own client roster — the one its job list draws from — not the
 * registry's output cursor. Reading it is free and steals nothing: the plugin
 * still never reads a job's output, which belongs to the model's `job_output`
 * tool alone. The rows exist to explain an empty panel: a job that runs without
 * reporting progress is invisible in the plugin's own files by design, and saying
 * so is better than looking broken.
 *
 * A session nobody watches has no key at all rather than an empty array, so both
 * absences answer with the same shared reference.
 *
 * @param snapshot - a roster snapshot, or undefined before the service loads.
 * @param sessionId - the session in view; undefined selects nothing.
 * @returns that session's rows, in the roster's order.
 */
export function jobRowsOf(
  snapshot: { readonly rows: Readonly<Record<string, readonly SessionJobView[]>> } | undefined,
  sessionId: string | undefined,
): readonly SessionJobView[] {
  if (snapshot === undefined || sessionId === undefined) return NO_JOBS
  return snapshot.rows[sessionId] ?? NO_JOBS
}

/**
 * The observable roster snapshot: what `ctx.jobs.state` is.
 *
 * Structural rather than imported: the plugin ships no dependency on DSH's
 * packages, so the shape is restated here and pinned against the real service by
 * `test/client-contract.test.ts`.
 */
export interface JobRowsSource {
  /** Identity-stable current snapshot; `rows` is keyed by session id. */
  getSnapshot(): { readonly rows: Readonly<Record<string, readonly SessionJobView[]>> }
  /** Observe snapshot replacements. */
  subscribe(listener: () => void): () => void
}

/**
 * The slice of the client jobs service these surfaces use.
 *
 * **Two objects, not one** — and getting that wrong fails in the worst way: the
 * snapshot lives on `ctx.jobs.state` (`JobsSource`), while stream control lives
 * on `ctx.jobs` itself (`IJobs`). Reading `getSnapshot` off the service throws
 * during render, which takes the whole surface down and looks exactly like "the
 * overlay disappeared".
 *
 * @see `packages/api/job-controller/src/client/service.ts` (`IJobs`)
 * @see `packages/api/job-controller/src/client/model.ts` (`JobsSource`)
 */
export interface JobRosterLike {
  /** The observable roster snapshot. */
  readonly state: JobRowsSource
  /**
   * Keep one session's roster streaming.
   *
   * Reference-counted on DSH's side and therefore not optional: the snapshot
   * carries nothing for a session nobody watches, so a surface that only reads
   * would show no jobs at all.
   * @param sessionId - the session whose visible jobs to mirror.
   * @returns the releaser, which drops this watcher's reference.
   */
  watchRows(sessionId: string): () => void
}

/**
 * A holder for the job roster, filled when the service arrives.
 *
 * The surfaces register unconditionally and read the roster through this, so a
 * deployment where `ctx.jobs` is late (or absent) still draws the plugin's own
 * reported tasks. That ordering matters: the overlay's core job is showing work
 * a script reported, and it must never depend on another service having loaded
 * first.
 */
export interface RosterSlot {
  /** The current roster, or undefined while the service is absent. */
  get(): JobRosterLike | undefined
  /** Publish a roster (or its removal) to every subscriber. */
  set(next: JobRosterLike | undefined): void
  /** Observe arrivals and removals. */
  subscribe(listener: () => void): () => void
}

/**
 * Create an empty roster slot.
 * @returns the slot, ready to be handed to a surface.
 */
export function createRosterSlot(): RosterSlot {
  let value: JobRosterLike | undefined
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return
      value = next
      // Copied before iterating: a listener may unsubscribe as it runs.
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
