/**
 * The ergonomic half of the contract: how a script learns where to write.
 *
 * `ctx.shellEnv` rebuilds the trusted `DSH_*` namespace for **every** model shell
 * call, and a contributor resolves its values per execution. That is exactly the
 * hook this plugin needs: the same script the model writes for `pwsh` or `bash`
 * can just use an environment variable, with no path arithmetic, no knowledge of
 * the session id, and no dependency on the plugin being installed anywhere near
 * the workspace.
 *
 * Recording the directory here (rather than discovering workspaces on a timer)
 * also keeps the Host half honest: it tracks the directories it was actually
 * told about, and nothing else.
 *
 * @module dsh-task-progress/host/shell-env
 */

import type { TaskStore } from './store.ts'

/** The directory a producer appends its `<task>.jsonl` files to. */
export const PROGRESS_DIR_KEY = 'DSH_PROGRESS_DIR'

/** Absolute path of the bundled `dsh-progress` helper, when it ships. */
export const PROGRESS_CLI_KEY = 'DSH_PROGRESS_CLI'

/** The slice of `ctx.shellEnv` this plugin uses. */
export interface ShellEnvLike {
  register(contributor: {
    readonly name: string
    readonly variables: Readonly<Record<string, { readonly description: string }>>
    resolve(execution: unknown): Record<string, string>
  }): () => void
}

/** The slice of one tool execution this plugin reads. */
interface ExecutionLike {
  readonly agent?: {
    readonly session?: {
      readonly header?: {
        readonly id?: unknown
        readonly cwd?: unknown
      }
    }
  }
}

/**
 * Read the reporting session's identity out of one execution.
 * @param execution - the tool execution the environment is being built for.
 * @returns the session id and workspace, or null when there is no session.
 */
function sessionOf(execution: unknown): { id: string; cwd: string } | null {
  const header = (execution as ExecutionLike | undefined)?.agent?.session?.header
  const id = header?.id
  if (typeof id !== 'string' || id.length === 0) return null
  const cwd = header?.cwd
  return { id, cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd() }
}

/**
 * Register the progress environment variables.
 *
 * A call with no session (a host-level shell call) contributes nothing rather
 * than a wrong path: the registry only injects the keys a resolver returns, so
 * the producer simply does not see the variable.
 *
 * @param shellEnv - the live shell environment registry.
 * @param store - the store that will read whatever is written.
 * @param cliPath - absolute path of the bundled helper CLI, or null.
 * @returns the disposer that unregisters the contribution.
 */
export function registerProgressEnv(
  shellEnv: ShellEnvLike,
  store: TaskStore,
  cliPath: string | null,
): () => void {
  return shellEnv.register({
    name: 'task-progress',
    variables: {
      [PROGRESS_DIR_KEY]: {
        description: 'Directory for long-task progress files: append <task>.jsonl lines to report progress.',
      },
      [PROGRESS_CLI_KEY]: {
        description: 'Absolute path of the dsh-progress helper CLI (run it with node).',
      },
    },
    resolve: (execution: unknown): Record<string, string> => {
      const session = sessionOf(execution)
      if (session === null) return {}
      const dir = store.remember(session.cwd, session.id)
      if (dir === null) return {}
      return cliPath === null
        ? { [PROGRESS_DIR_KEY]: dir }
        : { [PROGRESS_DIR_KEY]: dir, [PROGRESS_CLI_KEY]: cliPath }
    },
  })
}
