/**
 * The browser half's state: one poll loop, one snapshot, any number of readers.
 *
 * Polling rather than a push channel is a deliberate trade. The Host half has no
 * output event to ride (job output is a single-consumer cursor the model owns),
 * the data is a couple of kilobytes of JSON on localhost, and a poll loop is the
 * one design that cannot desynchronize: every reader sees the same last-wins
 * document, a missed tick costs one interval, and there is no reconnect logic to
 * get wrong. The interval comes from the Host half's own configuration, so a
 * deployment tunes the cost in one place.
 *
 * No React here: this is plain state, and the hook lives in `useProgress.ts`.
 *
 * @module dsh-task-progress/client/store
 */

import type { ProgressState } from '../protocol.ts'
import { fetchState } from './api.ts'

/** How the store polls. Every knob has a default. */
export interface ProgressStoreOptions {
  /** Interval while something is running, milliseconds. */
  readonly intervalMs?: number
  /** Interval while everything is idle (and while the tab is hidden). */
  readonly idleIntervalMs?: number
  /** State reader; injectable so the store is testable without a network. */
  readonly read?: (signal: AbortSignal) => Promise<ProgressState | null>
}

/** The store's public surface. */
export interface ProgressStore {
  /** Begin polling; the returned function stops it and aborts any in-flight read. */
  start(): () => void
  /** Subscribe to snapshot changes; `getSnapshot` is stable between changes. */
  subscribe(listener: () => void): () => void
  /** The latest document, or null before the first successful poll. */
  getSnapshot(): ProgressState | null
  /** Poll now, without waiting for the next interval. */
  refresh(): void
}

/** Polling defaults, chosen to be invisible on a local endpoint. */
const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_IDLE_INTERVAL_MS = 8000

/**
 * Create a progress store.
 * @param options - polling knobs and an injectable reader.
 * @returns the store; nothing happens until `start()`.
 */
export function createProgressStore(options: ProgressStoreOptions = {}): ProgressStore {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS
  const read = options.read ?? fetchState

  let snapshot: ProgressState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let active = false
  const listeners = new Set<() => void>()

  const announce = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A broken subscriber must not stop the others or the loop.
      }
    }
  }

  /** Idle unless something is running and the page is actually being looked at. */
  const delay = (): number => {
    const running = snapshot?.tasks.some(task => task.state === 'running') ?? false
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (!running || hidden) return idleIntervalMs
    return snapshot?.pollMs ?? intervalMs
  }

  const schedule = (): void => {
    if (!active) return
    timer = setTimeout(() => { void tick() }, delay())
  }

  const tick = async (): Promise<void> => {
    if (!active) return
    timer = null
    controller = new AbortController()
    const next = await read(controller.signal)
    controller = null
    if (!active) return
    // A failed read keeps the last good document: a transient miss must not
    // blank a panel the user is watching.
    if (next !== null) {
      snapshot = next
      announce()
    }
    schedule()
  }

  return {
    start: () => {
      if (active) return () => {}
      active = true
      void tick()
      return () => {
        active = false
        if (timer !== null) clearTimeout(timer)
        timer = null
        controller?.abort()
        controller = null
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    refresh: () => {
      if (!active) return
      if (timer !== null) clearTimeout(timer)
      void tick()
    },
  }
}

/** The page's single store: one poll loop however many surfaces are mounted. */
export const progressStore: ProgressStore = createProgressStore()
