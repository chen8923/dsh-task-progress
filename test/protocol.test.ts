/**
 * Protocol tests: the tolerance rules that keep a half-written or hand-edited
 * progress file from breaking the panel.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_MESSAGE_CHARS,
  STATE_ROUTE,
  clampPct,
  isValidTaskId,
  normalizeMessage,
  normalizeState,
  parseEvent,
  parseState,
  stateUrl,
} from '../src/protocol.ts'

test('the state URL always names the session it is asking about', () => {
  assert.equal(stateUrl('session-1'), `${STATE_ROUTE}?session=session-1`)
  // Encoded, so a session id can never break out of its own query parameter.
  assert.equal(stateUrl('a b&c=d'), `${STATE_ROUTE}?session=a%20b%26c%3Dd`)
  assert.match(stateUrl(''), /\?session=$/)
})

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

test('parseState keeps an inferred ending, and refuses a baseless one', () => {
  // `ended` is the only field a producer never writes: the Host adds it when the
  // job registry proves the writer is gone. A reader that kept a marker without
  // a job or a known outcome would let a row claim an inference nobody made.
  const state = parseState(JSON.stringify({
    v: 1,
    tasks: [
      { task: 'killed', state: 'cancelled', sessionId: 's1', ended: { job: 'pwsh-7', status: 'killed', detail: 'signal: SIGTERM' } },
      { task: 'clean', state: 'done', sessionId: 's1', ended: { job: 'pwsh-8', status: 'completed' } },
      { task: 'no-job', state: 'cancelled', sessionId: 's1', ended: { status: 'killed' } },
      { task: 'no-status', state: 'cancelled', sessionId: 's1', ended: { job: 'pwsh-9' } },
      { task: 'bad-status', state: 'cancelled', sessionId: 's1', ended: { job: 'pwsh-9', status: 'stopping' } },
      { task: 'not-an-object', state: 'cancelled', sessionId: 's1', ended: 'killed' },
    ],
  }))
  assert.ok(state)
  const byTask = new Map(state.tasks.map(task => [task.task, task]))
  assert.deepEqual(byTask.get('killed')?.ended, { job: 'pwsh-7', status: 'killed', detail: 'signal: SIGTERM' })
  assert.deepEqual(byTask.get('clean')?.ended, { job: 'pwsh-8', status: 'completed' })
  assert.equal(byTask.get('no-job')?.ended, undefined)
  assert.equal(byTask.get('no-status')?.ended, undefined)
  assert.equal(byTask.get('bad-status')?.ended, undefined)
  assert.equal(byTask.get('not-an-object')?.ended, undefined)
  // The state survives regardless: the marker explains a state, it does not carry it.
  assert.equal(byTask.get('no-job')?.state, 'cancelled')
})

test('parseState carries the client-facing knobs, including the overlay policy', () => {
  // These ride the state document rather than the settings transport: every
  // surface already polls this endpoint, and a browser half that must fetch its
  // own configuration before it can decide whether to render is a second data
  // path to keep correct.
  const state = parseState(JSON.stringify({ v: 1, tasks: [], pollMs: 2000, overlayUnreported: true }))
  assert.equal(state?.overlayUnreported, true)
  // Absent or junk is off: never interrupt anybody by accident.
  assert.equal(parseState('{"tasks":[]}')?.overlayUnreported, false)
  assert.equal(parseState('{"tasks":[],"overlayUnreported":"yes"}')?.overlayUnreported, false)
})

test('parseState refuses anything it cannot trust', () => {
  for (const body of ['', 'nope', '[]', '{"tasks":"x"}', 'null']) {
    assert.equal(parseState(body), null, `expected null for ${JSON.stringify(body)}`)
  }
  const noTasks = parseState('{"tasks":[]}')
  assert.deepEqual(noTasks?.tasks, [])
  assert.equal(noTasks?.pollMs, 2000)
})
