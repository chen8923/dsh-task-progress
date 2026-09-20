/**
 * The single HTTP route the browser half reads.
 *
 * `ctx.webServer` is the composition's route table and `ctx.connection` is its
 * authentication fence: `requestRejection(req)` is the same gate the shipped
 * `open-in-app` routes use, and it is what keeps an unauthenticated caller from
 * reading workspace task names off a local port. Nothing here accepts a path,
 * a query, or a body from the browser — the response is whatever the Host half
 * already folded into its own store, so there is no injection surface at all.
 *
 * @module dsh-task-progress/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { STATE_ROUTE } from '../protocol.ts'
import type { TaskStore } from './store.ts'

/** The slice of `ctx.webServer` this plugin uses. */
export interface WebServerLike {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The slice of `ctx.connection` this plugin uses. */
export interface ConnectionLike {
  /** The HTTP status to answer with, or undefined when the caller is trusted. */
  requestRejection(req: IncomingMessage): number | undefined
}

/**
 * Build the state handler.
 * @param connection - the composition's trust fence.
 * @param store - the store to serialize.
 * @returns the route handler.
 */
export function stateHandler(
  connection: ConnectionLike,
  store: TaskStore,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, HEAD')
      res.end()
      return
    }
    const body = JSON.stringify(store.snapshot())
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  }
}

/**
 * Register the state route.
 * @param webServer - the composition's route table.
 * @param connection - the composition's trust fence.
 * @param store - the store to serialize.
 * @returns the disposer that removes the route.
 */
export function registerStateRoute(
  webServer: WebServerLike,
  connection: ConnectionLike,
  store: TaskStore,
): () => void {
  return webServer.register({ kind: 'exact', path: STATE_ROUTE, handler: stateHandler(connection, store) })
}
