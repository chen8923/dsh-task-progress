/**
 * Presentation helpers: every derived value the panel shows, and nothing else.
 *
 * Pure on purpose — these are the parts worth unit-testing without a DOM, and
 * keeping them here means the React components hold no formatting logic at all.
 *
 * @module dsh-task-progress/client/format
 */

import type { ProgressState, ProgressTask } from '../protocol.ts'

/** How long a finished task keeps showing in the compact overlay, milliseconds. */
export const OVERLAY_LINGER_MS = 10_000

/**
 * Compact duration in at most two units — the scale a long task actually lives at.
 * @param ms - duration in milliseconds; negatives clamp to zero.
 * @returns e.g. `12s`, `3m04s`, `1h02m`.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

/** Wall-clock `HH:MM:SS` for the panel's "updated" line. */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * The `done/total unit` figure, when the producer reported both.
 * @param task - the task to read.
 * @returns the figure, or null when the producer never reported units.
 */
export function unitText(task: ProgressTask): string | null {
  if (task.done === null || task.total === null || task.total <= 0) return null
  const unit = task.unit.length > 0 ? task.unit : ''
  return `${task.done}/${task.total}${unit.length > 0 ? ` ${unit}` : ''}`
}

/**
 * Rough remaining time from the percentage and the elapsed clock.
 *
 * Deliberately crude: a progress file reports whatever a script can cheaply
 * know, so a linear estimate is the honest reading, and it is suppressed while
 * there is too little movement to mean anything.
 * @param task - the task to project.
 * @param now - current clock, epoch milliseconds.
 * @returns the estimate in milliseconds, or null when it cannot be made.
 */
export function estimateRemainingMs(task: ProgressTask, now: number): number | null {
  if (task.state !== 'running') return null
  const pct = task.pct
  if (pct === null || pct < 5 || pct >= 100) return null
  const elapsed = now - task.startedAt
  if (elapsed < 5000) return null
  return Math.round((elapsed / pct) * (100 - pct))
}

/**
 * True when a running task has gone quiet for long enough to be worth saying so.
 * @param task - the task to check.
 * @param now - current clock, epoch milliseconds.
 * @param quietMs - the threshold, milliseconds.
 */
export function isStalled(task: ProgressTask, now: number, quietMs = 60_000): boolean {
  return task.state === 'running' && now - task.updatedAt > quietMs
}

/**
 * The tasks one surface should show.
 *
 * Both surfaces share this so they can never disagree about what "visible"
 * means: the session filter is the same, and only the terminal-task window
 * differs (`active` keeps a brief tail so a finish is visible, `all` keeps
 * everything the Host half still retains).
 *
 * @param state - the latest state document, or null before the first poll.
 * @param sessionId - the session to scope to; undefined means every session.
 * @param now - current clock, epoch milliseconds.
 * @param mode - `active` for the compact overlay, `all` for the sidebar tab.
 * @returns the visible tasks, in the order the Host half ranked them.
 */
export function selectTasks(
  state: ProgressState | null,
  sessionId: string | undefined,
  now: number,
  mode: 'active' | 'all',
): ProgressTask[] {
  if (state === null) return []
  const scoped = sessionId === undefined || sessionId.length === 0
    ? state.tasks
    : state.tasks.filter(task => task.sessionId === sessionId)
  if (mode === 'all') return [...scoped]
  return scoped.filter(task => task.state === 'running' || now - task.updatedAt < OVERLAY_LINGER_MS)
}

/** Count running tasks in a selection. */
export function countRunning(tasks: readonly ProgressTask[]): number {
  return tasks.reduce((total, task) => total + (task.state === 'running' ? 1 : 0), 0)
}

/** What the floating surface should do with what it has. */
export interface OverlayPolicy {
  /** Whether the floating surface shows anything at all. */
  readonly visible: boolean
  /** Whether what it shows is work nobody reported for, and should say so. */
  readonly warn: boolean
}

/**
 * Whether the floating surface may interrupt, and in what tone.
 *
 * It is one rule with one asymmetry, and the asymmetry is the point. Work **the
 * user asked to watch** — a script reporting progress — earns a pill: that is
 * the feature, and popping up is what it is for. Work nobody reported for does
 * not, by default: the job was launched for the work, not for this panel, and a
 * widget that summons itself to announce a missing report is a summons nobody
 * opted into. Those rows are still in the sidebar tab, which is a surface the
 * user opens on purpose.
 *
 * `allowUnreported` is the deployment's answer to that: a hidden setting, off
 * unless somebody goes looking, because the loud behaviour is the one that needs
 * justifying rather than the quiet one.
 * @param input - how many reported tasks are visible, how many live jobs nobody
 *   reported for, and whether that second number may summon the surface.
 * @returns whether to show, and whether to show in the attention colour.
 */
export function overlayPolicy(input: {
  readonly reported: number
  readonly unreported: number
  readonly allowUnreported: boolean
}): OverlayPolicy {
  const unreportedOnly = input.reported === 0 && input.unreported > 0
  if (unreportedOnly && !input.allowUnreported) return { visible: false, warn: false }
  return { visible: input.reported > 0 || input.unreported > 0, warn: unreportedOnly }
}

/**
 * The task a collapsed overlay should summarise: the running one that moved
 * most recently, falling back to the newest row of any state.
 * @param tasks - the visible selection.
 * @returns the task, or null when the selection is empty.
 */
export function headlineTask(tasks: readonly ProgressTask[]): ProgressTask | null {
  const running = tasks.filter(task => task.state === 'running')
  const pool = running.length > 0 ? running : tasks
  let best: ProgressTask | null = null
  for (const task of pool) if (best === null || task.updatedAt > best.updatedAt) best = task
  return best
}

/**
 * Percentage text, kept stable in width so a row does not jitter as it moves.
 * @param pct - the percentage, or null.
 * @returns e.g. `42%`, or `—` when the producer reported none.
 */
export function formatPct(pct: number | null): string {
  return pct === null ? '—' : `${Math.round(pct)}%`
}

/** How many lines of an observed tail a row shows. */
export const TAIL_LINES = 3
/** How wide one of those lines may be before it is clipped. */
export const TAIL_LINE_CHARS = 96

/**
 * The last few lines of an observed output tail, ready to render.
 *
 * The tail is whatever DSH streamed to this browser, so it can be thousands of
 * lines and any width at all. A row shows the most recent few, each clipped: the
 * question it answers is "what is this doing right now", not "show me the log" —
 * and a row that grew to fit a log would push the rest of the panel off screen.
 *
 * Trailing blank lines are dropped rather than shown. A tail usually ends with
 * the newline it was written with, and rendering that as an empty row would make
 * every quiet job look like it had gone blank.
 *
 * @param text - the observed tail, as the stream accumulated it.
 * @param maxLines - how many lines to keep; the most recent ones.
 * @param maxChars - the widest a kept line may be before it is clipped.
 * @returns the lines to render, oldest first; empty when there is nothing to say.
 */
export function tailLines(
  text: string,
  maxLines: number = TAIL_LINES,
  maxChars: number = TAIL_LINE_CHARS,
): readonly string[] {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  return lines.slice(-Math.max(1, maxLines)).map(line => clip(line, maxChars))
}

/**
 * Clip one line to a width, counting whole characters rather than code units.
 *
 * `slice` counts UTF-16 code units, so a clip that lands inside a surrogate pair cuts
 * it in half and the browser renders the replacement glyph where the character used to
 * be. A job's output is arbitrary text, so the boundary is reachable by accident — a
 * command that prints a progress bar of emoji is enough. The code-point array is built
 * only for a line that is already too long, which keeps the common case allocation-free.
 * @param line - the trimmed line.
 * @param maxChars - the widest it may be, ellipsis included.
 * @returns the line, clipped when it had to be.
 */
function clip(line: string, maxChars: number): string {
  const limit = Math.max(1, maxChars)
  if (line.length <= limit) return line
  const characters = [...line]
  if (characters.length <= limit) return line
  return `${characters.slice(0, limit - 1).join('')}…`
}
