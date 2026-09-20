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
 * Zero dependencies, Node 20+, ESM.
 *
 *   dsh-progress emit --task build --pct 10 --msg "linking" [--done 3 --total 9 --unit files]
 *   dsh-progress done --task build --msg "shipped"
 *   dsh-progress fail --task build --msg "link error"
 *   dsh-progress path [--task build]
 *   dsh-progress list
 *   dsh-progress clear --task build
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
  dsh-progress emit  --task <id> [--pct N] [--msg TEXT] [--done N --total N --unit NAME] [--state STATE] [--json]
  dsh-progress done  --task <id> [--msg TEXT]
  dsh-progress fail  --task <id> [--msg TEXT]
  dsh-progress cancel --task <id> [--msg TEXT]
  dsh-progress path  [--task <id>]
  dsh-progress list
  dsh-progress clear --task <id>
  dsh-progress --help | --version

Where the file goes:
  $DSH_PROGRESS_DIR/<task>.jsonl   (set automatically inside DSH model shell calls)
  --dir <path>                     override the directory

  --file <path> writes exactly that path and skips the task-id rule entirely, so
  it can append to any path you can write (creating parent directories), and
  "clear --file" removes one. Pass it only from a script whose arguments you
  control; prefer --task, which cannot leave the progress directory.

Examples:
  node "$env:DSH_PROGRESS_CLI" emit --task build --pct 10 --msg "linking"
  node "$DSH_PROGRESS_CLI" done --task build --msg "shipped"

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
 * The guard matters: this file is imported by the test suite so that a syntax
 * error in it fails the suite (a long prose template literal is exactly the kind
 * of thing that can be broken by a stray backtick, and the tests cannot spawn a
 * process to find out). Importing must therefore have no effect.
 */
export function run() {
  const [command, ...rest] = process.argv.slice(2)

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write('dsh-progress 0.1.0\n')
    process.exit(0)
  }

  let options
  try {
    options = parseArgs({
      args: rest,
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
      fail(`unknown command ${JSON.stringify(command)} (try: emit, done, fail, cancel, path, list, clear)`)
  }
}

/** True when this file is the process entry point rather than an import. */
const isEntryPoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) run()
