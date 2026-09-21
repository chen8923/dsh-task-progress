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
import { readFileSync } from 'node:fs'
import { HELP, run } from '../bin/dsh-progress.mjs'

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
  assert.deepEqual([...handled].sort(), ['cancel', 'clear', 'done', 'emit', 'fail', 'list', 'path', 'run'])
  for (const command of handled) {
    assert.ok(HELP.includes(`dsh-progress ${String(command)}`), `help text does not document ${String(command)}`)
  }
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
