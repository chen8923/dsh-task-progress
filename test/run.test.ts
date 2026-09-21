/**
 * The wrapper's tests — and the reason it exists at all.
 *
 * A long task used to cost the model a small program: probe the tool's output,
 * write a script that parses it, discover the encoding and redirection traps,
 * add a BOM, syntax-check, launch. That is six round trips before any work
 * starts, and it is paid again for every new kind of command. `dsh-progress run`
 * replaces it with one command line, so what it must do is exactly what those
 * scripts were trying to do: start a task, follow the child's output, report
 * what it can parse, and write the ending itself from the exit code.
 *
 * The integration case spawns a real child, which is worth a note: this suite
 * runs inside the same sandbox the plugin runs in, and that sandbox refuses the
 * pipes a piped child needs (`spawn` + `stdio: 'pipe'` → EPERM, measured). The
 * wrapper therefore relays the child through a **file descriptor**, and this
 * test fails if anyone ever "simplifies" that back to a pipe — the failure is an
 * EPERM, not a subtle one.
 *
 * @module dsh-task-progress/test/run
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeIsWorthReporting, parseProgress, runWrapped } from '../bin/dsh-progress.mjs'

/** No sample at all: what a task looks like before its first parse. */
const nothing = { pct: null, done: null, total: null, msg: '' }

test('a percentage and a counter pair are read out of whatever the tool printed', () => {
  assert.equal(parseProgress('building\nProgress: 42.5%\ndone').pct, 42.5)
  assert.equal(parseProgress('fetching 1234/8888 objects').done, 1234)
  assert.equal(parseProgress('fetching 1234/8888 objects').total, 8888)
  // A percentage the tool itself reported is passed through, not recomputed: the
  // reader already knows how to derive one from done/total.
  assert.equal(parseProgress('7%').pct, 7)
  assert.equal(parseProgress('250%').pct, 100, 'an impossible percentage is clamped, not forwarded')
  assert.equal(parseProgress('no numbers here').pct, null)
})

test('the message is the last line the child printed', () => {
  assert.equal(parseProgress('one\ntwo\n\nthree\n').msg, 'three')
  assert.equal(parseProgress('   spaced   ').msg, 'spaced')
  assert.equal(parseProgress('').msg, '')
  // A producer that prints a megabyte-long line must not turn it into a message.
  assert.equal(parseProgress('x'.repeat(1000)).msg.length, 160)
})

test('a pattern overrides the built-in reading, for a tool that needs one', () => {
  // First capture group is the percentage; the rest of the line is still the message.
  assert.equal(parseProgress('ETA 99 remaining', /ETA (\d+)/).pct, 99)
  assert.equal(parseProgress('Progress: 42%', /ETA (\d+)/).pct, null, 'the override replaces the default, it does not add to it')
})

test('only a change, or a heartbeat, is worth a line in the file', () => {
  const first = { pct: 10, done: null, total: null, msg: 'building' }
  // Nothing moved and the heartbeat is far away: the file stays small.
  assert.equal(changeIsWorthReporting(first, { ...first }, 1_000, 30_000), false)
  assert.equal(changeIsWorthReporting(first, { ...first, pct: 11 }, 1_000, 30_000), true)
  assert.equal(changeIsWorthReporting(first, { ...first, msg: 'linking' }, 1_000, 30_000), true)
  // A tool that prints the same line for ten minutes still has to move the clock,
  // or the panel would say "no update for 10m" about work that is plainly running.
  assert.equal(changeIsWorthReporting(first, { ...first }, 30_000, 30_000), true)
  // An empty message is not a change: it is no news.
  assert.equal(changeIsWorthReporting(nothing, { ...nothing }, 1_000, 30_000), false)
})

test('the wrapper reports a run, relays its output, and ends it from the exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtp-run-'))
  const events: Record<string, unknown>[] = []
  const echoed: string[] = []
  try {
    const code = await runWrapped({
      task: 'wrapped',
      dir,
      everyMs: 40,
      heartbeatMs: 60_000,
      command: [
        process.execPath,
        '-e',
        "console.log('phase one'); console.log('7%'); console.log('phase two'); process.exit(3)",
      ],
      emit: (event) => { events.push(event) },
      out: (text) => { echoed.push(text) },
    })
    assert.equal(code, 3, 'the child exit code is the wrapper exit code')
    assert.equal(events[0]?.['state'], 'running', 'the row exists from the first moment')
    assert.equal(events[0]?.['task'], 'wrapped')
    assert.ok(events.some(event => event['pct'] === 7), 'the percentage in the child output reaches the file')
    const last = events.at(-1)
    assert.equal(last?.['state'], 'failed')
    assert.equal(last?.['msg'], 'exit code 3')
    assert.ok(echoed.join('').includes('phase two'), 'the child output is relayed, not swallowed')
    // The relay file is an implementation detail: it does not outlive the run.
    assert.deepEqual(readdirSync(dir), [], 'the wrapper left something behind in the progress directory')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a clean exit ends the task as done, with the bar full when nothing measured it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dtp-run-'))
  const events: Record<string, unknown>[] = []
  try {
    const code = await runWrapped({
      task: 'clean',
      dir,
      everyMs: 40,
      heartbeatMs: 60_000,
      command: [process.execPath, '-e', "console.log('alpha'); process.exit(0)"],
      emit: (event) => { events.push(event) },
      out: () => {},
    })
    assert.equal(code, 0)
    const last = events.at(-1)
    assert.equal(last?.['state'], 'done')
    assert.equal(last?.['pct'], 100, 'a clean finish with no measured percentage is a complete bar')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a clean exit fills the bar even when the command last measured less', async () => {
  // Exit 0 is a completion, and it is a better statement about the ending than a
  // percentage the command was merely printing along the way: a tool whose
  // counter resets per file, or whose last line was a phase marker, would
  // otherwise leave a finished row sitting at 30% forever. A run that was killed
  // or failed keeps what was measured, because then nobody knows how far it got.
  const dir = mkdtempSync(join(tmpdir(), 'dtp-run-'))
  const events: Record<string, unknown>[] = []
  try {
    await runWrapped({
      task: 'partial',
      dir,
      everyMs: 40,
      heartbeatMs: 60_000,
      command: [process.execPath, '-e', "console.log('30%'); process.exit(0)"],
      emit: (event) => { events.push(event) },
      out: () => {},
    })
    assert.equal(events.at(-1)?.['pct'], 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
