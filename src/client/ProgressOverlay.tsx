/**
 * The floating surface: a compact pill that expands into the task list.
 *
 * Registered into `shell.overlay`, the frame-wide layer above every column. That
 * layer is click-through by design, so this entry opts back into pointer events
 * on exactly its own two boxes — the rest of the frame stays usable while the
 * pill is on screen.
 *
 * It renders nothing at all when there is nothing to report: an idle session
 * must not grow a floating widget.
 *
 * @module dsh-task-progress/client/ProgressOverlay
 */

import { useState, type ReactNode } from 'react'
import type { ProgressState } from '../protocol.ts'
import { countRunning, headlineTask, selectTasks } from './format.ts'
import type { Translate } from './locales.ts'
import { useCurrentSession, type SessionsHook } from './session-hook.ts'
import { TaskRow } from './TaskList.tsx'
import { useNow, useProgress } from './useProgress.ts'

/** Props the overlay receives. */
export interface ProgressOverlayProps {
  /** Namespace-bound translator, threaded in at registration. */
  readonly t: Translate
  /** Standard slot prop: the sessions store. Absent only outside the shell. */
  readonly useSessions?: SessionsHook
}

/**
 * The floating progress overlay.
 * @param props - the translator and the session selector hook.
 * @returns the pill (or expanded card), or null when nothing is running.
 */
export function ProgressOverlay({ t, useSessions }: ProgressOverlayProps): ReactNode {
  const current = useCurrentSession(useSessions)
  const state: ProgressState | null = useProgress()
  const [open, setOpen] = useState(false)
  const tick = (state?.tasks.length ?? 0) > 0
  const now = useNow(1000, tick)
  const tasks = selectTasks(state, current, now, 'active')

  if (tasks.length === 0) return null

  const running = countRunning(tasks)
  const headline = headlineTask(tasks)
  const label = running === 1 ? t('overlay.activeOne') : t('overlay.active', { count: running })

  return (
    <div className="dtp-overlay">
      {open
        ? (
          <section className="dtp-card" aria-label={t('tab.heading')}>
            <header className="dtp-cardHead">
              {running > 0 ? <span className="dtp-spinner" aria-hidden="true" /> : null}
              <span className="dtp-cardTitle">{t('tab.heading')}</span>
              <span className="dtp-cardCount">{t('tab.counts', { running, finished: tasks.length - running })}</span>
              <button
                type="button"
                className="dtp-cardClose"
                aria-label={t('overlay.collapse')}
                onClick={() => setOpen(false)}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2 3h8M2 6h8M2 9h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </header>
            <ul className="dtp-list">
              {tasks.map(task => (
                <TaskRow
                  key={`${task.sessionId}:${task.task}`}
                  task={task}
                  t={t}
                  now={now}
                  showSession={current === undefined}
                />
              ))}
            </ul>
          </section>
        )
        : (
          <button
            type="button"
            className="dtp-pill"
            aria-expanded={false}
            aria-label={t('overlay.expand')}
            onClick={() => setOpen(true)}
          >
            {running > 0 ? <span className="dtp-spinner" aria-hidden="true" /> : null}
            <span className="dtp-pillText">{label}</span>
            {headline !== null
              ? (
                <span className="dtp-pillTask">
                  {headline.task}
                  {headline.pct !== null ? ` ${Math.round(headline.pct)}%` : ''}
                </span>
              )
              : null}
            <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 8l3-4 3 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        )}
    </div>
  )
}
