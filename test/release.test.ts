/**
 * Release-consistency tests.
 *
 * These exist because everything they check rots silently: a version bumped in
 * one file, an example the README tells a user to run that the package does not
 * ship. Both look fine in a checkout and fail for whoever installed it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (name: string): string => readFileSync(new URL(name, root), 'utf8')

/** Escape a version string for use inside a regular expression. */
const literal = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('the version is stated in four places and invented in none', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string }
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json version is not semver')
  const version = literal(pkg.version)
  assert.match(read('README.md'), new RegExp(`Version ${version}\\b`), 'README.md does not state the version')
  assert.match(read('README.zh.md'), new RegExp(`版本 ${version}\\b`), 'README.zh.md does not state the version')
  assert.match(read('CHANGELOG.md'), new RegExp(`## \\[${version}\\]`), 'CHANGELOG.md has no entry for this version')
})

test('every path the READMEs tell a user to run ships in the package', () => {
  const pkg = JSON.parse(read('package.json')) as { files: string[] }
  // The READMEs name the example script, the documented protocol, and the host
  // and browser entry points; a published install must contain all of them.
  for (const required of ['examples/simulate.ps1', 'docs/PROTOCOL.md', 'bin/dsh-progress.mjs', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js']) {
    const covered = pkg.files.some(entry => entry === required || required.startsWith(`${entry}/`))
    assert.ok(covered, `package.json files does not ship ${required}`)
  }
})

test('the manifest still declares what the loader needs', () => {
  const pkg = JSON.parse(read('package.json')) as {
    name: string
    type: string
    main: string
    exports: Record<string, string>
    dsh: { bundle: { patch: string }, client: { platform: string, external: string[] } }
  }
  assert.equal(pkg.name, 'dsh-task-progress')
  assert.equal(pkg.type, 'module', 'the host half is ESM')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  // Only platform modules may be external: a bare dependency here would not
  // resolve from a profile install.
  for (const external of pkg.dsh.client.external) {
    assert.ok(
      ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots'].includes(external),
      `${external} is not a platform module the shell seeds`,
    )
  }
})
