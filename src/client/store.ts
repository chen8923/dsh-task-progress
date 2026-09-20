/**
 * The browser half's state: one poll loop, one snapshot per session, any number
 * of readers.
 *
 * Polling rather than a push channel is a deliberate trade. The Host half has no
 * output event to ride (job output is a single-consumer cursor the model owns),
 * the data is a couple of kilobytes of JSON on localhost, and a poll loop is the
 * one design that cannot desynchronize: every reader sees the same last-wins
 * document, a missed tick costs one interval, and there is no reconnect logic to
 * get wrong. The interval comes from the Host half's own configuration, so a
 * deployment tunes the cost in one place.
 *
 * **Per session, not per page.** The endpoint answers for one session at a time,
 * so a snapshot is held per session and only sessions with a live reader are
 * polled at all. That is what lets the floating overlay (the session in view)
 * and a sidebar tab (its own session) coexist without either seeing the other's
 * data — and without the process ever asking for everything it knows.
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
  /** How long a session with no readers is kept before its snapshot is dropped. */
  readonly sessionTtlMs?: number
  /** State reader; injectable so the store is testable without a network. */
  readonly read?: (sessionId: string, signal: AbortSignal) => Promise<ProgressState | null>
}

/** The store's public surface. */
export interface ProgressStore {
  /** Begin polling; the returned function stops it and aborts any in-flight read. */
  start(): () => void
  /** Subscribe to one session's snapshot changes. */
  subscribe(sessionId: string, listener: () => void): () => void
  /** One session's latest document, or null before its first successful poll. */
  getSnapshot(sessionId: string): ProgressState | null
  /** Poll the live sessions now, without waiting for the next interval. */
  refresh(): void
}

/** Polling defaults, chosen to be invisible on a local endpoint. */
const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_IDLE_INTERVAL_MS = 8000

/** How long a readerless session's snapshot is kept, so re-mounting is instant. */
const DEFAULT_SESSION_TTL_MS = 60_000

/** One session's held state and its readers. */
interface SessionEntry {
  snapshot: ProgressState | null
  listeners: Set<() => void>
  /** Last time a reader touched it, for dropping sessions nothing is watching. */
  lastUsedAt: number
}

/**
 * Create a progress store.
 * @param options - polling knobs and an injectable reader.
 * @returns the store; nothing happens until `start()`.
 */
export function createProgressStore(options: ProgressStoreOptions = {}): ProgressStore {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const read = options.read ?? fetchState

  const sessions = new Map<string, SessionEntry>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let active = false

  const entryOf = (sessionId: string): SessionEntry => {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = { snapshot: null, listeners: new Set(), lastUsedAt: Date.now() }
      sessions.set(sessionId, entry)
    }
    return entry
  }

  /** Sessions somebody is currently reading. Only these are polled. */
  const liveSessions = (): string[] =>
    [...sessions].filter(([, entry]) => entry.listeners.size > 0).map(([sessionId]) => sessionId)

  const announce = (entry: SessionEntry): void => {
    for (const listener of [...entry.listeners]) {
      try {
        listener()
      } catch {
        // A broken subscriber must not stop the others or the loop.
      }
    }
  }

  /** Idle unless something is running and the page is actually being looked at. */
  const delay = (): number => {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (hidden) return idleIntervalMs
    for (const sessionId of liveSessions()) {
      const snapshot = sessions.get(sessionId)?.snapshot
      if (snapshot?.tasks.some(task => task.state === 'running') === true) {
        return snapshot.pollMs ?? intervalMs
      }
    }
    return idleIntervalMs
  }

  /** Drop snapshots nothing has read for a while, so a long page does not grow. */
  const forgetIdleSessions = (now: number): void => {
    for (const [sessionId, entry] of [...sessions]) {
      if (entry.listeners.size === 0 && now - entry.lastUsedAt > sessionTtlMs) sessions.delete(sessionId)
    }
  }

  const schedule = (): void => {
    if (!active) return
    timer = setTimeout(() => { void tick() }, delay())
  }

  const tick = async (): Promise<void> => {
    if (!active) return
    timer = null
    const targets = liveSessions()
    if (targets.length > 0) {
      controller = new AbortController()
      try {
        // One request per live session, in parallel: in practice this is one,
        // because one session is in view. A failed read keeps the last good
        // document — a transient miss must not blank a panel being watched.
        await Promise.all(targets.map(async (sessionId) => {
          const next = await read(sessionId, controller?.signal ?? new AbortController().signal)
          if (!active || next === null) return
          const entry = sessions.get(sessionId)
          if (entry === undefined) return
          entry.snapshot = next
          announce(entry)
        }))
      } finally {
        controller = null
      }
    }
    forgetIdleSessions(Date.now())
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
        sessions.clear()
      }
    },
    subscribe: (sessionId: string, listener: () => void) => {
      const entry = entryOf(sessionId)
      entry.listeners.add(listener)
      entry.lastUsedAt = Date.now()
      // A session that mounts while the loop is between ticks should not wait a
      // whole interval for its first answer.
      if (entry.snapshot === null && active && timer !== null) {
        clearTimeout(timer)
        void tick()
      }
      return () => {
        entry.listeners.delete(listener)
        entry.lastUsedAt = Date.now()
      }
    },
    getSnapshot: (sessionId: string) => sessions.get(sessionId)?.snapshot ?? null,
    refresh: () => {
      if (!active) return
      if (timer !== null) clearTimeout(timer)
      void tick()
    },
  }
}

/** The page's single store: one poll loop however many sessions are in view. */
export const progressStore: ProgressStore = createProgressStore()
