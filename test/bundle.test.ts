/**
 * Bundle tests: the committed build is present, current, and loadable.
 *
 * `lib/` is committed on purpose (see .gitignore): this plugin installs from
 * git, and a git package that must build needs pnpm's build-script allowlist —
 * keyed by the exact commit, so the second step of that install changes on every
 * push. Shipping the build keeps the install a single command, at the cost of
 * having to notice when the build and the sources drift. That is what these
 * tests are for, as far as a test can see it: the files exist, they still carry
 * what the current sources put in them, and the host half loads.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { STATE_ROUTE } from '../src/protocol.ts'

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

test('the committed build exists and is not empty', () => {
  for (const file of ['lib/index.js', 'lib/client.js']) {
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} is missing: a git install would have no entry point`)
    assert.ok(statSync(new URL(`../${file}`, import.meta.url)).size > 1000, `${file} looks empty`)
  }
})

test('the host bundle still carries what the sources define', () => {
  const bundle = read('lib/index.js')
  // A path and a state name that only a current build contains.
  assert.ok(bundle.includes(STATE_ROUTE), 'lib/index.js does not know the state route: rebuild and commit lib/')
  assert.ok(bundle.includes('task-progress'), 'lib/index.js does not carry the plugin name')
  assert.match(bundle, /export \{[\s\S]*\bapply\b[\s\S]*\}/, 'lib/index.js does not export apply')
})

test('the browser bundle is still a loadable plugin bundle', () => {
  const bundle = read('lib/client.js')
  assert.ok(
    bundle.startsWith('window.__ModuleLoader__.load({'),
    'lib/client.js is not a module-loader bundle: rebuild and commit lib/',
  )
  assert.ok(bundle.includes('"dsh-task-progress"'), 'the bundle does not declare this plugin id')
  // Only platform modules may be required: anything else would not resolve in a
  // browser whose module table holds just the shell's own packages.
  for (const match of bundle.matchAll(/require\("([^"]+)"\)/g)) {
    assert.ok(
      ['react', 'react/jsx-runtime'].includes(match[1] ?? ''),
      `lib/client.js requires ${String(match[1])}, which the shell does not seed`,
    )
  }
})

test('the host bundle imports nothing but Node built-ins', () => {
  const bundle = read('lib/index.js')
  for (const match of bundle.matchAll(/^import [\s\S]*?from "([^"]+)";$/gm)) {
    assert.ok(
      (match[1] ?? '').startsWith('node:'),
      `lib/index.js imports ${String(match[1])}, which a profile install cannot resolve`,
    )
  }
})
