/**
 * CLI tests.
 *
 * The sandbox these run in forbids the pipes a child process needs, so the CLI
 * cannot be executed from here — but it CAN be imported, which is why its
 * command line sits behind an entry-point guard. Importing is the syntax check,
 * and it matters: the help text is one long prose template literal, and a stray
 * backtick in it breaks the whole file at parse time. That happened once, and
 * nothing in the suite noticed, because nothing imported the file.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HELP, formatRow, lineFor, rowsOf, run, sameRow } from '../bin/dsh-progress.mjs'

test('the CLI module parses and exports its entry point', () => {
  assert.equal(typeof run, 'function')
  assert.ok(HELP.length > 400, 'help text is suspiciously short')
})

test('the help text documents the contract a producer depends on', () => {
  // Where progress goes, and both ways the environment offers to get there.
  assert.match(HELP, /DSH_PROGRESS_DIR/)
  assert.match(HELP, /DSH_PROGRESS_CLI/)
  assert.match(HELP, /--task <id>/)
  // The line format, including the version field the reader checks first.
  assert.match(HELP, /\{"v":1,"task":"build"/)
  assert.match(HELP, /state/)
  // The destructive option is described as such, next to the safe one.
  assert.match(HELP, /--file <path> writes exactly that path/)
  assert.match(HELP, /"clear --file" removes one/)
  assert.match(HELP, /prefer --task, which cannot leave the progress directory/)
})

test('every command the switch handles is named in the help text', () => {
  const source = readFileSync(new URL('../bin/dsh-progress.mjs', import.meta.url), 'utf8')
  const handled = [...source.matchAll(/^\s+case '([a-z]+)':/gm)].map(match => match[1])
  assert.deepEqual([...handled].sort(), ['cancel', 'clear', 'done', 'emit', 'fail', 'list', 'path', 'run', 'watch'])
  for (const command of handled) {
    assert.ok(HELP.includes(`dsh-progress ${String(command)}`), `help text does not document ${String(command)}`)
  }
})

test('a watcher only reports a row that actually changed', () => {
  // `watch` follows the directory and prints on change, so the comparison is what
  // decides whether a user sees one line per update or a line every tick. It is
  // pure and lives here rather than inline for exactly that reason.
  const row = { task: 'build', pct: '42%', state: 'running', msg: 'linking' }
  assert.equal(sameRow(row, { ...row }), true, 'an identical row is not news')
  assert.equal(sameRow(row, { ...row, pct: '43%' }), false, 'a moved percentage is')
  assert.equal(sameRow(row, { ...row, msg: 'done linking' }), false, 'a new message is')
  assert.equal(sameRow(row, { ...row, state: 'done' }), false, 'a settled state is')
  assert.equal(sameRow(undefined, row), false, 'a task seen for the first time is always news')
})

test('a directory unfolds to one row per task, and a filter narrows it', () => {
  // `list` and `watch` show the same rows, so this is where "what counts as a row"
  // is decided: the last complete event of each file, a task with no file being
  // absent rather than blank, and a missing directory being neither.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-progress-rows-'))
  try {
    writeFileSync(join(dir, 'build.jsonl'), '{"v":1,"task":"build","state":"running","pct":10}\n{"v":1,"task":"build","state":"running","pct":42,"msg":"linking"}\n', 'utf8')
    writeFileSync(join(dir, 'sync.jsonl'), '{"v":1,"task":"sync","state":"done","pct":100}\n', 'utf8')
    // A killed writer leaves a torn tail. What it had already reported still counts.
    writeFileSync(join(dir, 'torn.jsonl'), '{"v":1,"task":"torn","pct":7}\n{"v":1,"task":"torn","pc', 'utf8')

    assert.deepEqual(rowsOf({ dir }).rows?.map((row) => row.task), ['build', 'sync', 'torn'])
    assert.deepEqual(rowsOf({ dir }).rows?.[0], { task: 'build', pct: '42%', state: 'running', msg: 'linking' })
    assert.deepEqual(rowsOf({ dir, task: 'sync' }).rows?.map((row) => row.task), ['sync'])
    // Nothing to report is not the same as nowhere to report it to.
    assert.equal(rowsOf({ dir: join(dir, 'never-created') }).rows, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a task can be followed instead of asked about', () => {
  // `watch --once` is documented as printing what `list` prints, which is what lets
  // a script read either one. The clock belongs to a follow, where it says when a row
  // moved; on a single read it would be noise the script has to strip.
  const row = { task: 'build', pct: '42%', state: 'running', msg: 'linking' }
  assert.equal(lineFor(row, 5, false), formatRow(row, 5), 'a single pass is the list form, byte for byte')
  const followed = lineFor(row, 5, true)
  assert.match(followed, /^\d{2}:\d{2}:\d{2} {2}/, 'a follow leads with the clock')
  assert.ok(followed.endsWith(formatRow(row, 5)), 'and the row behind it is the same row')
})

test('the help text leads with the wrapper, because that is the cheap path', () => {
  // One command line instead of a bespoke script: probe, parse, redirection,
  // encoding and the terminal state are all the wrapper's problem. A model that
  // has to synthesise a script per task pays for it every time, in round trips.
  assert.match(HELP, /dsh-progress run --task <id>/)
  assert.match(HELP, /-- <command>/)
  // And the two things a script author gets wrong are stated as the wrapper's job.
  assert.match(HELP, /exit code/)
})
