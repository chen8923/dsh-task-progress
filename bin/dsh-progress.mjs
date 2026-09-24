#!/usr/bin/env node
/**
 * dsh-progress — report long-task progress to DSH.
 *
 * The whole producer contract in one command: append one JSON line to
 * `$DSH_PROGRESS_DIR/<task>.jsonl`. The CLI is a convenience, not a
 * requirement — `Add-Content`/`>>` with a hand-written line does exactly the
 * same thing, which is why nothing here needs installing and nothing talks to
 * the DSH process.
 *
 * `run` is the cheap path and the one worth reaching for first: it wraps a
 * command, follows its output, reports what it can read, and writes the ending
 * from the exit code — no script to synthesise, no encoding or redirection to
 * get wrong, and no terminal line that a kill can skip. The rest of the commands
 * are for a producer that wants to speak for itself.
 *
 * Zero dependencies, Node 20+, ESM.
 *
 *   dsh-progress run --task build -- <command> [args...]
 *   dsh-progress emit --task build --pct 10 --msg "linking" [--done 3 --total 9 --unit files]
 *   dsh-progress done --task build --msg "shipped"
 *   dsh-progress fail --task build --msg "link error"
 *   dsh-progress path [--task build]
 *   dsh-progress list
 *   dsh-progress watch [--task build] [--once]
 *   dsh-progress clear --task build
 */

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** Task id: also the file's base name, so it must be a safe path segment. */
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/** Lifecycle states a producer may report. */
const STATES = new Set(['running', 'done', 'failed', 'cancelled'])

/** Protocol version written into every line. */
const VERSION = 1

/** Suffix of a progress file. */
const SUFFIX = '.jsonl'

export const HELP = `dsh-progress — report long-task progress to DSH

Usage:
  dsh-progress run   --task <id> [--every MS] [--pattern REGEX] -- <command> [args...]
  dsh-progress emit  --task <id> [--pct N] [--msg TEXT] [--done N --total N --unit NAME] [--state STATE] [--json]
  dsh-progress done  --task <id> [--msg TEXT]
  dsh-progress fail  --task <id> [--msg TEXT]
  dsh-progress cancel --task <id> [--msg TEXT]
  dsh-progress path  [--task <id>]
  dsh-progress list  [--task <id>]
  dsh-progress watch [--task <id>] [--interval MS] [--once]
  dsh-progress clear --task <id>
  dsh-progress --help | --version

Start here — dsh-progress run --task <id> -- <command>
  Wraps any command and does the reporting for you: it announces the task, follows
  the command's output, reports a percentage when it can read one (a "12%" or a
  "12/88" anywhere in a line), relays the output to its own stdout, and writes the
  ending itself from the exit code — non-zero becomes failed. There is no script to
  write, no redirection to get right, no encoding to fix, and the task id is in the
  command line by construction, which is what lets the panel tie the two together.

    node "$env:DSH_PROGRESS_CLI" run --task sync-catalog -- python sync_catalog.py --task sync-catalog
    node "$env:DSH_PROGRESS_CLI" run --task crack --pattern "Progress: (\\d+)%" -- hashcat -m 13000 hashes.txt

  --every MS     how often the output is re-read (default 1000)
  --pattern RE   read the percentage from this regex instead (first capture group).
                 Matched against at most 1000 characters of a line, and a nested
                 quantifier such as (a+)+ is refused rather than run: it can
                 backtrack exponentially and hang the wrapped command.
  --quiet        do not relay the command's output to stdout
  --cwd DIR      working directory for the command

  Its output goes through a file, not a pipe: a sandboxed shell cannot create the
  pipes a piped child needs, and that is measured, not assumed. Relay a wrapper's
  exit code the way you would any other command's.

Where the file goes:
  $DSH_PROGRESS_DIR/<task>.jsonl   (set automatically inside DSH model shell calls)
  --dir <path>                     override the directory

  --file <path> writes exactly that path and skips the task-id rule entirely, so
  it can append to any path you can write (creating parent directories), and
  "clear --file" removes one. Pass it only from a script whose arguments you
  control; prefer --task, which cannot leave the progress directory. "run" is the
  exception: it needs the id for its relay file and for the events it writes, so it
  requires --task whether or not --file is given, and its own --state wins over one
  you pass, because the wrapper writes the ending from the exit code.

Watching a run instead of asking again:
  dsh-progress watch [--task <id>] [--interval MS] [--once]
  It follows the directory and prints a task the first time it sees one, then only
  when that task's reading actually changes — so a long run scrolls at the pace of
  the work, not at the pace of the clock. It reads files rather than a process,
  which is what lets it watch work another shell started. Nothing is written and
  nothing needs settling: Ctrl+C is the whole teardown.

  --interval MS  how often the directory is re-read (default 1000, floor 200)
  --once         one pass and exit. It prints exactly what "list" prints, with the
                 clock left off, so a script can read it; --task narrows either one
                 to a single task, and "list --task" is the same read without the
                 follow.
  A directory holding more than 64 task files is read up to that many and says so on
  stderr — the same working-set bound the Host half applies to its own scan.

Examples:
  node "$env:DSH_PROGRESS_CLI" emit --task build --pct 10 --msg "linking"
  node "$env:DSH_PROGRESS_CLI" done --task build --msg "shipped"

Emitting an ending around a long command:

  $id = 'sync-catalog'; $cli = $env:DSH_PROGRESS_CLI; $settled = $false
  try {
    & python sync_catalog.py --task $id | ForEach-Object { node $cli emit --task $id --msg $_ }
    # A native command's non-zero exit does NOT throw in PowerShell: check it, or
    # a failed run gets reported as done.
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
    node $cli done --task $id --msg "shipped"; $settled = $true
  } catch {
    node $cli fail --task $id --msg $_.Exception.Message; $settled = $true
  } finally {
    # Covers exceptions and Ctrl+C. It does NOT cover a kill: job_kill terminates
    # the process tree, and on Windows that runs no user code at all, so this line
    # never happens. The panel settles such a task from DSH's job record instead
    # ("When the writer dies" in docs/PROTOCOL.md) — which is why the task id has
    # to appear in the command line you launched, and why one task id should have
    # exactly one writer.
    if (-not $settled) { node $cli cancel --task $id --msg "stopped" }
  }

Emitted line (append-only; last value of each field wins):
  {"v":1,"task":"build","state":"running","pct":10,"msg":"linking","at":1730000000000}
`

/** Print a usage error and exit. */
function fail(message) {
  process.stderr.write(`dsh-progress: ${message}\n`)
  process.exit(2)
}

/** The progress directory, from the flag or the environment. */
function directoryOf(options) {
  const dir = options.dir ?? process.env.DSH_PROGRESS_DIR
  if (typeof dir !== 'string' || dir.length === 0) {
    fail('no progress directory: pass --dir <path>, or run inside a DSH shell call where DSH_PROGRESS_DIR is set')
  }
  return dir
}

/** The file one task writes to, validating the id it is named after. */
function fileOf(options) {
  const task = options.task
  if (task === undefined) fail('--task <id> is required')
  if (!TASK_RE.test(task)) fail(`invalid task id ${JSON.stringify(task)}: use 1-40 of A-Z a-z 0-9 . _ -`)
  return join(directoryOf(options), `${task}${SUFFIX}`)
}

/** Resolve the target file, honouring an explicit --file. */
function targetOf(options) {
  return typeof options.file === 'string' && options.file.length > 0 ? options.file : fileOf(options)
}

/** A bounded number from a flag, or undefined. */
function numberFlag(raw, name, min, max) {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) fail(`--${name} must be a number`)
  return Math.min(max, Math.max(min, value))
}

/** Append one event line, creating the directory when needed. */
function emit(options, extra = {}) {
  const path = targetOf(options)
  const task = options.task
  const event = { v: VERSION }
  if (typeof task === 'string' && task.length > 0) event.task = task
  const state = extra.state ?? options.state
  if (state !== undefined) {
    if (!STATES.has(state)) fail(`--state must be one of ${[...STATES].join(', ')}`)
    event.state = state
  }
  const pct = extra.pct ?? numberFlag(options.pct, 'pct', 0, 100)
  if (pct !== undefined) event.pct = pct
  const msg = extra.msg ?? options.msg
  if (typeof msg === 'string' && msg.length > 0) event.msg = msg
  const done = numberFlag(options.done, 'done', 0, Number.MAX_SAFE_INTEGER)
  if (done !== undefined) event.done = done
  const total = numberFlag(options.total, 'total', 0, Number.MAX_SAFE_INTEGER)
  if (total !== undefined) event.total = total
  if (typeof options.unit === 'string' && options.unit.length > 0) event.unit = options.unit
  event.at = Date.now()

  const line = `${JSON.stringify(event)}\n`
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line, 'utf8')
  } catch (error) {
    fail(`cannot append to ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (options.json === true) process.stdout.write(line)
  return path
}

/* ------------------------------------------------------------------ *
 * run: the wrapper
 *
 * Everything below exists because of what a long task used to cost. The
 * documented way to report progress is for the *script* to do it, which means
 * writing a little program per task kind: probe the tool's output, parse it,
 * discover that stderr needs merging, get the encoding right, add a BOM, syntax
 * check, then launch. Six round trips before the work starts, paid again for
 * every new kind of command — and the last line of that program is the one a
 * kill skips.
 *
 * So the wrapper takes the whole job: it announces the task, follows the child,
 * reports what it can read, and writes the ending from the exit code. The child's
 * output is relayed through a **file**, not a pipe, because a sandboxed shell
 * cannot create the pipes a piped child needs (`spawn` + `stdio: 'pipe'` →
 * EPERM, measured on this project's own machine). The relay file is an
 * implementation detail and does not outlive the run.
 * ------------------------------------------------------------------ */

/** Longest message the wrapper forwards from a command's own output. */
const RUN_MESSAGE_CHARS = 160

/** How often the relay file is re-read, and how rarely the clock must move. */
const RUN_EVERY_MS = 1000
const RUN_HEARTBEAT_MS = 30_000

/** A percentage the command printed, e.g. `12%`. */
const RUN_PCT_RE = /(\d+(?:\.\d+)?)\s*%/

/** A completed/total pair the command printed, e.g. `12/88`. */
const RUN_PAIR_RE = /(\d+)\s*\/\s*(\d+)/

/**
 * Longest line a custom `--pattern` is ever applied to.
 *
 * A pattern that backtracks badly is only dangerous on a long input, so the
 * input is what gets bounded: whatever the child prints, the regex sees at most
 * this much of a line.
 */
const PATTERN_LINE_LIMIT = 1000

/** Longest `--pattern` source accepted. */
const PATTERN_SOURCE_LIMIT = 200

/**
 * Why a `--pattern` is refused, or null when it is usable.
 *
 * `run` applies the pattern to a child's output, and `--pattern` rides a command
 * line the model writes — so a catastrophic-backtracking regex is reachable by
 * accident as easily as by intent. `(a+)+$` is exponential in the input length:
 * measured here, 20 characters takes 10 ms and 40 never finishes. That wedges
 * the wrapped job's own process (it cannot reach the DSH host), which is still a
 * hang the user gets no progress out of.
 *
 * The check is a scanner rather than a pattern over the pattern: it walks the
 * source, keeps one frame per open group, and refuses a quantifier applied to a
 * group that already repeats. That is the shape that is provably exponential;
 * the input cap above bounds the rest.
 * @param source - the `--pattern` string as typed.
 * @returns a message naming the problem, or null.
 */
export function patternRejection(source) {
  if (typeof source !== 'string' || source.length === 0) return 'it is empty'
  if (source.length > PATTERN_SOURCE_LIMIT) return `it is longer than ${PATTERN_SOURCE_LIMIT} characters`
  /** One frame per open group: whether that group already repeats. */
  const open = []
  /** What the previous atom was, so a quantifier knows what it applies to. */
  let previous = 'start'
  let escaped = false
  let inClass = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) { escaped = false; previous = 'atom'; continue }
    if (char === '\\') { escaped = true; continue }
    if (inClass) { if (char === ']') inClass = false; continue }
    if (char === '[') { inClass = true; previous = 'atom'; continue }
    if (char === '(') { open.push({ repeats: false }); previous = 'start'; continue }
    if (char === ')') {
      const frame = open.pop()
      previous = frame?.repeats === true ? 'repeatingGroup' : 'atom'
      continue
    }
    const braced = char === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(index))
    if (char === '*' || char === '+' || char === '?' || braced) {
      if (previous === 'repeatingGroup') return 'it repeats a group that already repeats (e.g. `(a+)+`), which can backtrack exponentially'
      if (previous === 'quantifier') return 'it applies two quantifiers to one atom'
      if (open.length > 0) open[open.length - 1].repeats = true
      previous = 'quantifier'
      if (braced) index = source.indexOf('}', index)
      continue
    }
    previous = 'atom'
  }
  return null
}

/** What one look at the command's output says about progress. */
const NO_SAMPLE = { pct: null, done: null, total: null, msg: '' }

/**
 * The regex a `--pattern` names, or why it will not be used.
 *
 * Separate from the command that consumes it, and exported, because the refusal
 * is the half worth testing: `run` exits on a bad pattern, and a test cannot call
 * `process.exit`. Splitting it lets the guard be exercised through the same path
 * the CLI takes, rather than only as a unit.
 * @param source - the `--pattern` value, or undefined when none was given.
 * @returns the compiled pattern, or the reason it was refused.
 */
export function resolvePattern(source) {
  if (typeof source !== 'string' || source.length === 0) return { pattern: null, error: null }
  const rejection = patternRejection(source)
  if (rejection !== null) return { pattern: null, error: rejection }
  try {
    return { pattern: new RegExp(source), error: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { pattern: null, error: `it is not a valid regular expression (${reason})` }
  }
}

/** A bounded non-negative integer, or null. */
const count = (value) => Number.isFinite(value) && value >= 0 ? Math.round(value) : null

/**
 * Read progress out of a chunk of a command's output.
 *
 * Deliberately generic: a tool that prints `42%` or `1234/8888` somewhere in a
 * line is understood without being told anything, which is what removes the
 * probe step. A tool that prints neither still gets its last line as the message,
 * and `--pattern` is there for the rest.
 *
 * A percentage the command reported is passed through rather than recomputed from
 * the pair: the reader already derives one from `done`/`total`, and two places
 * computing a percentage is one place too many.
 * @param chunk - the text read since the last look, or the whole output.
 * @param pattern - optional regex whose first capture group is the percentage.
 * @returns what this chunk says; every field null when it says nothing.
 */
export function parseProgress(chunk, pattern = null) {
  if (typeof chunk !== 'string' || chunk.length === 0) return { ...NO_SAMPLE }
  const lines = chunk.split('\n').map(line => line.replace(/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim())
  let msg = ''
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].length > 0) { msg = lines[index].slice(0, RUN_MESSAGE_CHARS); break }
  }
  const search = pattern instanceof RegExp ? pattern : RUN_PCT_RE
  let pct = null
  for (let index = lines.length - 1; index >= 0 && pct === null; index -= 1) {
    // Bounded before it is matched: see PATTERN_LINE_LIMIT.
    const subject = lines[index].length > PATTERN_LINE_LIMIT ? lines[index].slice(0, PATTERN_LINE_LIMIT) : lines[index]
    const match = search.exec(subject)
    const parsed = Number(match?.[1])
    // Passed through as printed: a tool that says 13.89% said something more
    // precise than 14, and the panel rounds for display anyway.
    if (Number.isFinite(parsed)) pct = Math.min(100, Math.max(0, parsed))
  }
  // The pair is read from the same pass, and only when the percentage is not
  // already known: a line that says both has already said the more specific one.
  let done = null
  let total = null
  if (pct === null && !(pattern instanceof RegExp)) {
    for (let index = lines.length - 1; index >= 0 && done === null; index -= 1) {
      const match = RUN_PAIR_RE.exec(lines[index])
      if (match !== null) { done = count(Number(match[1])); total = count(Number(match[2])) }
    }
  }
  return { pct, done, total, msg }
}

/**
 * Whether a fresh reading is worth a line in the progress file.
 *
 * A change is worth one; so is the passage of time, because a command that prints
 * the same line for ten minutes is still running, and a row that never moves
 * would be reported as "no update for 10m" about work that is plainly alive.
 * @param previous - the reading already reported.
 * @param next - the reading just taken.
 * @param sinceLastMs - milliseconds since the last line was written.
 * @param heartbeatMs - the longest silence allowed.
 * @returns true when this reading should be written.
 */
export function changeIsWorthReporting(previous, next, sinceLastMs, heartbeatMs) {
  if (next.pct !== null && next.pct !== previous.pct) return true
  if (next.msg.length > 0 && next.msg !== previous.msg) return true
  return sinceLastMs >= heartbeatMs
}

/**
 * Follow one child process and report it.
 *
 * @param options.task - task id, used for the opening line.
 * @param options.command - argv; `command[0]` is the program.
 * @param options.dir - the progress directory, which also holds the relay file.
 * @param options.cwd - working directory for the child, or undefined for ours.
 * @param options.everyMs - how often the relay is re-read.
 * @param options.heartbeatMs - longest silence before the clock is moved anyway.
 * @param options.pattern - optional percentage regex, replacing the default.
 * @param options.emit - where events go; injectable so this is testable.
 * @param options.out - where the relayed output goes; injectable for the same reason.
 * @returns the child's exit code.
 */
export async function runWrapped(options) {
  const everyMs = Number.isFinite(options.everyMs) ? Math.max(20, options.everyMs) : RUN_EVERY_MS
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? Math.max(0, options.heartbeatMs) : RUN_HEARTBEAT_MS
  const emit = options.emit
  const out = typeof options.out === 'function' ? options.out : (text) => { process.stdout.write(text) }
  const [program, ...args] = options.command
  const relay = join(options.dir, `${options.task}.relay`)

  mkdirSync(options.dir, { recursive: true })
  // `'w'` creates the relay fresh, so a run that was killed leaves bytes that
  // cannot be read by the next one. The unlink is for the other thing `'w'` would
  // do to an existing path: follow it. A planted `<task>.relay` symlink is removed
  // rather than truncated through.
  try {
    unlinkSync(relay)
  } catch {
    // Nothing to remove is the normal case.
  }
  const fd = openSync(relay, 'w')
  let child
  try {
    // `stdio` names the descriptor rather than a pipe on purpose: see the note
    // above this section.
    child = spawn(program, args, {
      cwd: options.cwd,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
  } catch (error) {
    closeSync(fd)
    unlinkSync(relay)
    emit({ task: options.task, state: 'failed', msg: `cannot start ${program}: ${error instanceof Error ? error.message : String(error)}` })
    return 127
  }
  // The child holds its own copy of the descriptor and writes through it; ours
  // only made the file, so it closes now.
  closeSync(fd)

  emit({ task: options.task, state: 'running', msg: `started: ${options.command.join(' ').slice(0, RUN_MESSAGE_CHARS)}` })

  let offset = 0
  let previous = { ...NO_SAMPLE }
  let lastAt = Date.now()

  const look = () => {
    // Only the bytes written since the last look are read. Reading the whole
    // relay every tick is quadratic in the command's output — a chatty
    // twenty-minute command would spend its own time re-reading itself.
    let text = ''
    try {
      const size = statSync(relay).size
      if (size <= offset) return
      const length = size - offset
      const buffer = Buffer.alloc(length)
      const fd = openSync(relay, 'r')
      let read = 0
      try {
        read = readSync(fd, buffer, 0, length, offset)
      } finally {
        closeSync(fd)
      }
      text = buffer.subarray(0, read).toString('utf8')
      offset += read
    } catch {
      return
    }
    if (typeof options.out === 'function' || options.quiet !== true) out(text)
    const sample = parseProgress(text, options.pattern ?? null)
    const now = Date.now()
    if (!changeIsWorthReporting(previous, sample, now - lastAt, heartbeatMs)) return
    const event = { task: options.task }
    if (sample.pct !== null) event.pct = sample.pct
    if (sample.done !== null) event.done = sample.done
    if (sample.total !== null) event.total = sample.total
    if (sample.msg.length > 0) event.msg = sample.msg
    emit(event)
    previous = sample
    lastAt = now
  }

  const timer = setInterval(look, everyMs)
  const outcome = await new Promise((resolve) => {
    child.on('error', (error) => {
      emit({ task: options.task, state: 'failed', msg: `cannot run ${program}: ${error.message}` })
      resolve({ code: 127, signal: null, failed: true })
    })
    child.on('close', (code, signal) => {
      resolve({ code: typeof code === 'number' ? code : 1, signal, failed: false })
    })
  })
  clearInterval(timer)
  // One last look: the child may have written its most interesting line in the
  // milliseconds between the previous read and its exit.
  look()
  try {
    unlinkSync(relay)
  } catch {
    // A relay file that cannot be removed is a tidiness problem, not a failure.
  }
  // The ending, from the exit code. A clean exit fills the bar: exit 0 *is* a
  // completion, and a better statement about the ending than a percentage the
  // command was merely printing along the way — a tool whose counter resets per
  // file would otherwise leave a finished row at 30% forever. A run that failed or
  // was stopped keeps what was measured, because then nobody knows how far it got.
  if (outcome.failed) return outcome.code
  const measured = previous.pct === null ? {} : { pct: previous.pct }
  if (outcome.signal !== null) emit({ task: options.task, state: 'cancelled', msg: `killed (${outcome.signal})`, ...measured })
  else if (outcome.code === 0) emit({ task: options.task, state: 'done', msg: 'finished', pct: 100 })
  else emit({ task: options.task, state: 'failed', msg: `exit code ${outcome.code}`, ...measured })
  return outcome.code
}

/* ------------------------------------------------------------------ *
 * The reader's own tail read
 *
 * This is the same bound the Host half applies (`maxFileBytes`, 256 KiB by default),
 * written again rather than imported: `src/` is not in the package's `files`, so a
 * `bin/` script that reached into it would break the moment the tarball is what you
 * have. It matters more here than it does there, because `watch` re-reads every tick
 * — the whole-file version of this made one oversized progress file cost a full read
 * per second.
 * ------------------------------------------------------------------ */

/** How much of a progress file a reader looks at: the Host half's documented default. */
const TAIL_BYTES = 256 * 1024

/**
 * Read at most `maxBytes` from the end of a file, dropping a partial first line.
 *
 * A tail read on a file that outgrew the ceiling starts in the middle of a line, and
 * that fragment is not a JSON object — but it is also not the line a producer wrote,
 * so it is sliced off rather than handed to the parser. The buffer is zero-filled and
 * the read count is honoured for the reason the Host half documents: a file truncated
 * between the `stat` and the read would otherwise yield whatever was in those heap
 * bytes.
 * @param path - the file to read.
 * @param maxBytes - the ceiling; a file at or under it is read whole.
 * @returns the tail as text, empty when the file is empty.
 */
export function readTail(path, maxBytes = TAIL_BYTES) {
  const size = statSync(path).size
  if (size === 0) return ''
  const start = size > maxBytes ? size - maxBytes : 0
  const length = size - start
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    read = readSync(fd, buffer, 0, length, start)
  } finally {
    closeSync(fd)
  }
  const text = buffer.subarray(0, read).toString('utf8')
  return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
}

/** The last parseable event in one file. */
function lastEvent(path) {
  let text
  try {
    text = readTail(path)
  } catch {
    return null
  }
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      // A torn tail line is expected; keep walking backwards.
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * list and watch: the two readers
 *
 * Both print the same row — task, percentage, state, message — folded from the
 * last event each file holds. `list` prints it once; `watch` prints it as it
 * changes. Sharing the fold is the point: a watcher whose idea of "changed"
 * disagreed with what `list` shows would announce a difference the reader cannot
 * see, which is worse than not watching at all.
 * ------------------------------------------------------------------ */

/** The file name a `--task` filter names, or null when none was given. */
function filterOf(options) {
  if (options.task === undefined) return null
  // The same rule `fileOf` applies. A filter names a file, so an id that could
  // not name one is a typo worth reporting, not an empty listing.
  if (!TASK_RE.test(options.task)) fail(`invalid task id ${JSON.stringify(options.task)}: use 1-40 of A-Z a-z 0-9 . _ -`)
  return `${options.task}${SUFFIX}`
}

/**
 * How many task files a reader looks at, mirroring the Host half's working-set bound
 * (`MAX_FILES_PER_DIR` in `src/host/store.ts`).
 *
 * The per-file ceiling bounds one read; this bounds how many reads a single listing
 * does. Without it, a directory that accumulated years of task files makes `list` a
 * one-off cost and `watch` a per-tick one — and the reader is the cheap path by
 * design.
 */
const MAX_TASK_FILES = 64

/**
 * One row per reporting task, folded from the last event in each file.
 *
 * `rows: null` is deliberately not the same as an empty list: a missing directory
 * says progress reporting was never configured, while a directory holding nothing
 * says no task is running. The two get different sentences, and the difference is
 * the whole reason this returns the directory alongside the rows.
 *
 * A directory past the file ceiling is reported up to it, and says so on stderr:
 * dropping rows silently would read as "those tasks are gone", which is a different
 * claim from "there are more than this here".
 * @param options - `dir`, and the optional `task` filter.
 * @returns the directory and its rows, or the directory with `rows: null`.
 */
export function rowsOf(options) {
  const dir = directoryOf(options)
  const only = filterOf(options)
  let names
  try {
    names = readdirSync(dir).filter(name => name.endsWith(SUFFIX))
  } catch {
    return { dir, rows: null }
  }
  // The filter can only ever name one file, so the ceiling is about the unfiltered read.
  const candidates = only === null ? names.sort() : names.filter(name => name === only)
  const reading = candidates.slice(0, MAX_TASK_FILES)
  const rows = []
  for (const name of reading) {
    const event = lastEvent(join(dir, name))
    if (event === null) continue
    rows.push({
      task: typeof event.task === 'string' ? event.task : name.slice(0, -SUFFIX.length),
      pct: typeof event.pct === 'number' ? `${Math.round(event.pct)}%` : '—',
      state: typeof event.state === 'string' ? event.state : 'running',
      msg: typeof event.msg === 'string' ? event.msg : '',
    })
  }
  // How many files the ceiling left unread, for the caller to mention. It is *not*
  // written here: `watch` reads on a timer, so a note per look would scroll the
  // terminal at the pace of the clock — the same defect as the unbounded read this
  // ceiling exists to remove, moved from the filesystem to the output.
  return { dir, rows, beyond: Math.max(0, candidates.length - reading.length) }
}

/**
 * Whether a directory holding more task files than one read looks at is news.
 *
 * News the first time, and news again only when the number moves: that is what keeps
 * `watch` from repeating the same sentence every tick.
 * @param beyond - files the ceiling left unread this look.
 * @param seen - the same count from the previous look, or undefined for the first.
 * @returns true when the caller should say so now.
 */
export function ceilingIsNews(beyond, seen) {
  return beyond > 0 && beyond !== seen
}

/** Say, once, that a directory holds more task files than one read looks at. */
function notifyCeiling(beyond, dir) {
  process.stderr.write(`dsh-progress: showing ${MAX_TASK_FILES} of ${MAX_TASK_FILES + beyond} task files in ${dir}\n`)
}

/** One row as a line of text, aligned to a width the caller already measured. */
export function formatRow(row, width) {
  return `${row.task.padEnd(width)}  ${row.pct.padStart(4)}  ${row.state.padEnd(9)}  ${row.msg}`
}

/** The clock `watch` prefixes a change with, so scrollback says when it moved. */
function stamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/**
 * One row as it is printed, which depends on whether a line is a read or a follow.
 *
 * A clock on every line of a stream is what tells a reader when something moved; the
 * same clock on a single read is noise a script would have to strip. So a single
 * pass prints exactly what `list` prints, and that agreement is the contract this
 * function exists to hold in one place.
 * @param row - the folded row to print.
 * @param width - the alignment the caller measured across all rows.
 * @param following - true when more lines may follow this one.
 * @returns the line, without its newline.
 */
export function lineFor(row, width, following) {
  return following ? `${stamp()}  ${formatRow(row, width)}` : formatRow(row, width)
}

/**
 * Whether two readings of one task say the same thing to a reader.
 *
 * `watch` prints by this, so it is the difference between a line per update and a
 * line per tick. A task seen for the first time is always news: `undefined` is not
 * a reading that agrees with anything.
 * @param before - the row printed last time, or undefined for a task just seen.
 * @param after - the row just read.
 * @returns true when there is nothing new to print.
 */
export function sameRow(before, after) {
  if (before === undefined || after === undefined) return before === after
  return before.task === after.task
    && before.pct === after.pct
    && before.state === after.state
    && before.msg === after.msg
}

/** Print every task currently reporting in the directory. Exported so the ceiling note
 * has a caller a test can reach: the loop that watches is not. */
export function list(options) {
  const { dir, rows, beyond } = rowsOf(options)
  if (beyond > 0) notifyCeiling(beyond, dir)
  if (rows === null) {
    process.stdout.write(`(no progress directory at ${dir})\n`)
    return
  }
  if (rows.length === 0) {
    process.stdout.write(`(no tasks reported in ${dir})\n`)
    return
  }
  const width = Math.max(...rows.map(row => row.task.length))
  for (const row of rows) process.stdout.write(`${formatRow(row, width)}\n`)
}

/** How often `watch` looks again by default, and how often it may. */
const WATCH_EVERY_MS = 1000
const WATCH_MIN_MS = 200

/**
 * Follow the directory and print a row whenever a task's reading changes.
 *
 * The alternative is asking `list` again by hand, which costs a round trip per
 * look and reports the same row every time. This reads the files rather than a
 * process, so a task another shell started shows up here too.
 *
 * It writes nothing, so there is nothing to settle and Ctrl+C is the whole
 * teardown — no ending to emit, no file to close.
 */
async function watch(options) {
  const interval = numberFlag(options.interval, 'interval', WATCH_MIN_MS, 60_000) ?? WATCH_EVERY_MS
  let previous = new Map()
  let seenBeyond
  for (;;) {
    const { dir, rows, beyond } = rowsOf(options)
    // Said once rather than once per tick: see `ceilingIsNews`.
    if (ceilingIsNews(beyond, seenBeyond)) notifyCeiling(beyond, dir)
    seenBeyond = beyond
    if (rows === null) {
      process.stdout.write(`(no progress directory at ${dir})\n`)
      return
    }
    if (rows.length === 0 && options.once === true) {
      process.stdout.write(`(no tasks reported in ${dir})\n`)
      return
    }
    const width = Math.max(0, ...rows.map(row => row.task.length))
    for (const row of rows) {
      // A task that was absent last tick has no previous row, and `sameRow` calls
      // that news — which is how a watcher announced before it existed still gets
      // its opening line.
      if (sameRow(previous.get(row.task), row)) continue
      process.stdout.write(`${lineFor(row, width, options.once !== true)}\n`)
    }
    previous = new Map(rows.map(row => [row.task, row]))
    if (options.once === true) return
    await sleep(interval)
  }
}

/**
 * Everything the command line does, behind one entry point.
 *
 * Async because `run` follows a child process to its end; every other command
 * finishes without ever yielding.
 *
 * The guard matters: this file is imported by the test suite so that a syntax
 * error in it fails the suite (a long prose template literal is exactly the kind
 * of thing that can be broken by a stray backtick, and the tests cannot spawn a
 * process to find out). Importing must therefore have no effect.
 */
export async function run() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write('dsh-progress 0.2.1\n')
    process.exit(0)
  }

  // Everything after the first `--` belongs to the wrapped command, so it must be
  // split off before the flag parser ever sees it: a command's own flags are not
  // this CLI's flags, and `--help` on the wrapped program is not a request for ours.
  const separator = rest.indexOf('--')
  const own = separator < 0 ? rest : rest.slice(0, separator)
  const wrapped = separator < 0 ? [] : rest.slice(separator + 1)

  let options
  try {
    options = parseArgs({
      args: own,
      strict: true,
      allowPositionals: false,
      options: {
        task: { type: 'string' },
        state: { type: 'string' },
        pct: { type: 'string' },
        msg: { type: 'string' },
        done: { type: 'string' },
        total: { type: 'string' },
        unit: { type: 'string' },
        dir: { type: 'string' },
        file: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        every: { type: 'string' },
        interval: { type: 'string' },
        once: { type: 'boolean' },
        pattern: { type: 'string' },
        quiet: { type: 'boolean' },
        cwd: { type: 'string' },
      },
    }).values
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  if (options.help === true) {
    process.stdout.write(HELP)
    process.exit(0)
  }

  switch (command) {
    case 'run': {
      if (wrapped.length === 0) fail('run needs a command after `--`: dsh-progress run --task <id> -- <command> [args...]')
      const dir = directoryOf(options)
      const resolved = resolvePattern(options.pattern)
      if (resolved.error !== null) fail(`--pattern is refused: ${resolved.error}`)
      const pattern = resolved.pattern
      // The task id is checked before anything is spawned: a rejected id after a
      // twenty-minute command has already run is a bad way to learn it.
      fileOf(options)
      const code = await runWrapped({
        task: options.task,
        command: wrapped,
        dir,
        cwd: typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : undefined,
        everyMs: numberFlag(options.every, 'every', 20, 60_000),
        pattern,
        quiet: options.quiet === true,
        emit: (event) => { emit(options, event) },
      })
      process.exit(code)
      break
    }
    case 'emit':
      emit(options)
      break
    case 'done':
      emit(options, { state: 'done', pct: options.pct === undefined ? 100 : undefined })
      break
    case 'fail':
      emit(options, { state: 'failed' })
      break
    case 'cancel':
      emit(options, { state: 'cancelled' })
      break
    case 'path': {
      const path = options.task === undefined ? directoryOf(options) : fileOf(options)
      process.stdout.write(`${path}\n`)
      break
    }
    case 'list':
      list(options)
      break
    case 'watch':
      await watch(options)
      break
    case 'clear': {
      const path = targetOf(options)
      if (!existsSync(path)) fail(`no such file ${path}`)
      try {
        rmSync(path, { force: true })
      } catch (error) {
        fail(`cannot remove ${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
      break
    }
    default:
      fail(`unknown command ${JSON.stringify(command)} (try: run, emit, done, fail, cancel, path, list, watch, clear)`)
  }
}

/** True when this file is the process entry point rather than an import. */
const isEntryPoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  // A failure that never settles must not look like a hang: the exit path is in
  // `run`, and this is only the seam for a bug in it.
  run().catch((error) => {
    process.stderr.write(`dsh-progress: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  })
}
