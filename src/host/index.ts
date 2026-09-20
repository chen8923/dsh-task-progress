/**
 * Host half of `dsh-task-progress`.
 *
 * Three seams, each with exactly one job:
 *
 * 1. {@link registerProgressEnv} hands every session shell call a progress
 *    directory (`DSH_PROGRESS_DIR`) — the only thing a producer has to know.
 * 2. {@link createTaskStore} folds whatever lands in those directories.
 * 3. {@link registerStateRoute} serves the folded state to the Web UI behind the
 *    composition's authentication fence.
 *
 * The plugin never touches the background-job registry, and in particular never
 * reads a job's output: that cursor is single-consumer and belongs to the
 * model's `job_output` tool. Progress here is something the *script* chooses to
 * report, which is what makes this plugin safe to install next to anything else.
 *
 * @module dsh-task-progress/host
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { STATE_ROUTE } from '../protocol.ts'
import { readConfig, type TaskProgressConfig } from './config.ts'
import { registerStateRoute, type ConnectionLike, type WebServerLike } from './routes.ts'
import { registerProgressEnv, type ShellEnvLike } from './shell-env.ts'
import { createTaskStore, type TaskStore } from './store.ts'

export { CONFIG_DEFAULTS, readConfig, type TaskProgressConfig } from './config.ts'
export { createTaskStore, type StoreStats, type TaskStore } from './store.ts'
export { PROGRESS_CLI_KEY, PROGRESS_DIR_KEY, registerProgressEnv, type ShellEnvLike } from './shell-env.ts'
export { registerStateRoute, stateHandler, type ConnectionLike, type WebServerLike } from './routes.ts'

/** Cordis function-plugin name. */
export const name = 'task-progress'

/** The routes, the trust fence, and the environment registry this plugin needs. */
export const inject = ['webServer', 'connection', 'shellEnv'] as const

/** The slice of the host context this plugin uses. */
export interface TaskProgressHostContext {
  /** Cordis effect: runs the callback and disposes its return value with the fiber. */
  effect(callback: () => void | (() => void), label: string): void
  readonly webServer: WebServerLike
  readonly connection: ConnectionLike
  readonly shellEnv: ShellEnvLike
}

/**
 * Locate the bundled helper CLI next to the built plugin.
 *
 * `lib/index.js` is what runs, so `../bin/` is the package's own `bin/`
 * directory. A source-tree run (tests) resolves to nothing, which is correct:
 * there is no helper to advertise there.
 * @returns the absolute path, or null when the CLI does not ship.
 */
function resolveCliPath(): string | null {
  try {
    const path = fileURLToPath(new URL('../bin/dsh-progress.mjs', import.meta.url))
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

/**
 * Load the plugin.
 * @param ctx - the host context carrying the route table, trust fence, and environment registry.
 * @param rawConfig - this plugin row's configuration, of unknown shape.
 */
export function apply(ctx: TaskProgressHostContext, rawConfig?: unknown): void {
  const config: TaskProgressConfig = readConfig(rawConfig)
  const store: TaskStore = createTaskStore(config)
  // The composition's own working directory is always worth a look: it covers a
  // deployment whose sessions were created before this plugin was installed.
  store.addRoot(process.cwd())
  for (const root of config.roots) store.addRoot(root)

  const cliPath = resolveCliPath()
  ctx.effect(() => registerProgressEnv(ctx.shellEnv, store, cliPath), 'task-progress: progress environment')
  ctx.effect(() => registerStateRoute(ctx.webServer, ctx.connection, store), `task-progress: GET ${STATE_ROUTE}`)
  ctx.effect(() => {
    const tick = (): void => {
      try {
        store.scan()
      } catch {
        // A scan must never take the host down; a broken workspace heals on the
        // next tick, and the store keeps serving its last good fold.
      }
    }
    tick()
    const timer = setInterval(tick, config.scanMs)
    // A scan loop must not be the reason a process stays alive.
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'task-progress: scan loop')
}
