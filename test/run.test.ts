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
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeIsWorthReporting, parseProgress, patternRejection, resolvePattern, runWrapped } from '../bin/dsh-progress.mjs'

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

test('run compiles a pattern through one guarded path, and refuses there', () => {
  // The unit check above proves the scanner works; this proves the CLI is wired
  // to it. Without this, deleting the call in `run` would leave the suite green —
  // which is exactly what the mutation harness reported the first time.
  assert.deepEqual(resolvePattern(undefined), { pattern: null, error: null }, 'no pattern is not an error')
  assert.deepEqual(resolvePattern(''), { pattern: null, error: null })
  assert.match(resolvePattern('(a+)+$').error ?? '', /repeats a group that already repeats/)
  assert.match(resolvePattern('(').error ?? '', /not a valid regular expression/)
  assert.equal(resolvePattern('Progress: (\\d+)%').pattern instanceof RegExp, true)
  assert.equal(resolvePattern('Progress: (\\d+)%').error, null)
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

test('a pattern that would backtrack catastrophically is refused, not run', () => {
  // `--pattern` arrives on a command line the model writes, so this has to be
  // refused rather than trusted. Measured before the guard existed: `(a+)+$`
  // against 20 characters took 10 ms, against 40 it never finished.
  assert.match(patternRejection('(a+)+$') ?? '', /repeats a group that already repeats/)
  assert.match(patternRejection('(\\d+)*') ?? '', /repeats a group that already repeats/)
  assert.match(patternRejection('(foo{1,3})+') ?? '', /repeats a group that already repeats/)
  assert.match(patternRejection('a**') ?? '', /two quantifiers/)
  assert.match(patternRejection('x'.repeat(300)) ?? '', /longer than/)

  // The shapes a producer actually needs all pass.
  assert.equal(patternRejection('Progress: (\\d+)%'), null)
  assert.equal(patternRejection('(\\d{1,3})\\s*%'), null)
  assert.equal(patternRejection('ETA (\\d+) remaining'), null)
  assert.equal(patternRejection('[a+]+'), null, 'a quantifier inside a class is a literal, not a repeat')
  assert.equal(patternRejection('a+b*c?'), null)
  assert.equal(patternRejection('\\(\\d+\\)'), null, 'escaped parentheses are literals')
})

test('the pattern is applied to a bounded line, whatever the command prints', () => {
  // Defence in depth behind the guard above: a long line must not become a long
  // regex input, so a pathological pattern cannot be handed a big subject.
  const long = `${'x'.repeat(5000)} 77%`
  assert.equal(parseProgress(long, /(\d+)%/).pct, null, 'the percentage sat beyond the bound')
  const near = `${'x'.repeat(900)} 77%`
  assert.equal(parseProgress(near, /(\d+)%/).pct, 77, 'a line inside the bound is still read')
  // The message is unaffected: it is taken from the line, not from the match.
  assert.equal(parseProgress(long).msg.length, 160)
})

test('a relay left behind by a killed run is replaced, never appended to', async () => {
  // `taskkill` gives the wrapper no chance to clean up, so the next run of the
  // same task finds a stale relay. Reading it would report a dead run's output.
  const dir = mkdtempSync(join(tmpdir(), 'dtp-run-'))
  const events: Record<string, unknown>[] = []
  try {
    writeFileSync(join(dir, 'stale.relay'), 'garbage from an older run 13%\n')
    await runWrapped({
      task: 'stale',
      dir,
      everyMs: 40,
      heartbeatMs: 60_000,
      command: [process.execPath, '-e', "console.log('99%'); process.exit(0)"],
      emit: (event) => { events.push(event) },
      out: () => {},
    })
    assert.equal(events.some(event => String(event['msg'] ?? '').includes('garbage')), false, 'the stale bytes were not read')
    assert.ok(events.some(event => event['pct'] === 99), 'the run own output was read')
    assert.deepEqual(readdirSync(dir), [], 'and nothing was left behind')
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
