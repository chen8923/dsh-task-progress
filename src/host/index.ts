/**
 * Host half of `dsh-task-progress`.
 *
 * Five seams, each with exactly one job:
 *
 * 1. {@link registerProgressSettings} registers the settings namespace whose
 *    knobs the browser's configuration card edits, with this plugin row's own
 *    `config` as the composition base layer.
 * 2. {@link registerProgressEnv} hands every session shell call a progress
 *    directory (`DSH_PROGRESS_DIR`) — the only thing a producer has to know.
 * 3. {@link createTaskStore} folds whatever lands in those directories.
 * 4. {@link registerStateRoute} serves the folded state to the Web UI behind the
 *    composition's authentication fence.
 * 5. {@link registerProgressReminder} tells the *model* about a background job
 *    that has run past the threshold with nothing reported, at the step where it
 *    can still act on that. It reads registry **snapshots** (`list()`), which DSH
 *    documents as non-consuming.
 *
 * The plugin never reads a background job's **output**: `ctx.jobs.read()`
 * consumes a single-consumer cursor that belongs to the model's `job_output`
 * tool. Observing lifecycle snapshots is a different thing from reading output,
 * and it is what makes this plugin able to say something without editing the
 * user's `AGENTS.md`.
 *
 * @module dsh-task-progress/host
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { STATE_ROUTE } from '../protocol.ts'
import { readConfig, type TaskProgressConfig } from './config.ts'
import {
  DEFAULT_REMIND_AFTER_MS, registerProgressReminder,
  type JobsLike, type PreStepDecisionLike, type PreStepPayload,
} from './reminder.ts'
import { registerStateRoute, type ConnectionLike, type WebServerLike } from './routes.ts'
import { registerProgressSettings, type SettingsProviderLike } from './settings.ts'
import { registerProgressEnv, type ShellEnvLike } from './shell-env.ts'
import { createTaskStore, type SessionJobSource, type TaskStore } from './store.ts'
import { registerProgressPrompt, type SystemPromptLike } from './system-prompt.ts'

/**
 * The slice of the agent registry the settle needs.
 *
 * One method: the live agent that owns a session, which is the key the job
 * registry is written in. `jobs.list(caller)` answers for one owner, and a
 * progress directory names a session, so this is the bridge between the two.
 */
export interface AgentsLike {
  /** The live agent for a session id, or undefined when that session is gone. */
  get(sessionId: string): unknown
}

export { CONFIG_DEFAULTS, readConfig, type TaskProgressConfig } from './config.ts'
export {
  SETTINGS_NAMESPACE, progressSchema, registerProgressSettings, resolveProgressSettings,
  type ProgressSettings, type SchemaLike, type SchemaNodeLike, type SettingsProviderLike, type SettingsScopeLike,
} from './settings.ts'
export { createTaskStore, type SessionJobSource, type StoreStats, type TaskStore } from './store.ts'
export { PROGRESS_CLI_KEY, PROGRESS_DIR_KEY, registerProgressEnv, type ShellEnvLike } from './shell-env.ts'
export {
  PROMPT_ORDER_NAME, PROMPT_SECTION_NAME, progressPromptText, registerProgressPrompt, type SystemPromptLike,
} from './system-prompt.ts'
export {
  DEFAULT_REMIND_AFTER_MS, createReminderMessage, dueForReminder, registerProgressReminder, reminderText,
  type AgentLoopLike, type JobsLike, type PreStepDecisionLike, type PreStepPayload, type ReportedSource,
} from './reminder.ts'
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
      readonly jobs: JobsLike
      readonly agents: AgentsLike
    }) => void,
  ): void
  /**
   * Cordis event registration. The agent loop dispatches its waterfalls on this
   * bus, so a host composition's plugin sees every agent's steps.
   */
  on(
    event: string,
    listener: (payload: PreStepPayload, next: () => Promise<PreStepDecisionLike>) => unknown,
  ): () => void
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
  const config = readConfig(rawConfig)
  // The live configuration: settings changes replace it, and the reminder below
  // reads through it so turning the reminder off takes effect on the next step
  // rather than at the next restart.
  let liveConfig = config
  const store: TaskStore = createTaskStore(config)
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
      liveConfig = next
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

  // The job registry is optional too. Where it exists, a background job that has
  // been silent past `remindAfterMs` earns one notice in the model's next step —
  // the convention stated where the decision is, rather than where the prompt
  // happens to mention it. Where it does not exist, nothing is registered and
  // the plugin is exactly what it was before: files in, panels out.
  ctx.inject(['jobs'], (withJobs) => {
    withJobs.effect(
      () => registerProgressReminder(withJobs, withJobs.jobs, store, () => liveConfig.remindAfterMs),
      'task-progress: unreported-job reminder',
    )
  })

  // The same registry answers the question a file cannot: what happened to the
  // process writing a task that still says `running`. Both services are needed —
  // the registry is keyed by the agent that owns a job, and the store holds only
  // a session id — so a composition with one and not the other keeps the
  // pre-settle behaviour rather than a half-wired one: the row reports what the
  // file says, for as long as the file says it.
  ctx.inject(['jobs', 'agents'], (withJobs) => {
    const source: SessionJobSource = {
      jobsFor: (sessionId: string) => {
        const agent = withJobs.agents.get(sessionId)
        return agent === undefined ? undefined : withJobs.jobs.list(agent)
      },
    }
    withJobs.effect(() => {
      store.setJobSource(source)
      return () => { store.setJobSource(null) }
    }, 'task-progress: job settle source')
  })
}
