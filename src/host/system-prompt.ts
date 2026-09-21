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
 * Four things are load-bearing here, and each was learned from a session where
 * nothing appeared on the panel — or where too much did:
 *
 * - It is **imperative**. The first version said long tasks *can* report, which
 *   reads as a capability note and was skipped; the model needs an instruction
 *   attached to the decision, not a description of a feature.
 * - It names **background jobs**. That is where long work actually goes, and the
 *   first version never mentioned them.
 * - It names the **consequence**. "The user gets an empty panel" is what makes
 *   the instruction worth following rather than merely true.
 * - It leads with the **wrapper**, because the cheapest recipe is the one the
 *   model will take. A session that hand-wrote a producer spent six round trips
 *   on setup — probing the tool's output, writing a script, fixing redirection
 *   and encoding, syntax-checking — before any work started, and paid it again
 *   for the next kind of command. `run` is one tool call, and the raw protocol is
 *   still the escape hatch for what it cannot express.
 *
 * It stays short because every session pays for it, and it closes the one
 * failure the model would otherwise cause: reading the file back, which is the
 * human's view and not the model's.
 * @returns the prompt text.
 */
export function progressPromptText(): string {
  return 'For any command you expect to run longer than about 30 seconds — including a background job — report '
    + 'live progress by wrapping it: `node "$DSH_PROGRESS_CLI" run --task <id> -- <command>` (it announces the task, '
    + 'follows the output, reads a percentage, and writes the ending from the exit code; the id must appear in that '
    + 'command line). If that cannot express the task, append one JSON event per update to '
    + '`$DSH_PROGRESS_DIR/<task>.jsonl` (`{"v":1,"task":"build","state":"running","pct":40,"msg":"linking"}`; states '
    + 'running/done/failed/cancelled) or call `emit`/`done`/`fail`, naming the task after something recognisable in '
    + 'the command. A long command that reports nothing leaves the user staring at an empty progress panel. '
    + 'Never read the progress file back — it is the human\'s view.'
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
