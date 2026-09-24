/**
 * Contract tests for the names this plugin borrows from DSH's browser half.
 *
 * The whole suite is green while a rename upstream can silence a surface, and
 * that is exactly what happened on the 0.1.7 upgrade: `settings.plugin.item`
 * stopped existing, the session list dropped `current`, and the per-session job
 * mirror left for `ctx.jobs`. Every one of those is a **string** this plugin
 * writes and DSH reads, so no amount of fake-object testing can catch it — the
 * fakes agree with the plugin, not with DSH.
 *
 * These assertions are therefore deliberately about the *text* of the two files
 * that talk to DSH, and each one names the seam it protects. They are a tripwire
 * for the next rename, not a substitute for reading the upstream contract.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

/**
 * Drop comments before looking for a name.
 *
 * These files explain the renames they survived, which means the old spelling is
 * in the prose on purpose. A scan that counted a sentence as a call would fail on
 * the documentation of its own fix — and, worse, would pass on a file that only
 * mentioned the new name in a comment.
 * @param source - the file's text.
 * @returns the same text with comments removed.
 */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

test('the settings card registers where the shipped settings pages do', () => {
  const source = code(read('src/client/index.tsx'))
  // DSH 0.1.7 declares `plugins.item` (list, root scope) and keeps no
  // `settings.plugin.item`: a card that registers under the old name is simply
  // never drawn, with no error anywhere.
  assert.ok(
    !source.includes('settings.plugin.item'),
    'settings.plugin.item no longer exists in DSH; the card must use plugins.item',
  )
  assert.match(source, /'plugins\.item'/, 'the card registers into the plugins page list slot')
  // The list slot is scoped to the namespaces the Host serves, through the
  // settings domain's own service. Registering unconditionally would draw a card
  // for a namespace this deployment does not have.
  assert.match(source, /configForms\.whileServed/, 'the card follows the served namespace')
})

test('the settings form binds through the settings service, not a removed scope', () => {
  const source = code(read('src/client/index.tsx'))
  // `settingsScope` is gone from DSH 0.1.7. An `inject(['settingsScope'])` still
  // compiles and still runs — it just never fires, which is how the card
  // disappeared without a single error.
  assert.ok(!source.includes('settingsScope'), 'settingsScope is not a DSH service any more')
  assert.match(source, /configForms\.get/, 'the form values come from the settings service')
})

test('the session in view is read from the retention the main view publishes', () => {
  const source = code(read('src/client/session-hook.ts'))
  // `SessionListState` is `{ ids, byId, phase, projectionsBySession }` in
  // 0.1.7 — `current` is gone, and reading it yields `undefined` forever, which
  // is what emptied the overlay.
  assert.ok(!source.includes('state.current'), 'SessionListState carries no `current` since DSH 0.1.7')
  assert.match(source, /mainView/, 'the session in view is the one held under the mainView source')
})

test('the job rows come from the client jobs service, watched per session', () => {
  const source = code(read('src/client/session-hook.ts'))
  // The browser-side `jobsBySession` mirror left the session list; the rows now
  // stream from `ctx.jobs`, which also has to be *watched* — the snapshot is
  // empty until something asks for a session's roster.
  assert.ok(!source.includes('jobsBySession'), 'the session list no longer mirrors jobs')
  assert.match(code(read('src/client/job-roster.ts')), /watchRows/, 'a roster only streams while a surface watches it')
})

test('the surfaces take the job roster from the service, never from the session list', () => {
  const source = code(read('src/client/index.tsx'))
  assert.match(source, /inject\(\['jobs'\]/, 'the roster arrives through cordis injection')
})

test('the job snapshot is read from the service state, not off the service', () => {
  // `IJobs` (`ctx.jobs`) exposes `watchRows` and a `state` field; the observable
  // snapshot (`getSnapshot` / `subscribe`) is `ctx.jobs.state` — a DIFFERENT
  // object. Reading `getSnapshot` off the service throws during render, and a
  // thrown render unmounts the surface: the overlay simply stopped appearing,
  // again, with nothing in the panel to say why.
  const source = code(read('src/client/job-roster.ts'))
  assert.match(source, /roster\?\.state/, 'the snapshot lives on ctx.jobs.state')
  assert.ok(
    !/roster\??\.getSnapshot/u.test(source),
    'ctx.jobs itself has no getSnapshot — the snapshot belongs to ctx.jobs.state',
  )
  assert.match(code(read('src/client/session-hook.ts')), /readonly state: JobRowsSource/, 'the shape says so')
})
