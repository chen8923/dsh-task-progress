/**
 * Host half of `dsh-task-progress`.
 *
 * Four seams, each with exactly one job:
 *
 * 1. {@link registerProgressSettings} registers the settings namespace whose
 *    knobs the browser's configuration card edits, with this plugin row's own
 *    `config` as the composition base layer.
 * 2. {@link registerProgressEnv} hands every session shell call a progress
 *    directory (`DSH_PROGRESS_DIR`) — the only thing a producer has to know.
 * 3. {@link createTaskStore} folds whatever lands in those directories.
 * 4. {@link registerStateRoute} serves the folded state to the Web UI behind the
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
import { registerProgressSettings, type SettingsProviderLike } from './settings.ts'
import { registerProgressEnv, type ShellEnvLike } from './shell-env.ts'
import { createTaskStore, type TaskStore } from './store.ts'
import { registerProgressPrompt, type SystemPromptLike } from './system-prompt.ts'

export { CONFIG_DEFAULTS, readConfig, type TaskProgressConfig } from './config.ts'
export {
  SETTINGS_NAMESPACE, progressSchema, registerProgressSettings, resolveProgressSettings,
  type ProgressSettings, type SchemaLike, type SchemaNodeLike, type SettingsProviderLike, type SettingsScopeLike,
} from './settings.ts'
export { createTaskStore, type StoreStats, type TaskStore } from './store.ts'
export { PROGRESS_CLI_KEY, PROGRESS_DIR_KEY, registerProgressEnv, type ShellEnvLike } from './shell-env.ts'
export {
  PROMPT_ORDER_NAME, PROMPT_SECTION_NAME, progressPromptText, registerProgressPrompt, type SystemPromptLike,
} from './system-prompt.ts'
export { registerStateRoute, stateHandler, type ConnectionLike, type WebServerLike } from './routes.ts'

/** Cordis function-plugin name. */
export const name = 'task-progress'

/**
 * The routes, the trust fence, and the environment registry this plugin needs.
 *
 * `settings` and `systemPrompt` are deliberately absent: both are optional in a
 * composition, so they are picked up through `ctx.inject` below. Requiring them
 * here would take the whole plugin down — no route, no environment, no panels —
 * in a deployment that simply has no settings document, or boots without the
 * prompt assembly this plugin contributes a section to.
 */
export const inject = ['webServer', 'connection', 'shellEnv'] as const

/** The slice of the host context this plugin uses. */
export interface TaskProgressHostContext {
  /** Cordis effect: runs the callback and disposes its return value with the fiber. */
  effect(callback: () => void | (() => void), label: string): void
  /**
   * Cordis inject: runs the callback once every named service exists, on a
   * child context that has them. Each optional seam below is reached this way;
   * the callback's declared scope names every service any caller asks for.
   */
  inject(
    deps: readonly string[],
    callback: (scope: TaskProgressHostContext & {
      readonly settings: SettingsProviderLike
      readonly systemPrompt: SystemPromptLike
    }) => void,
  ): void
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
 * @param rawConfig - this plugin row's configuration, of unknown shape; it becomes the settings base layer.
 */
export function apply(ctx: TaskProgressHostContext, rawConfig?: unknown): void {
  const store: TaskStore = createTaskStore(readConfig(rawConfig))
  // The composition's own working directory is always worth a look: it covers a
  // deployment whose sessions were created before this plugin was installed.
  store.addRoot(process.cwd())

  const cliPath = resolveCliPath()
  ctx.effect(() => registerProgressEnv(ctx.shellEnv, store, cliPath), 'task-progress: progress environment')
  ctx.effect(() => registerStateRoute(ctx.webServer, ctx.connection, store), `task-progress: GET ${STATE_ROUTE}`)
  ctx.effect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = (): void => {
      if (!active) return
      try {
        store.scan()
      } catch {
        // A scan must never take the host down; a broken workspace heals on the
        // next tick, and the store keeps serving its last good fold.
      }
      if (!active) return
      // Self-rescheduling rather than an interval, so a settings change to the
      // period takes effect on the next tick without re-arming anything.
      timer = setTimeout(tick, store.periodMs())
      // A scan loop must not be the reason a process stays alive.
      timer.unref?.()
    }
    tick()
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
    }
  }, 'task-progress: scan loop')

  // Settings are optional. A composition with no settings provider still gets
  // the progress environment, the route, and both panels; its plugin row's
  // `config` is simply the whole configuration, and nothing exposes a page.
  ctx.inject(['settings'], (withSettings) => {
    const scope = registerProgressSettings(withSettings.settings, rawConfig)
    const applySettings = (next: TaskProgressConfig): void => {
      store.reconfigure(next)
      store.setRoots(next.roots)
      store.scan()
    }
    applySettings(scope.get())
    withSettings.effect(() => scope.watch((next: TaskProgressConfig) => { applySettings(next) }), 'task-progress: settings changes')
  })

  // The convention the model needs, for exactly as long as this plugin is
  // loaded. Without it the panels would stay empty for everyone who has not
  // edited their own instructions to know about this plugin — which is not a
  // feature anyone can use out of the box.
  ctx.inject(['systemPrompt'], (withPrompt) => {
    withPrompt.effect(() => registerProgressPrompt(withPrompt.systemPrompt), 'task-progress: prompt section')
  })
}
