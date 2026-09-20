/**
 * The one row renderer both surfaces share.
 *
 * Keeping this in a single component is what makes the floating overlay and the
 * sidebar tab incapable of drifting apart: they differ in selection and
 * chrome, never in how a task is described.
 *
 * @module dsh-task-progress/client/TaskList
 */

import type { ReactNode } from 'react'
import type { ProgressTask, TaskState } from '../protocol.ts'
import { estimateRemainingMs, formatDuration, formatPct, isStalled, unitText } from './format.ts'
import type { Translate } from './locales.ts'

/** Locale key per lifecycle state. */
const STATE_KEY: Record<TaskState, 'state.running' | 'state.done' | 'state.failed' | 'state.cancelled'> = {
  running: 'state.running',
  done: 'state.done',
  failed: 'state.failed',
  cancelled: 'state.cancelled',
}

/** Props for one task row. */
export interface TaskRowProps {
  /** The task to describe. */
  readonly task: ProgressTask
  /** Namespace-bound translator. */
  readonly t: Translate
  /** Current clock, epoch milliseconds; drives every live figure. */
  readonly now: number
  /** Show which session reported the task (the global surfaces do). */
  readonly showSession?: boolean
}

/**
 * The bar. An unreported percentage animates instead of inventing a number.
 * @param props - the task to draw.
 * @returns the bar element.
 */
export function ProgressBar({ task }: { readonly task: ProgressTask }): ReactNode {
  const indeterminate = task.pct === null && task.state === 'running'
  const width = task.pct === null ? (task.state === 'running' ? 100 : 0) : task.pct
  return (
    <div
      className="dtp-track"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={task.pct ?? undefined}
      aria-label={`${task.task} ${formatPct(task.pct)}`}
    >
      <div
        className="dtp-fill"
        data-state={task.state}
        data-indeterminate={indeterminate ? '' : undefined}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

/**
 * One row: name, state, bar, latest message, and the derived figures.
 * @param props - the task, translator, clock, and whether to name the session.
 * @returns the row element.
 */
export function TaskRow({ task, t, now, showSession = false }: TaskRowProps): ReactNode {
  const units = unitText(task)
  const remaining = estimateRemainingMs(task, now)
  const quiet = isStalled(task, now)
  const elapsed = task.state === 'running' ? now - task.startedAt : task.updatedAt - task.startedAt
  return (
    <li className="dtp-row">
      <div className="dtp-rowHead">
        <span className="dtp-name" title={task.task}>{task.task}</span>
        <span className="dtp-state" data-state={task.state}>{t(STATE_KEY[task.state])}</span>
        <span className="dtp-pct">{formatPct(task.pct)}</span>
      </div>
      <ProgressBar task={task} />
      {task.msg.length > 0 ? <div className="dtp-msg" title={task.msg}>{task.msg}</div> : null}
      <div className="dtp-meta">
        <span>{t('meta.elapsed', { time: formatDuration(Math.max(0, elapsed)) })}</span>
        {units !== null ? (
          <span>{t('meta.units', { done: task.done ?? 0, total: task.total ?? 0, unit: task.unit })}</span>
        ) : null}
        {remaining !== null ? <span>{t('meta.eta', { time: formatDuration(remaining) })}</span> : null}
        {quiet ? <span data-warn="">{t('meta.stalled', { time: formatDuration(now - task.updatedAt) })}</span> : null}
        {showSession && task.sessionId.length > 0
          ? <span>{t('meta.session', { id: task.sessionId.slice(0, 8) })}</span>
          : null}
      </div>
    </li>
  )
}
