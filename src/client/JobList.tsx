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
import { formatDuration } from './format.ts'
import type { Translate } from './locales.ts'

/** Props one job row needs. */
export interface JobRowProps {
  /** The job, from DSH's own mirror. */
  readonly job: JobView
  /** Namespace-bound translator. */
  readonly t: Translate
  /** Current epoch ms, for the elapsed reading. */
  readonly now: number
}

/**
 * One background job: the command it is running, and how long for.
 * @param props - the job, the translator, and the clock.
 * @returns one list row.
 */
export function JobRow({ job, t, now }: JobRowProps): ReactNode {
  const elapsed = jobElapsedMs(job, now)
  const raw = typeof job.label === 'string' ? job.label.replace(/\s+/g, ' ').trim() : ''
  const label = raw.length > 0 ? raw : job.id
  return (
    <li className="dtp-job">
      {/* The full command line belongs in the tooltip: a row has one line. */}
      <span className="dtp-jobLabel" title={label}>{label}</span>
      <span className="dtp-jobMeta">
        {elapsed !== null ? t('jobs.elapsed', { time: formatDuration(elapsed) }) : null}
        {job.status === 'stopping' ? <span className="dtp-jobState">{t('jobs.stopping')}</span> : null}
      </span>
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
}

/**
 * The group that appears above the reported tasks.
 * @param props - the jobs, the translator, and the clock.
 * @returns the group, or null when there is nothing to show.
 */
export function JobGroup({ jobs, t, now }: JobGroupProps): ReactNode {
  if (jobs.length === 0) return null
  return (
    <section className="dtp-jobs">
      <header className="dtp-jobsHead">{t('jobs.heading', { count: jobs.length })}</header>
      <ul className="dtp-list">
        {jobs.map(job => <JobRow key={job.id} job={job} t={t} now={now} />)}
      </ul>
      <p className="dtp-jobsNote">{t('jobs.note')}</p>
    </section>
  )
}
