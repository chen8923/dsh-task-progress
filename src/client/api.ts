/**
 * The one request this plugin makes: read one session's state document.
 *
 * Same-origin and cookie-authenticated, exactly like the shell's own plugin
 * endpoints — the Host half fences the route with the composition's connection
 * trust, and the session travels as a query parameter so the answer is scoped to
 * what the caller is actually showing.
 *
 * @module dsh-task-progress/client/api
 */

import { parseState, stateUrl, type ProgressState } from '../protocol.ts'

/**
 * Read one session's current state.
 * @param sessionId - the session to read; the endpoint answers for exactly this one.
 * @param signal - caller lifetime; aborting it cancels the request.
 * @returns the parsed state, or null when the read did not produce a usable
 *   document (offline, rejected, mid-restart). Callers keep their last value.
 */
export async function fetchState(sessionId: string, signal: AbortSignal): Promise<ProgressState | null> {
  try {
    const response = await fetch(stateUrl(sessionId), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    })
    if (!response.ok) return null
    return parseState(await response.text())
  } catch {
    // An aborted poll is a normal part of teardown, and a failed one is
    // recovered by the next tick; neither is worth surfacing in the UI.
    return null
  }
}
