/**
 * React bindings for the page's progress store.
 *
 * `useSyncExternalStore` is exactly the contract the store already offers —
 * a stable snapshot between changes and a subscribe function — so no context,
 * no provider, and no re-render plumbing is needed for a face-wide surface and
 * a sidebar tab to read the same value.
 *
 * @module dsh-task-progress/client/useProgress
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ProgressState } from '../protocol.ts'
import { progressStore, type ProgressStore } from './store.ts'

/**
 * Subscribe to one session's progress document.
 *
 * The subscription is per session because the Host half answers per session: a
 * surface only ever holds the data of the session it is showing.
 * @param sessionId - the session to read; undefined reads nothing and renders none.
 * @param store - the store to read; defaults to the page's single store.
 * @returns the latest document, or null before the first successful poll.
 */
export function useProgress(sessionId: string | undefined, store: ProgressStore = progressStore): ProgressState | null {
  const subscribe = useCallback(
    (listener: () => void) => sessionId === undefined ? () => {} : store.subscribe(sessionId, listener),
    [store, sessionId],
  )
  const getSnapshot = useCallback(
    () => sessionId === undefined ? null : store.getSnapshot(sessionId),
    [store, sessionId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * A clock that ticks only while it is being watched.
 *
 * Every live figure (elapsed, remaining, "quiet for") is derived from this, so
 * one interval updates a whole panel instead of one per row — and an idle panel
 * on a hidden tab costs nothing.
 *
 * @param intervalMs - tick period, milliseconds.
 * @param enabled - false stops the timer entirely (nothing on screen is moving).
 * @returns the current clock, epoch milliseconds.
 */
export function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, enabled])
  return now
}
