/**
 * The prompt section that makes this plugin work out of the box.
 *
 * Every shipped tool teaches its own convention through `ctx.systemPrompt`
 * (`tool:pwsh`, `tool:jobs`, …). Without one, installing this plugin would still
 * leave the panel empty forever: the *script* has to report progress, and the
 * only thing that can tell the model to arrange that is the prompt. A user who
 * has to edit their `AGENTS.md` before anything appears has not installed a
 * feature, they have installed a chore.
 *
 * The section sits at the background-jobs tool's slot, because that is where the
 * model already reads how long-running work is tracked, and it stays short: this
 * is paid for in every session's context.
 *
 * @module dsh-task-progress/host/system-prompt
 */

/** Section name, as it appears in a prompt assembly. */
export const PROMPT_SECTION_NAME = 'task-progress'

/** The order slot this section shares with the background-jobs tool guidance. */
export const PROMPT_ORDER_NAME = 'TOOL_JOBS'

/** Fallback order, used only if a composition does not publish that slot name. */
const PROMPT_ORDER_FALLBACK = 1600

/**
 * The convention, in as few words as it can be stated.
 *
 * It names both paths the environment offers (append a line yourself, or call
 * the bundled CLI), because which one is cheaper depends on the language the
 * script is written in, and it closes the one failure the model would otherwise
 * cause: reading the file back, which is the human's view and not the model's.
 * @returns the prompt text.
 */
export function progressPromptText(): string {
  return 'Long tasks can report live progress to the user: for a command you expect to run longer than about 30 seconds, '
    + 'have the script append one JSON event per update to `$DSH_PROGRESS_DIR/<task>.jsonl` '
    + '(`{"v":1,"task":"build","state":"running","pct":40,"msg":"linking"}`; `state` is running/done/failed/cancelled, '
    + '`done`/`total`/`unit` are optional counters), or run '
    + '`node "$DSH_PROGRESS_CLI" emit --task build --pct 40 --msg "linking"` (also `done`, `fail`, `list`). '
    + 'Both variables are set inside every shell call. Do not read the progress file back — it is the human\'s view.'
}

/** The slice of `ctx.systemPrompt` this plugin uses. */
export interface SystemPromptLike {
  /** Register one prompt section; the disposer removes it. */
  section(section: { readonly name: string, readonly order: number, readonly text: string }): () => void
  /** Central order slot by name; undefined when a composition does not publish it. */
  getSectionOrder(name: string): number | undefined
}

/**
 * Register the convention.
 * @param systemPrompt - the live system-prompt service.
 * @returns the disposer that removes the section.
 */
export function registerProgressPrompt(systemPrompt: SystemPromptLike): () => void {
  return systemPrompt.section({
    name: PROMPT_SECTION_NAME,
    order: systemPrompt.getSectionOrder(PROMPT_ORDER_NAME) ?? PROMPT_ORDER_FALLBACK,
    text: progressPromptText(),
  })
}
