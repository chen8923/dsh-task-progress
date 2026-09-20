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

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ProgressState } from '../protocol.ts'
import { progressStore, type ProgressStore } from './store.ts'

/**
 * Subscribe to the progress document.
 * @param store - the store to read; defaults to the page's single store.
 * @returns the latest document, or null before the first successful poll.
 */
export function useProgress(store: ProgressStore = progressStore): ProgressState | null {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
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
