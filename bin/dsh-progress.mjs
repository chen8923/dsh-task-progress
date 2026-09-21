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
 *   dsh-progress clear --task build
 */

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  dsh-progress list
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
  --pattern RE   read the percentage from this regex instead (first capture group)
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
  control; prefer --task, which cannot leave the progress directory.

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

/** What one look at the command's output says about progress. */
const NO_SAMPLE = { pct: null, done: null, total: null, msg: '' }

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
    const match = search.exec(lines[index])
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
    let text = ''
    try {
      const size = statSync(relay).size
      if (size <= offset) return
      const buffer = readFileSync(relay)
      text = buffer.subarray(offset).toString('utf8')
      offset = size
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

/** The last parseable event in one file. */
function lastEvent(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
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

/** Print every task currently reporting in the directory. */
function list(options) {
  const dir = directoryOf(options)
  let names
  try {
    names = readdirSync(dir).filter(name => name.endsWith(SUFFIX))
  } catch {
    process.stdout.write(`(no progress directory at ${dir})\n`)
    return
  }
  const rows = []
  for (const name of names.sort()) {
    const event = lastEvent(join(dir, name))
    if (event === null) continue
    rows.push({
      task: typeof event.task === 'string' ? event.task : name.slice(0, -SUFFIX.length),
      pct: typeof event.pct === 'number' ? `${Math.round(event.pct)}%` : '—',
      state: typeof event.state === 'string' ? event.state : 'running',
      msg: typeof event.msg === 'string' ? event.msg : '',
    })
  }
  if (rows.length === 0) {
    process.stdout.write(`(no tasks reported in ${dir})\n`)
    return
  }
  const width = Math.max(...rows.map(row => row.task.length))
  for (const row of rows) {
    process.stdout.write(`${row.task.padEnd(width)}  ${row.pct.padStart(4)}  ${row.state.padEnd(9)}  ${row.msg}\n`)
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
    process.stdout.write('dsh-progress 0.1.1\n')
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
      let pattern = null
      if (typeof options.pattern === 'string' && options.pattern.length > 0) {
        try {
          pattern = new RegExp(options.pattern)
        } catch (error) {
          fail(`--pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
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
      fail(`unknown command ${JSON.stringify(command)} (try: run, emit, done, fail, cancel, path, list, clear)`)
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
