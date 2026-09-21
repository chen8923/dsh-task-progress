/**
 * Nothing in this repository may name somebody's machine.
 *
 * This exists because the repository did name one: a planning note was added
 * under `docs/` (which ships to npm) describing the local checkouts, the profile
 * directories and a personal workspace folder. The note was scrubbed and moved
 * out of the package, but the only reason it was noticed at all is that someone
 * read the diff. A rule that has to be remembered is not a rule.
 *
 * The scan walks the worktree rather than shelling out to git, so it runs in the
 * restricted sandboxes this suite is designed for — and so it also covers a file
 * that is about to be committed but is not tracked yet.
 *
 * @module dsh-task-progress/test/privacy
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Directories that are not the repository's own content. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-progress'])

/** Extensions that are archives or images rather than readable text. */
const SKIP_EXT = new Set(['.tgz', '.gz', '.zip', '.png', '.jpg', '.jpeg', '.ico', '.woff', '.woff2'])

/** A file bigger than this is not a document anyone reads. */
const MAX_BYTES = 4 * 1024 * 1024

/**
 * A Windows drive-absolute path.
 *
 * The lookbehind is what keeps prose and URLs out: in `https://host/x` and
 * `uses: actions/checkout@v7` the letter before the colon is preceded by another
 * letter, so neither is a path. A drive-letter placeholder written the Windows
 * way is caught, and that is deliberate — the rule is "no drive letters anywhere",
 * because a rule with an exception is a rule nobody can check.
 */
const DRIVE_ABSOLUTE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?=[^\s])/

/** A home directory that names a user. */
const HOME_DIRECTORY = /\/(?:Users|home)\/[A-Za-z][A-Za-z0-9._-]+/

/**
 * A home directory spelled with a tilde: `~` followed by the plugin's own
 * settings directory name. Spelled out in fragments below and *not* here,
 * because this file is scanned by its own rule — a literal would make the test
 * fail on itself, which is the first thing the rule caught.
 */
const TILDE_HOME = /~\/\.dsh\b/

/** The rules, each with the name it reports itself under. */
const RULES: readonly (readonly [string, RegExp])[] = [
  ['windows-absolute-path', DRIVE_ABSOLUTE],
  ['user-home-directory', HOME_DIRECTORY],
  ['tilde-home-directory', TILDE_HOME],
]

/**
 * Every readable text file in the worktree.
 * @param dir - directory to walk.
 * @param out - accumulator, so the recursion allocates one array.
 * @returns absolute file paths.
 */
function textFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) textFiles(path, out)
      continue
    }
    if (SKIP_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) continue
    try {
      if (statSync(path).size <= MAX_BYTES) out.push(path)
    } catch {
      // A file that cannot be stat'ed is not a file this test can judge.
    }
  }
  return out
}

test('the repository names no machine of its own', () => {
  const offences: string[] = []
  for (const file of textFiles(root)) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const [name, pattern] of RULES) {
      const found = pattern.exec(text)
      if (found !== null) {
        // The matched text is deliberately **not** echoed. This message ends up
        // in a CI log on a public repository, and repeating the machine's path
        // there is the leak this test exists to prevent — a check that publishes
        // what it finds would be worse than no check.
        offences.push(`${relative(root, file).replace(/\\/g, '/')} — ${name} (offset ${found.index})`)
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    'machine-specific paths are in the tree:\n  '
      + offences.join('\n  ')
      + '\n\nUse a placeholder (`<repo>`, `<DSH checkout>`, `$DSH_HOME`) or a path without a drive letter.',
  )
})

test('the rules still catch what they are for', () => {
  // Every probe is assembled from fragments: written as literals they would put
  // the very strings this file forbids into the file that forbids them.
  const probes: readonly (readonly [string, string])[] = [
    ['windows-absolute-path', 'F' + ':' + '\\' + ['work', 'plan'].join('\\')],
    ['windows-absolute-path', 'D' + ':' + '/' + 'projects'],
    ['user-home-directory', '/' + 'Users' + '/' + 'someone' + '/repo'],
    // A backslash home directory is caught by the drive rule; the home rule is
    // for the forms that carry no drive letter. Either name is a pass, so the
    // probe asserts the one that actually fires.
    ['windows-absolute-path', 'C' + ':' + '\\' + 'Users' + '\\' + 'someone'],
    ['tilde-home-directory', '~' + '/' + '.dsh' + '/profiles/web'],
  ]
  for (const [expected, probe] of probes) {
    const caught = RULES.filter(([, pattern]) => pattern.test(probe)).map(([name]) => name)
    assert.ok(caught.includes(expected), `${probe} should be caught as ${expected}, caught as [${caught.join(', ')}]`)
  }

  // And the ordinary prose a README is full of must not be caught, or the rule
  // would be turned off within a week.
  const innocent = [
    'https://github.com/chen8923/dsh-task-progress',
    'uses: actions/checkout@v7',
    'dsh plugin --profile web add dsh-task-progress',
    'the value is 10:30 and the ratio is 3:2',
    'node "$DSH_PROGRESS_CLI" emit --task build',
    'a note about the C: drive, without a path after it',
  ]
  for (const line of innocent) {
    const caught = RULES.filter(([, pattern]) => pattern.test(line)).map(([name]) => name)
    assert.deepEqual(caught, [], `${line} must not be flagged (flagged as [${caught.join(', ')}])`)
  }
})
