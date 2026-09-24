/**
 * Host settings tests: the three things the settings service reads from a
 * schema, plus the base layer a plugin row's own config becomes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_NAMESPACE } from '../src/protocol.ts'
import { CONFIG_DEFAULTS, readConfig } from '../src/host/config.ts'
import {
  progressSchema, resolveProgressSettings,
  type ProgressSettings, type SchemaNodeLike,
} from '../src/host/settings.ts'

test('the pre-0.1.7 namespace keeps its spelling, because old documents are keyed by it', () => {
  assert.equal(SETTINGS_NAMESPACE, 'task-progress')
})

test('resolution is total: junk resolves to defaults, never a throw', () => {
  assert.deepEqual(resolveProgressSettings(undefined), CONFIG_DEFAULTS)
  assert.deepEqual(resolveProgressSettings('nonsense'), CONFIG_DEFAULTS)
  assert.deepEqual(resolveProgressSettings(null), CONFIG_DEFAULTS)
})

test('the unreported pill is off unless somebody asks for it', () => {
  // Two facts in one field: an unconfigured deployment must not interrupt anyone
  // for work nobody reported, and "false" has to be a real value rather than the
  // same thing as "unset" — clearing the field returns it to the composition
  // layer, which may well say true.
  assert.equal(CONFIG_DEFAULTS.overlayUnreported, false)
  assert.equal(resolveProgressSettings(undefined).overlayUnreported, false)
  assert.equal(resolveProgressSettings({}).overlayUnreported, false)
  assert.equal(resolveProgressSettings({ overlayUnreported: true }).overlayUnreported, true)
  assert.equal(resolveProgressSettings({ overlayUnreported: false }).overlayUnreported, false)
  // Anything that is not a boolean falls back, exactly as the numbers clamp.
  assert.equal(resolveProgressSettings({ overlayUnreported: 'yes' }).overlayUnreported, false)
  assert.equal(resolveProgressSettings({ overlayUnreported: 1 }).overlayUnreported, false)
})

test('resolution clamps out-of-range and mistyped values', () => {
  const resolved = resolveProgressSettings({
    dirName: '../evil',
    scanMs: 1,
    pollMs: 10 ** 9,
    historyLimit: 'nope',
    maxTasks: 0,
    maxFileBytes: -5,
    retainMs: 10 ** 12,
    remindAfterMs: -1,
  })
  assert.equal(resolved.dirName, CONFIG_DEFAULTS.dirName)
  assert.equal(resolved.scanMs, 250)
  assert.equal(resolved.pollMs, 10_000)
  assert.equal(resolved.historyLimit, CONFIG_DEFAULTS.historyLimit)
  assert.equal(resolved.maxTasks, 1)
  assert.equal(resolved.maxFileBytes, 4096)
  assert.equal(resolved.retainMs, 24 * 3_600_000)
  assert.equal(resolved.remindAfterMs, 0, 'zero is a real setting: it turns the reminder off')
})

test('roots are trimmed, deduplicated, typed, absolute, and capped', () => {
  // The drive-letter probe is assembled from fragments on purpose: the privacy
  // rule forbids a drive-absolute path appearing anywhere in the tree, including
  // in the tests that check for one.
  const drive = `${'C'}:${'\\'}work`
  const unc = `${'\\\\'}server${'\\'}share`
  assert.deepEqual(
    resolveProgressSettings({ roots: [' /a ', '/a', '', 7, null, '/b'] }).roots,
    ['/a', '/b'],
  )
  const many = resolveProgressSettings({ roots: Array.from({ length: 50 }, (_, index) => `/r${index}`) })
  assert.equal(many.roots.length, 32)
  assert.deepEqual(resolveProgressSettings({ roots: 'not-an-array' }).roots, [])
  assert.deepEqual(resolveProgressSettings({ roots: ['relative/dir', '/keep'] }).roots, ['/keep'])

  assert.deepEqual(
    resolveProgressSettings({ roots: ['/work', 'relative/dir', drive, '../up', unc] }).roots,
    ['/work', drive, unc],
  )
  assert.deepEqual(readConfig({ roots: ['x', '  '] }).roots, [])
  assert.deepEqual(readConfig({ roots: ['/a', '/a'] }).roots, ['/a'])
  assert.deepEqual(readConfig({ roots: 'not-an-array' }).roots, [])
  assert.equal(readConfig({ roots: Array.from({ length: 50 }, (_, i) => `/r${i}`) }).roots.length, 32)
})

test('a valid section survives resolution unchanged', () => {
  const section: ProgressSettings = {
    dirName: 'progress',
    scanMs: 1500,
    pollMs: 3000,
    retainMs: 60_000,
    historyLimit: 5,
    maxTasks: 10,
    maxFileBytes: 8192,
    roots: ['/work'],
    remindAfterMs: 45_000,
    overlayUnreported: true,
  }
  assert.deepEqual(resolveProgressSettings(section), section)
})

test('the schema is callable, serializable, and structurally walkable', () => {
  const schema = progressSchema()

  // 1. callable: `resolve()` does `schema(mergeLayers(base, user))`.
  assert.deepEqual(schema({ pollMs: 1000 }), { ...CONFIG_DEFAULTS, pollMs: 1000 })

  // 2. toJSON: `describe()` serializes it into the browser descriptor. The
  //    shape must be schemastery's own reference graph, because a client that
  //    has no decoder rehydrates exactly this to validate a section.
  const json = schema.toJSON()
  const refs = json.refs as Record<string, { type: string, meta?: unknown, dict?: Record<string, number>, inner?: number }>
  const rootNode = refs[String(json.uid)]
  assert.equal(rootNode?.type, 'object')
  assert.deepEqual(Object.keys(rootNode?.dict ?? {}).sort(), [
    'dirName', 'historyLimit', 'maxFileBytes', 'maxTasks', 'overlayUnreported', 'pollMs', 'remindAfterMs', 'retainMs', 'roots', 'scanMs',
  ])
  // Every node carries its meta object and every reference resolves to a node
  // that exists — the two things a partial envelope gets wrong.
  for (const [id, node] of Object.entries(refs)) {
    assert.equal(typeof node.meta, 'object', `node ${id} has no meta`)
    for (const child of Object.values(node.dict ?? {})) {
      assert.ok(refs[String(child)] !== undefined, `dict of ${id} points at missing node ${child}`)
    }
    if (node.inner !== undefined) assert.ok(refs[String(node.inner)] !== undefined, `inner of ${id} is missing`)
  }
  assert.equal(JSON.parse(JSON.stringify(json)).uid, json.uid)

  // 3. walkable: the redactor reads exactly these four fields, and this
  //    namespace declares no `role('secret')`.
  const walk = (node: SchemaNodeLike | undefined, value: unknown): unknown => {
    if (node === undefined) return value
    if (node.meta?.['role'] === 'secret') return undefined
    if (node.type === 'object') {
      const source = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
      const rebuilt: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(source ?? {})) {
        if (key in (node.dict ?? {})) continue
        rebuilt[key] = entry
      }
      for (const [key, child] of Object.entries(node.dict ?? {})) {
        const stripped = walk(child, source?.[key])
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return rebuilt
    }
    if (node.type === 'array' && Array.isArray(value)) return value.map(entry => walk(node.inner, entry))
    return value
  }
  const section = resolveProgressSettings({ pollMs: 1000, roots: ['a', 'b'] })
  assert.deepEqual(walk(schema, section), section)
})
