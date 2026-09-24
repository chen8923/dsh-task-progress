/**
 * The reminder that makes the convention reachable without editing any file.
 *
 * A system-prompt section tells the model the convention once, among hundreds of
 * other lines, at a moment when it is not yet making the decision. This module
 * tells it *at the decision*: before each model step, if this session has a
 * background job that has been running past the threshold and that no reported
 * task accounts for, one notice rides along with that step.
 *
 * It reads only `ctx.jobs.list()` — registry **snapshots**, which are documented
 * as non-consuming and leave the read cursor alone. A job's output stays the
 * model's `job_output` cursor, exactly as before.
 *
 * Three properties matter more than the feature:
 *
 * 1. **It can never break a step.** Everything is wrapped: the downstream
 *    decision is taken first and returned unchanged on any failure of ours.
 * 2. **It never vetoes.** The listener delegates, then optionally appends. A
 *    composition without `jobs` simply never registers it.
 * 3. **It speaks once per job, and only about old ones.** The notice costs
 *    context, so the threshold (default 30 s) and the per-job memory keep it
 *    rare: a session whose scripts report, or whose jobs are short, pays nothing.
 *
 * @module dsh-task-progress/host/reminder
 */

import { randomUUID } from 'node:crypto'
import { jobCanReport, labelNamesTask, type JobView } from '../jobs.ts'
import type { ProgressState } from '../protocol.ts'

/** Default delay before a silent job is mentioned to the model, milliseconds. */
export const DEFAULT_REMIND_AFTER_MS = 30_000

/** How many job labels the notice names before it just counts the rest. */
const MAX_LISTED_JOBS = 3

/** Longest command label quoted into the notice. */
const MAX_LABEL_CHARS = 60

/** The slice of `ctx.jobs` this plugin uses: snapshots, never `read()`. */
export interface JobsLike {
  /**
   * List the calling session's visible jobs, as fresh non-consuming snapshots.
   *
   * The caller is a **session id**, not the agent that owns it: the registry
   * filters on `job.owner.id === caller`, so a caller it cannot match is
   * answered with the unowned jobs alone — which for a session's own work means
   * nothing at all.
   */
  list(caller?: string): readonly JobView[]
}

/** The slice of the task store the reminder consults. */
export interface ReportedSource {
  /** Fold the reported state of one session. */
  snapshot(now?: number, sessionId?: string): ProgressState
}

/** The one agent-loop event this plugin listens to. */
export interface AgentLoopLike {
  /** Register a waterfall listener; the disposer removes it. */
  on(
    event: string,
    listener: (payload: PreStepPayload, next: () => Promise<PreStepDecisionLike>) => unknown,
  ): () => void
}

/** Payload of `agent/pre-step`. */
export interface PreStepPayload {
  /** The agent about to take a step. */
  readonly agent?: unknown
  /** The messages this step would carry. */
  readonly messages?: readonly unknown[]
}

/** The decision `agent/pre-step` waterfalls resolve to. */
export interface PreStepDecisionLike {
  /** `enter` proceeds; anything else is left untouched. */
  readonly kind?: string
  /** The messages the step will carry. */
  readonly messages?: readonly unknown[]
}

/**
 * The reported task names this session is currently reporting under.
 * @param store - the task store.
 * @param now - current epoch ms.
 * @param sessionId - the session whose reports to read, when known.
 * @returns live task names; empty when the session is unknown or reports nothing.
 */
function liveTaskNames(store: ReportedSource, now: number, sessionId: string | undefined): string[] {
  if (sessionId === undefined) return []
  return store.snapshot(now, sessionId).tasks
    .filter(task => task.state === 'running')
    .map(task => task.task)
}

/**
 * Whether a reported task already accounts for this job.
 *
 * Called only for jobs that are already past the threshold, so the cost is one
 * fold of one session's small state document per candidate.
 * @param job - the job under consideration.
 * @param store - the task store.
 * @param now - current epoch ms.
 * @returns true when the job should be left alone.
 */
function isCovered(job: JobView, store: ReportedSource, now: number): boolean {
  const names = liveTaskNames(store, now, job.owner)
  return names.some(name => labelNamesTask(job.label, name))
}

/**
 * The jobs worth one notice: live, able to report, past the threshold, unaccounted for.
 * @param jobs - this agent's snapshots.
 * @param store - the task store.
 * @param now - current epoch ms.
 * @param afterMs - how long a job must have been running; `0` disables the reminder.
 * @param already - ids already mentioned to this agent.
 * @returns the jobs to mention, in registry order.
 */
export function dueForReminder(
  jobs: readonly JobView[],
  store: ReportedSource,
  now: number,
  afterMs: number,
  already: ReadonlySet<string>,
): JobView[] {
  if (!(afterMs > 0)) return []
  return jobs.filter(job =>
    !already.has(job.id)
    // `stopping` is excluded on purpose: work that is already being cancelled has
    // nothing left for the model to arrange.
    && job.status === 'running'
    && jobCanReport(job)
    && typeof job.startedAt === 'number'
    && now - job.startedAt >= afterMs
    && !isCovered(job, store, now))
}

/** Quote one job the way the notice names it. */
function describe(job: JobView): string {
  const label = typeof job.label === 'string' ? job.label.replace(/\s+/g, ' ').trim() : ''
  const quoted = label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label
  return quoted.length > 0 ? `${job.id} (${quoted})` : job.id
}

/**
 * The notice itself.
 *
 * It is written to prevent the one destructive reading a notice like this can
 * invite: restarting work that is already halfway done is far worse than an
 * empty panel, so the text forbids it in as many words.
 * @param jobs - the jobs to mention.
 * @param afterMs - the threshold that was crossed, for the wording.
 * @returns the notice text.
 */
/**
 * Quote the crossed threshold at the resolution it was given.
 *
 * The notice says a job has been quiet "for over <n>", and that number has to be
 * the bar the deployment actually set: `Math.max(1, Math.round(afterMs / 60_000))`
 * turned the shipped 30-second default into "over 1 min", which overstates how
 * long the job has been silent and hides that the user chose a much shorter bar.
 * A minute or more still reads in minutes.
 * @param afterMs - the threshold that was crossed, in milliseconds.
 * @returns the threshold as a short phrase (`30 s`, `1 min`, `10 min`).
 */
function formatThreshold(afterMs: number): string {
  if (afterMs < 60_000) return `${Math.max(1, Math.round(afterMs / 1000))} s`
  return `${Math.max(1, Math.round(afterMs / 60_000))} min`
}

export function reminderText(jobs: readonly JobView[], afterMs: number): string {
  const threshold = formatThreshold(afterMs)
  const named = jobs.slice(0, MAX_LISTED_JOBS).map(describe).join(', ')
  const rest = jobs.length > MAX_LISTED_JOBS ? ` and ${jobs.length - MAX_LISTED_JOBS} more` : ''
  const plural = jobs.length === 1 ? 'job has' : 'jobs have'
  return `${jobs.length} background ${plural} been running for over ${threshold} with no progress reported, `
    + `so the user's progress panel shows nothing for ${jobs.length === 1 ? 'it' : 'them'}: ${named}${rest}. `
    + 'If a script is still working, have it append progress events to `$DSH_PROGRESS_DIR/<task>.jsonl` '
    + '(or run `node "$DSH_PROGRESS_CLI" emit --task <id> --pct N --msg "..."`); if it cannot, tell the user '
    + 'these jobs have no progress detail. Do not restart a job that is already running.'
}

/**
 * Build one plugin-authored notice message.
 *
 * DSH builds these with `createUserMessage`, which only stamps a fresh uuid and
 * a `user` role onto the given content and source. The shape is reproduced here
 * rather than imported, because importing a DSH package would put a second
 * dependency in a plugin whose whole installation story is "zero dependencies".
 * @param text - the notice body.
 * @returns a frozen message DSH can carry into the next step.
 */
export function createReminderMessage(text: string): {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text', readonly text: string }[]
  readonly source: {
    readonly kind: 'plugin'
    readonly plugin: string
    readonly form: 'notice'
    readonly summary: string
  }
} {
  const summary = text.slice(0, 80)
  return Object.freeze({
    id: randomUUID(),
    role: 'user' as const,
    content: Object.freeze([Object.freeze({ type: 'text' as const, text })]),
    source: Object.freeze({
      kind: 'plugin' as const,
      plugin: 'dsh-task-progress',
      form: 'notice' as const,
      summary,
    }),
  })
}

/**
 * Register the reminder.
 *
 * `afterMs <= 0` disables it entirely, which is also how a composition opts out.
 * A getter is accepted so a settings change takes effect on the next step
 * instead of needing a reload.
 * @param ctx - the host context carrying the agent-loop event bus.
 * @param jobs - the job registry, read as snapshots only.
 * @param store - the task store, consulted to avoid mentioning a job that reports.
 * @param afterMs - how long a job must have been silent before the model hears about it.
 * @returns the disposer that unregisters the listener.
 */
export function registerProgressReminder(
  ctx: AgentLoopLike,
  jobs: JobsLike,
  store: ReportedSource,
  afterMs: number | (() => number) = DEFAULT_REMIND_AFTER_MS,
): () => void {
  const readAfterMs = typeof afterMs === 'function' ? afterMs : (): number => afterMs
  // A constant zero needs no listener at all. A getter may become zero later, so
  // that case is re-checked on every step instead.
  if (typeof afterMs === 'number' && !(afterMs > 0)) return () => {}

  /** Job ids already mentioned, per agent. Bounded by the live jobs of that agent. */
  const mentioned = new WeakMap<object, Set<string>>()

  return ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecisionLike> => {
    // Delegate first and exactly once: the downstream decision is authoritative,
    // and a later listener must still be able to block or replace this step.
    const decision = await next()
    try {
      if (decision?.kind !== 'enter') return decision
      const threshold = readAfterMs()
      if (!(threshold > 0)) return decision
      const agent = payload?.agent
      if (typeof agent !== 'object' || agent === null) return decision
      // The registry is asked as a session, and an agent's `id` *is* its session
      // id — the same value its jobs carry in `owner`. Without one there is no
      // question to ask, and guessing would only produce a wrong answer: a
      // caller the registry cannot match sees unowned jobs alone.
      const caller = typeof (agent as { id?: unknown }).id === 'string' ? (agent as { id: string }).id : undefined
      if (caller === undefined) return decision

      const now = Date.now()
      const snapshots = jobs.list(caller)
      const already = mentioned.get(agent) ?? new Set<string>()
      // Forget ids that are no longer live, so the memory cannot grow with the
      // session's job history.
      const live = new Set(snapshots.map(job => job.id))
      for (const id of [...already]) if (!live.has(id)) already.delete(id)

      const due = dueForReminder(snapshots, store, now, threshold, already)
      if (due.length === 0) return decision
      for (const job of due) already.add(job.id)
      mentioned.set(agent, already)

      const messages = decision.messages ?? []
      return { ...decision, messages: [...messages, createReminderMessage(reminderText(due, threshold))] }
    } catch {
      // A reminder is a courtesy. If ours fails for any reason, the step still
      // proceeds exactly as it would have without this plugin.
      return decision
    }
  })
}
