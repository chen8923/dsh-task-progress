/**
 * The row shape a background job gets when no script is reporting for it.
 *
 * These rows exist because of one failure the plugin used to have: a job that
 * runs for fifteen minutes with nothing reported showed *nothing at all*, so the
 * panel looked broken and the only honest reading of an absent pill was "no work
 * is running". The data was already in the browser — DSH pushes a per-session job
 * mirror for its own job list — so the fix is to draw it.
 *
 * What a mirror row can say is bounded by what the mirror carries: the command,
 * how long it has been running, and how it ended. No percentage, because nothing
 * measured one. The note under the group says so rather than implying a progress
 * bar that does not exist.
 *
 * @module dsh-task-progress/client/JobList
 */

import type { ReactNode } from 'react'
import { jobElapsedMs, type JobView } from '../jobs.ts'
import { formatDuration, tailLines } from './format.ts'
import { useObservedTail } from './job-roster.ts'
import type { Translate } from './locales.ts'
import type { JobRosterLike } from './session-hook.ts'

/** Props one job row needs. */
export interface JobRowProps {
  /** The job, from DSH's own roster. */
  readonly job: JobView
  /** Namespace-bound translator. */
  readonly t: Translate
  /** Current epoch ms, for the elapsed reading. */
  readonly now: number
  /**
   * The client roster, so this row can show what the job is actually printing.
   *
   * Optional because the row is still worth drawing without it — a job nobody can
   * observe is a job with no output tail, not a job with no row.
   */
  readonly roster?: JobRosterLike
  /** The session this row belongs to, for the fenced observation read. */
  readonly sessionId?: string
}

/**
 * One background job: the command it is running, how long for, and — while DSH is
 * streaming it — the last few lines it printed.
 * @param props - the job, the translator, the clock, and the roster to observe through.
 * @returns one list row.
 */
export function JobRow({ job, t, now, roster, sessionId }: JobRowProps): ReactNode {
  // Observing is what makes a tail exist at all: the row asks, DSH streams, and
  // the row releases it when it stops rendering. It is the same client service
  // the session's rows already come from — never the registry's `read()` cursor.
  const tail = useObservedTail(roster, sessionId, job.id)
  const elapsed = jobElapsedMs(job, now)
  const raw = typeof job.label === 'string' ? job.label.replace(/\s+/g, ' ').trim() : ''
  const label = raw.length > 0 ? raw : job.id
  const lines = tail === undefined ? [] : tailLines(tail.text)
  return (
    <li className="dtp-job">
      {/* The full command line belongs in the tooltip: a row has one line. */}
      <span className="dtp-jobLabel" title={label}>{label}</span>
      <span className="dtp-jobMeta">
        {elapsed !== null ? t('jobs.elapsed', { time: formatDuration(elapsed) }) : null}
        {job.status === 'stopping' ? <span className="dtp-jobState">{t('jobs.stopping')}</span> : null}
      </span>
      {lines.length > 0
        ? (
          // What the job is printing right now — the difference between a row that
          // says "something is running" and one that says what it is doing. The
          // full tail stays in the tooltip; the row shows only the last few lines.
          <pre className="dtp-jobTail" title={tail?.text}>{lines.join('\n')}</pre>
        )
        : null}
    </li>
  )
}

/** Props the group needs. */
export interface JobGroupProps {
  /** Live jobs nothing has reported for. */
  readonly jobs: readonly JobView[]
  /** Namespace-bound translator. */
  readonly t: Translate
  /** Current epoch ms. */
  readonly now: number
  /** The client roster, so each row can show its job's output tail. */
  readonly roster?: JobRosterLike
  /** The session these rows belong to, for the fenced observation read. */
  readonly sessionId?: string
}

/**
 * The group that appears above the reported tasks.
 * @param props - the jobs, the translator, the clock, and the roster.
 * @returns the group, or null when there is nothing to show.
 */
export function JobGroup({ jobs, t, now, roster, sessionId }: JobGroupProps): ReactNode {
  if (jobs.length === 0) return null
  return (
    <section className="dtp-jobs">
      <header className="dtp-jobsHead">{t('jobs.heading', { count: jobs.length })}</header>
      <ul className="dtp-list">
        {jobs.map(job => (
          <JobRow key={job.id} job={job} t={t} now={now} roster={roster} sessionId={sessionId} />
        ))}
      </ul>
      <p className="dtp-jobsNote">{t('jobs.note')}</p>
    </section>
  )
}
