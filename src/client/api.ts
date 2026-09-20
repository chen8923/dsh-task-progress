/**
 * The one request this plugin makes: read the Host half's state document.
 *
 * Same-origin and cookie-authenticated, exactly like the shell's own plugin
 * endpoints — the Host half fences the route with the composition's connection
 * trust, so this call carries the page's session and nothing more.
 *
 * @module dsh-task-progress/client/api
 */

import { STATE_ROUTE, parseState, type ProgressState } from '../protocol.ts'

/**
 * Read the current state.
 * @param signal - caller lifetime; aborting it cancels the request.
 * @returns the parsed state, or null when the read did not produce a usable
 *   document (offline, rejected, mid-restart). Callers keep their last value.
 */
export async function fetchState(signal: AbortSignal): Promise<ProgressState | null> {
  try {
    const response = await fetch(STATE_ROUTE, {
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
