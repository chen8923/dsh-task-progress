/**
 * React bindings for the client job roster.
 *
 * Split from `session-hook.ts` so the selectors there stay pure and importable
 * by the suite, which has no React. Everything here is a thin
 * `useSyncExternalStore` wrapper plus the one effect that keeps DSH's roster
 * streaming while a surface is on screen.
 *
 * @module dsh-task-progress/client/job-roster
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  countRunningJobs, jobRowsOf, observedTailOf,
  type JobRosterLike, type ObservedJobView, type RosterSlot, type SessionJobView,
} from './session-hook.ts'

/**
 * The subscription a surface uses while it has no roster (or no session).
 *
 * It must **return a cleanup function**, not merely be one: `useSyncExternalStore`
 * calls the subscriber and keeps what it hands back, so a no-op that returns
 * `undefined` makes React throw during render and unmounts the whole surface —
 * which is exactly how this file first broke the overlay, silently: no error in
 * the panel, the pill simply never appeared.
 */
const NEVER_SUBSCRIBE = (): (() => void) => () => {}

/**
 * Resolve the roster slot into the roster itself.
 *
 * The slot is read through the same external-store contract the roster uses, so
 * a surface registered before `ctx.jobs` exists still starts drawing job rows
 * the moment it arrives — without re-registering and without a reload.
 *
 * @param slot - the slot the plugin registered its surfaces with, if any.
 * @returns the roster, or undefined while the service is absent.
 */
export function useJobRoster(slot: RosterSlot | undefined): JobRosterLike | undefined {
  const subscribe = useCallback(
    (listener: () => void) => slot === undefined ? NEVER_SUBSCRIBE() : slot.subscribe(listener),
    [slot],
  )
  const getSnapshot = useCallback(() => slot?.get(), [slot])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * One session's job rows, kept live while it is on screen.
 *
 * Watching is not optional: DSH's roster carries nothing for a session nobody
 * asked about, so reading without `watchRows` answers with an empty list for a
 * session that has jobs — the same symptom as having no data source at all.
 *
 * @param roster - the client roster, or undefined while it is absent.
 * @param sessionId - the session in view; undefined watches nothing.
 * @returns that session's rows.
 */
export function useLiveJobs(
  roster: JobRosterLike | undefined,
  sessionId: string | undefined,
): readonly SessionJobView[] {
  // `ctx.jobs` carries the stream control; `ctx.jobs.state` carries the snapshot.
  // Reading the snapshot off the service throws during render (measured), which
  // takes the surface down with it.
  const source = roster?.state
  const subscribe = useCallback(
    (listener: () => void) => source === undefined ? NEVER_SUBSCRIBE() : source.subscribe(listener),
    [source],
  )
  const getSnapshot = useCallback(
    () => jobRowsOf(source?.getSnapshot(), sessionId),
    [source, sessionId],
  )
  const rows = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    if (roster === undefined || sessionId === undefined) return
    return roster.watchRows(sessionId)
  }, [roster, sessionId])
  return rows
}

/**
 * How many of one session's background jobs are live.
 * @param roster - the client roster, or undefined while it is absent.
 * @param sessionId - the session in view; undefined counts nothing.
 * @returns the live count.
 */
export function useLiveJobCount(roster: JobRosterLike | undefined, sessionId: string | undefined): number {
  return countRunningJobs(useLiveJobs(roster, sessionId))
}

/**
 * One job's observed output tail, kept streaming while its row is on screen.
 *
 * Observing is the same bargain `watchRows` makes: the tail exists only while
 * somebody asks for it, and DSH drops it with the last watcher — so a row that
 * wants to show output has to subscribe, and a row that stops rendering releases
 * it. It reads what DSH already streams to this browser, never the registry's
 * single-consumer `read()` cursor, which belongs to the model's `job_output`
 * tool.
 *
 * @param roster - the client roster, or undefined while it is absent.
 * @param sessionId - the owning session, for the fenced read; undefined for an unowned job.
 * @param jobId - the job whose tail to follow; undefined follows nothing.
 * @returns the tail, or undefined while it has not arrived.
 */
export function useObservedTail(
  roster: JobRosterLike | undefined,
  sessionId: string | undefined,
  jobId: string | undefined,
): ObservedJobView | undefined {
  const source = roster?.state
  const subscribe = useCallback(
    (listener: () => void) => source === undefined ? NEVER_SUBSCRIBE() : source.subscribe(listener),
    [source],
  )
  const getSnapshot = useCallback(
    () => observedTailOf(source?.getSnapshot(), jobId),
    [source, jobId],
  )
  const tail = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    if (roster === undefined || jobId === undefined) return
    return roster.observe(sessionId, jobId)
  }, [roster, sessionId, jobId])
  return tail
}
