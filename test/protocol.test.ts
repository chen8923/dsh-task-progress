/**
 * Protocol tests: the tolerance rules that keep a half-written or hand-edited
 * progress file from breaking the panel.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_MESSAGE_CHARS,
  clampPct,
  isValidTaskId,
  normalizeMessage,
  normalizeState,
  parseEvent,
  parseState,
} from '../src/protocol.ts'

test('parseEvent accepts a full line', () => {
  const event = parseEvent('{"v":1,"task":"build","state":"running","pct":42,"msg":"linking","done":3,"total":9,"unit":"files","at":1730000000000}')
  assert.deepEqual(event, {
    v: 1,
    task: 'build',
    state: 'running',
    pct: 42,
    msg: 'linking',
    at: 1730000000000,
    done: 3,
    total: 9,
    unit: 'files',
  })
})

test('parseEvent drops junk instead of throwing', () => {
  for (const line of ['', '   ', 'not json', '[1,2]', '"str"', '42', 'null', '{"nope":true}']) {
    assert.equal(parseEvent(line), null, `expected null for ${JSON.stringify(line)}`)
  }
})

test('parseEvent tolerates a torn tail and a byte-order mark', () => {
  assert.equal(parseEvent('{"task":"build","pct":1'), null)
  assert.equal(parseEvent('\uFEFF{"task":"build","pct":10}')?.pct, 10)
})

test('parseEvent clamps and normalizes fields', () => {
  assert.equal(parseEvent('{"pct":-5}')?.pct, 0)
  assert.equal(parseEvent('{"pct":1000}')?.pct, 100)
  assert.equal(parseEvent('{"state":"weird","pct":1}')?.state, undefined)
  assert.equal(parseEvent('{"task":"has space","pct":1}')?.task, undefined)
  assert.equal(parseEvent('{"pct":1,"msg":"  a\\nb  "}')?.msg, 'a b')
  assert.equal(parseEvent('{"pct":1,"at":-1}')?.at, undefined)
})

test('a message is bounded to one line and a fixed length', () => {
  const long = 'x'.repeat(MAX_MESSAGE_CHARS + 50)
  assert.equal(normalizeMessage(long).length, MAX_MESSAGE_CHARS)
  assert.equal(normalizeMessage('a\r\nb\tc'), 'a b c')
  assert.equal(normalizeMessage(7), '')
})

test('small helpers agree with the wire format', () => {
  assert.equal(clampPct(12.5), 12.5)
  assert.equal(clampPct(Number.NaN), null)
  assert.equal(clampPct('12'), null)
  assert.equal(normalizeState('done'), 'done')
  assert.equal(normalizeState('DONE'), null)
  assert.equal(isValidTaskId('build-2_x.y'), true)
  assert.equal(isValidTaskId('-leading'), false)
  assert.equal(isValidTaskId('a'.repeat(41)), false)
  assert.equal(isValidTaskId('../escape'), false)
})

test('parseState round-trips a document and drops unusable rows', () => {
  const state = parseState(JSON.stringify({
    v: 1,
    generatedAt: 10,
    pollMs: 100,
    tasks: [
      { task: 'a', state: 'running', pct: 10, sessionId: 's1', root: '/w', msg: 'm', startedAt: 1, updatedAt: 2, recent: ['x'] },
      { task: 'b', state: 'nonsense' },
      'nope',
    ],
  }))
  assert.ok(state)
  assert.equal(state.tasks.length, 1)
  assert.equal(state.tasks[0]?.task, 'a')
  // The advertised poll interval is clamped into the supported band.
  assert.equal(state.pollMs, 500)
})

test('parseState refuses anything it cannot trust', () => {
  for (const body of ['', 'nope', '[]', '{"tasks":"x"}', 'null']) {
    assert.equal(parseState(body), null, `expected null for ${JSON.stringify(body)}`)
  }
  const noTasks = parseState('{"tasks":[]}')
  assert.deepEqual(noTasks?.tasks, [])
  assert.equal(noTasks?.pollMs, 2000)
})
