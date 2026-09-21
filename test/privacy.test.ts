/**
 * Nothing that can be committed may name somebody's machine.
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
 * `notes/` is skipped on purpose, and it is the one directory where local paths
 * belong: it is ignored by git, so nothing there can reach the repository, and
 * a handover note that cannot say where the checkout lives is not much of a
 * handover. A file that is ignored cannot be committed without `-f`, which is a
 * deliberate act rather than the accident this test guards against.
 *
 * @module dsh-task-progress/test/privacy
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/**
 * Directories that are not the repository's own content: dependency trees, VCS
 * metadata, runtime state, and the local notes directory (see the module note).
 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-progress', 'notes'])

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

/**
 * Every file in the worktree, whatever it is.
 *
 * The text rules above filter this. The rules about *what a file is* — an image,
 * an archive, a file too big to read — need the whole list, because a guard that
 * only looks at the files it already understands cannot notice one it does not.
 * @param dir - directory to walk.
 * @param out - accumulator, so the recursion allocates one array.
 * @returns absolute file paths.
 */
function everyFile(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) everyFile(path, out)
      continue
    }
    out.push(path)
  }
  return out
}

/** Extensions that are an image, and the one format a screenshot may use. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']

/** Archive extensions: a committed archive is a thing to look at, not to skip. */
const ARCHIVE_EXTENSIONS = ['.tgz', '.tar', '.gz', '.zip', '.7z', '.rar']

/**
 * Images a human has looked at.
 *
 * A screenshot is a privacy surface no text rule can see into: a wallpaper, a
 * session title, another plugin's widget showing an account balance. So an image
 * is not something the scan waves through — it is a named exception, and the
 * diff that adds one is the moment to look at it.
 *
 * Looking at it means the pixels. This guard reads chunk types, and no chunk
 * list can tell you that a screenshot happens to show a real task name — the
 * first one did, in the task row and in the counters. Redact what the pixels
 * say, then drop the editor's metadata: saving a redacted image is exactly
 * how an XMP packet gets in, and the check below rejects it.
 */
const AUDITED_IMAGES: readonly string[] = ['docs/overlay.png']

/**
 * PNG chunks a plain screenshot produces.
 *
 * Anything outside this set is metadata: `tEXt`/`iTXt`/`zTXt` hold free-form
 * comments (the software that wrote the file, often with a path in it), `eXIf`
 * holds camera metadata including GPS, `tIME` holds a creation stamp.
 */
const PNG_ALLOWED_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'pHYs', 'cHRM', 'bKGD', 'tRNS', 'iCCP', 'sBIT', 'hIST',
])

/**
 * The chunk types one PNG contains.
 * @param path - the file to read.
 * @returns chunk type names, in file order.
 */
function pngChunks(path: string): string[] {
  const buffer = readFileSync(path)
  const chunks: string[] = []
  let at = 8
  while (at + 8 <= buffer.length && chunks.length < 64) {
    const length = buffer.readUInt32BE(at)
    const type = buffer.subarray(at + 4, at + 8).toString('latin1')
    chunks.push(type)
    if (type === 'IEND') break
    at += 12 + length
  }
  return chunks
}

/**
 * An address that names somebody.
 *
 * Written from fragments so this file does not match its own rule: it is scanned
 * by it, and a literal address here would make the suite fail on its own source.
 * GitHub's two noreply forms are the only addresses this repository may contain —
 * they name the account, not a person, which is what they are for.
 */
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const NOREPLY = /@users\.noreply\.github\.com$|^noreply@github\.com$/

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

test('every image in the tree is one a human audited', () => {
  // The text rules cannot read a picture. This is the rule that makes publishing
  // one a decision rather than an accident: the list is short, and adding to it
  // means looking at what the image shows.
  const images = everyFile(root)
    .map(file => relative(root, file).replace(/\\/g, '/'))
    .filter(name => IMAGE_EXTENSIONS.includes(name.slice(name.lastIndexOf('.')).toLowerCase()))
    .sort()
  assert.deepEqual(
    images,
    [...AUDITED_IMAGES].sort(),
    'an image is in the tree without being audited:\n'
      + '  Look at it — people, wallpapers, session titles, other plugins\' widgets, paths, balances.\n'
      + '  Then add it to AUDITED_IMAGES in this file, in the same commit, deliberately.',
  )
})

test('an image carries no metadata that names a person or a machine', () => {
  for (const name of AUDITED_IMAGES) {
    const path = join(root, name)
    assert.ok(existsSync(path), `${name} is listed as audited but is not in the tree`)
    assert.equal(name.slice(name.lastIndexOf('.')).toLowerCase(), '.png', `${name} is a format this guard cannot inspect`)
    const chunks = pngChunks(path)
    const metadata = chunks.filter(chunk => !PNG_ALLOWED_CHUNKS.has(chunk))
    assert.deepEqual(
      metadata,
      [],
      `${name} carries metadata chunks (${metadata.join(', ')}): a text comment, a camera's notes, or a timestamp. `
        + 'Strip them before committing — a screenshot needs none of it.',
    )
    // The raw bytes are checked for addresses too: a PNG with no text chunk can
    // still have a path in an auxiliary chunk this list happens to allow.
    const text = readFileSync(path, 'latin1')
    assert.doesNotMatch(text, ADDRESS, `${name} has an address-like string in its bytes`)
  }
})

test('no archive hides a file from the text rules', () => {
  const archives = everyFile(root)
    .map(file => relative(root, file).replace(/\\/g, '/'))
    .filter(name => ARCHIVE_EXTENSIONS.includes(name.slice(name.lastIndexOf('.')).toLowerCase()))
  assert.deepEqual(archives, [], 'an archive is in the tree: unpack it, or say in this test why it is safe to skip')
})

test('no file is too large to scan', () => {
  // `textFiles` skips anything over MAX_BYTES. That skip is a hole unless
  // nothing in the tree is that big: a generated file could otherwise carry
  // anything at all and no rule would look at it.
  const oversized = everyFile(root)
    .map(file => ({ name: relative(root, file).replace(/\\/g, '/'), size: statSync(file).size }))
    .filter(entry => entry.size > MAX_BYTES)
  assert.deepEqual(oversized, [], `a file grew past the scan ceiling (${MAX_BYTES} bytes):${JSON.stringify(oversized)}`)
})

test('nothing in the tree names a person', () => {
  // The rules above are about machines. This one is about people: an address is
  // the cheapest way a commit leaks who wrote it, and GitHub's noreply forms are
  // the two that do not.
  const offences: string[] = []
  for (const file of textFiles(root)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(new RegExp(ADDRESS.source, 'g'))) {
      if (NOREPLY.test(match[0])) continue
      // The matched address is not echoed: this message ends up in a public CI
      // log, and repeating it there is the leak this rule prevents.
      offences.push(`${relative(root, file).replace(/\\/g, '/')} — an address at offset ${match.index}`)
    }
  }
  assert.deepEqual(offences, [], 'an address that names a person is in the tree:\n  ' + offences.join('\n  '))

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { author?: unknown }
  assert.doesNotMatch(String(pkg.author), ADDRESS, 'package.json author carries an address')
})

test('the picture rules are not vacuous', () => {
  // A guard that inspects nothing passes for the wrong reason. These probes keep
  // the image rule honest: the chunk reader has to see the chunks a real PNG has,
  // and an unaudited name has to be visible to the rule that compares names.
  const audited = join(root, AUDITED_IMAGES[0] ?? '')
  assert.deepEqual(pngChunks(audited).slice(0, 1), ['IHDR'], 'the PNG reader no longer finds the first chunk')
  assert.ok(pngChunks(audited).includes('IEND'), 'the PNG reader no longer finds the last chunk')
  assert.equal(IMAGE_EXTENSIONS.includes('.png'), true)
  assert.equal(IMAGE_EXTENSIONS.includes('.exe'), false)
  assert.equal(ADDRESS.test('someone' + '@' + 'example.com'), true)
  assert.equal(NOREPLY.test('1234+someone' + '@' + 'users.noreply.github.com'), true)
})
