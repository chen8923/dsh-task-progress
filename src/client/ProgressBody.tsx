/**
 * The sidebar surface: every task this session has reported, including the ones
 * that already finished (until the Host half ages them out).
 *
 * Registered into the keyed `sidebar.right.pane.tab` seat under this package's
 * tab id, so it is a tab body — `sessionId` arrives as a standard prop and scopes
 * the list, and the empty state is the place a producer learns the contract.
 *
 * @module dsh-task-progress/client/ProgressBody
 */

import type { ReactNode } from 'react'
import { unreportedJobs } from '../jobs.ts'
import type { ProgressState } from '../protocol.ts'
import { countRunning, formatClock, selectTasks } from './format.ts'
import { JobGroup } from './JobList.tsx'
import { useJobRoster, useLiveJobs, useLiveJobCount } from './job-roster.ts'
import type { Translate } from './locales.ts'
import type { RosterSlot, SessionsHook } from './session-hook.ts'
import { TaskRow } from './TaskList.tsx'
import { useNow, useProgress } from './useProgress.ts'

/** Props the tab body receives. */
export interface ProgressBodyProps {
  /** Namespace-bound translator, supplied because the slot registered `locale: NS`. */
  readonly t: Translate
  /** Standard slot prop: the session this tab belongs to. */
  readonly sessionId?: string
  /** Standard slot prop: the sessions store, for the unreported-job hint. */
  readonly useSessions?: SessionsHook
  /** The client job roster, when `ctx.jobs` has loaded; absent loses only the job rows. */
  readonly roster?: RosterSlot
}

/**
 * What a producer must do, shown only while there is nothing to show.
 * @param props - the translator.
 * @returns the empty state.
 */
function EmptyState({ t, unreportedJobs }: { readonly t: Translate, readonly unreportedJobs: number }): ReactNode {
  return (
    <div className="dtp-empty">
      <span className="dtp-emptyTitle">{t('tab.emptyTitle')}</span>
      {unreportedJobs > 0
        // The likeliest reason a reader finds nothing here is a job that is
        // running without reporting. Naming it is the difference between a
        // panel that looks broken and one that explains itself.
        ? <span className="dtp-emptyRunning">{t('tab.emptyRunning', { count: unreportedJobs })}</span>
        : null}
      <span>{t('tab.emptyBody')}</span>
      {/* The cheapest recipe first: wrapping a command is one line, and it is the
          one a reader of an empty panel needs. The hand-written line stays below
          it, because a panel that only taught the easy path would be lying about
          what the protocol can express. */}
      <pre className="dtp-code">{`node "$env:DSH_PROGRESS_CLI" run --task build -- <your long command>

'{"v":1,"task":"build","state":"running","pct":42,"msg":"linking"}' |
  Add-Content -Encoding utf8 (Join-Path $env:DSH_PROGRESS_DIR build.jsonl)`}</pre>
      <span className="dtp-note">{t('tab.emptyNote')}</span>
    </div>
  )
}

/**
 * The right-sidebar tab body.
 * @param props - the translator, this tab's session, and the session selector hook.
 * @returns the list, or the empty state that documents the contract.
 */
export function ProgressBody({ t, sessionId, useSessions, roster: rosterSlot }: ProgressBodyProps): ReactNode {
  const state: ProgressState | null = useProgress(sessionId)
  const roster = useJobRoster(rosterSlot)
  const unreportedCount = useLiveJobCount(roster, sessionId)
  const tick = (state?.tasks.length ?? 0) > 0
  const now = useNow(1000, tick)
  const tasks = selectTasks(state, sessionId, now, 'all')
  // Coverage is judged against every task this session has reported, finished
  // ones included: a job whose script reported and then exited was reported.
  const jobs = unreportedJobs(useLiveJobs(roster, sessionId), tasks.map(task => task.task))

  if (tasks.length === 0 && jobs.length === 0) return <EmptyState t={t} unreportedJobs={unreportedCount} />

  const running = countRunning(tasks)
  const footer = state !== null
    ? <footer className="dtp-bodyFoot">{t('tab.updated', { time: formatClock(state.generatedAt) })}</footer>
    : null

  // A session whose only live work is unreported has no task counts worth
  // printing; drawing "0 running · 0 finished" next to real rows would be worse
  // than drawing nothing.
  if (tasks.length === 0) {
    return (
      <div className="dtp-body">
        <JobGroup jobs={jobs} t={t} now={now} />
        {footer}
      </div>
    )
  }

  return (
    <div className="dtp-body">
      <header className="dtp-bodyHead">
        <span className="dtp-bodyTitle">{t('tab.heading')}</span>
        <span className="dtp-bodyCounts">
          {t('tab.counts', { running, finished: tasks.length - running })}
        </span>
      </header>
      <JobGroup jobs={jobs} t={t} now={now} />
      <ul className="dtp-list">
        {tasks.map(task => (
          <TaskRow key={`${task.sessionId}:${task.task}`} task={task} t={t} now={now} />
        ))}
      </ul>
      {footer}
    </div>
  )
}
