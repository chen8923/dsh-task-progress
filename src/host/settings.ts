/**
 * This plugin's settings: the schema its entry exports, and the resolver behind it.
 *
 * Since DSH 0.1.7 there is no registration call. A plugin's settings surface is
 * derived from the `Config` schema its own entry exports: the settings domain asks
 * every active entry for a schema, skips the ones whose JSON carries no editable
 * field, and builds the form from the rest (`packages/settings/settings/src/index.ts`,
 * `describe()`). The namespace is therefore the **entry's own id**
 * (`dsh-task-progress`), and the browser half reads the form through
 * `ctx.configForms` under that id.
 *
 * This module is the Host half of that arrangement: {@link progressSchema} is what
 * `src/host/index.ts` exports as `Config`, and {@link resolveProgressSettings} is
 * what normalizes whatever the composition and the user layer hand over.
 *
 * **Why the schema is hand-rolled.** schemastery is not resolvable from a plugin
 * installed into a profile (DSH lives in its own checkout; only plugins live beside
 * the profile), so depending on it would mean a bundled copy or a peer a third-party
 * install cannot satisfy. The service uses exactly three things from a schema, so
 * this module provides exactly those:
 *
 * 1. it is **callable** — the settings domain merges the layers and takes the return
 *    value as the namespace's value;
 * 2. it carries **`toJSON()`** — `describe()` serializes it into the descriptor the
 *    browser receives, and the editable-field rule walks that JSON;
 * 3. it is **structurally walkable** — `redactSecrets` reads `type`, `meta.role`,
 *    `dict`, and `inner` to find `role('secret')` fields. This namespace declares
 *    none.
 *
 * It also carries the **Standard Schema** face (`~standard`) that cordis resolves a
 * config through before the entry is allowed to run at all — see the note beside
 * `vendor`, where the value of one string decides whether a settings change is
 * applied or silently dropped.
 *
 * Nothing else on a schema instance is consulted, and this module's tests pin all
 * three. Normalization is total: a hand-edited config is clamped into range rather
 * than refused, so a typo can never strand a running plugin.
 *
 * @module dsh-task-progress/host/settings
 */

import { CONFIG_DEFAULTS, absoluteRoots, type TaskProgressConfig } from './config.ts'

/** The settings this namespace resolves to; identical to the plugin row's config. */
export type ProgressSettings = TaskProgressConfig

/** The structural slice of a schemastery node the settings service reads. */
export interface SchemaNodeLike {
  /** Schemastery type tag: `object`, `number`, `string`, `array`, … */
  readonly type: string
  /** Node metadata; `role: 'secret'` is what the redactor looks for. */
  readonly meta?: Readonly<Record<string, unknown>>
  /** `object` properties by name. */
  readonly dict?: Readonly<Record<string, SchemaNodeLike>>
  /** `dict`/`array` element schema. */
  readonly inner?: SchemaNodeLike
}

/** A schemastery-compatible schema: callable, serializable, walkable. */
export interface SchemaLike<T> extends SchemaNodeLike {
  /** Resolve and validate one merged candidate value. */
  (candidate: unknown): T
  /** Serialize for a configuration surface's descriptor. */
  toJSON(): SchemaNodeLike
}

/** A bounded integer from an unknown value, falling back rather than throwing. */
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** A single safe path segment. */
const DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/**
 * Resolve one candidate section into a complete, valid value.
 *
 * Total by design: every field falls back or clamps, so the only way to be
 * wrong is to be out of range, never to be unusable.
 * @param candidate - merged `base` and user layers, of unknown shape.
 * @returns the resolved settings.
 */
export function resolveProgressSettings(candidate: unknown): ProgressSettings {
  const record = typeof candidate === 'object' && candidate !== null
    ? candidate as Record<string, unknown>
    : {}
  const dirName = typeof record['dirName'] === 'string' && DIR_NAME_RE.test(record['dirName'])
    ? record['dirName']
    : CONFIG_DEFAULTS.dirName
  return {
    dirName,
    scanMs: integer(record['scanMs'], CONFIG_DEFAULTS.scanMs, 250, 60_000),
    pollMs: integer(record['pollMs'], CONFIG_DEFAULTS.pollMs, 500, 10_000),
    retainMs: integer(record['retainMs'], CONFIG_DEFAULTS.retainMs, 0, 24 * 3_600_000),
    historyLimit: integer(record['historyLimit'], CONFIG_DEFAULTS.historyLimit, 1, 200),
    maxTasks: integer(record['maxTasks'], CONFIG_DEFAULTS.maxTasks, 1, 2000),
    maxFileBytes: integer(record['maxFileBytes'], CONFIG_DEFAULTS.maxFileBytes, 4096, 8 * 1024 * 1024),
    roots: absoluteRoots(record['roots']),
    remindAfterMs: integer(record['remindAfterMs'], CONFIG_DEFAULTS.remindAfterMs, 0, 3_600_000),
    // A toggle is the one field where "unset" and "off" are different answers, so
    // anything that is not a boolean resolves to the default rather than to a
    // truthy reading of it.
    overlayUnreported: typeof record['overlayUnreported'] === 'boolean'
      ? record['overlayUnreported']
      : CONFIG_DEFAULTS.overlayUnreported,
  }
}

/** One numeric field node. */
function numberNode(defaultValue: number, min: number, max: number, description: string): SchemaNodeLike {
  return { type: 'number', meta: { default: defaultValue, min, max, description } }
}

/** The nodes describing this namespace's value, in field order. */
function fieldNodes(): Record<string, SchemaNodeLike> {
  return {
    dirName: { type: 'string', meta: { default: CONFIG_DEFAULTS.dirName, description: 'Directory under each root that holds progress files.' } },
    scanMs: numberNode(CONFIG_DEFAULTS.scanMs, 250, 60_000, 'How often the Host half re-reads changed progress files.'),
    pollMs: numberNode(CONFIG_DEFAULTS.pollMs, 500, 10_000, 'Poll interval advertised to the browser half.'),
    retainMs: numberNode(CONFIG_DEFAULTS.retainMs, 0, 24 * 3_600_000, 'How long a finished task stays visible.'),
    historyLimit: numberNode(CONFIG_DEFAULTS.historyLimit, 1, 200, 'Distinct messages kept per task.'),
    maxTasks: numberNode(CONFIG_DEFAULTS.maxTasks, 1, 2000, 'Cap on tasks in one state document.'),
    maxFileBytes: numberNode(CONFIG_DEFAULTS.maxFileBytes, 4096, 8 * 1024 * 1024, 'Bytes read from the tail of one progress file.'),
    roots: { type: 'array', inner: { type: 'string', meta: {} }, meta: { default: [], description: 'Extra absolute roots to discover progress directories under.' } },
    remindAfterMs: numberNode(CONFIG_DEFAULTS.remindAfterMs, 0, 3_600_000, 'How long a background job may run silently before the model is told once.'),
    overlayUnreported: {
      type: 'boolean',
      meta: {
        default: CONFIG_DEFAULTS.overlayUnreported,
        description: 'Whether the floating panel may appear for a background job whose script reports nothing.',
      },
    },
  }
}

/** One node of schemastery's serialization graph. */
interface EnvelopeNode {
  readonly type: string
  readonly meta: Readonly<Record<string, unknown>>
  readonly dict?: Readonly<Record<string, number>>
  readonly inner?: number
}

/** The serialized graph: a root id plus every node, referenced by id. */
export interface SchemaEnvelope {
  /** Id of the root node inside `refs`. */
  readonly uid: number
  /** Every node, keyed by its numeric id. */
  readonly refs: Readonly<Record<string, EnvelopeNode>>
}

/**
 * Serialize the field nodes the way schemastery does.
 *
 * This is not cosmetic. `@deepseek-ai/schemastery`'s own `toJSON()` emits a
 * *reference graph* — `{ uid, refs: { id: node } }` where a node's `dict` and
 * `inner` hold child **ids**, and every node carries a `meta` object — and its
 * constructor rehydrates exactly that shape. A hand-built envelope of inline
 * nested nodes rehydrates into a partially-undefined schema and then throws
 * while resolving, which is what a browser consumer hits when it validates a
 * section against the descriptor we sent.
 * @param fields - the live field nodes, sharing structure with the live schema.
 * @returns the envelope to publish in a descriptor.
 */
function envelopeOf(fields: Record<string, SchemaNodeLike>): SchemaEnvelope {
  const refs: Record<string, EnvelopeNode> = {}
  let nextId = 0
  const put = (node: EnvelopeNode): number => {
    nextId += 1
    refs[String(nextId)] = node
    return nextId
  }
  const dict: Record<string, number> = {}
  for (const [field, node] of Object.entries(fields)) {
    if (node.type === 'array') {
      // The element schema is its own node, registered once and referenced by id.
      const inner = put({ type: node.inner?.type ?? 'any', meta: node.inner?.meta ?? {} })
      dict[field] = put({ type: node.type, meta: node.meta ?? {}, inner })
      continue
    }
    dict[field] = put({ type: node.type, meta: node.meta ?? {} })
  }
  const uid = put({ type: 'object', meta: { default: {}, volatile: true }, dict })
  return { uid, refs }
}

/**
 * Build the namespace schema.
 *
 * The returned object is one value serving four readers: the settings service
 * calls it to resolve a section, serializes it with `toJSON()` for the browser
 * descriptor, walks `type`/`meta`/`dict`/`inner` to redact secrets (this
 * namespace declares none), and — as the plugin's exported `Config` — is what
 * DSH's settings domain reads to decide whether this entry has an editable form
 * at all.
 *
 * That last reader is why `volatile` is not decoration. Since 0.1.7 the settings
 * page is built from **each plugin entry's own `Config`** and keeps only the
 * fields under a `meta.volatile` node (`settings/src/schema.ts:volatileForm`);
 * an entry with no volatile field is skipped entirely, with no card and no error
 * — which is exactly how this plugin's card disappeared twice.
 * @returns a callable, serializable, walkable schema node for this namespace.
 */
export function progressSchema(): SchemaLike<ProgressSettings> {
  const fields = fieldNodes()
  const schema = ((candidate: unknown) => resolveProgressSettings(candidate)) as SchemaLike<ProgressSettings>
  Object.assign(schema, { type: 'object', meta: { default: {}, volatile: true }, dict: fields })
  // cordis validates a plugin's configuration through the Standard Schema
  // protocol before `apply` ever runs — `fiber.ts:resolveConfig` is literally
  // `runtime.Config['~standard'].validate(raw)`. A schema without it makes the
  // loader throw `Cannot read properties of undefined (reading 'validate')`, and
  // a plugin whose config cannot resolve never loads at all: no route, no
  // environment, no panels, and nothing written where a reader would look. It
  // cost this file two rounds of "the overlay disappeared"; the contract test
  // below now pins it.
  Object.assign(schema, {
    '~standard': {
      version: 1,
      // NOT 'schemastery', and this string is load-bearing rather than decorative.
      // cordis asks this face before it will hand the entry a config at all, and the
      // plugin loader only treats a `meta.volatile` field as hot-swappable when the
      // vendor says schemastery — which is exactly why a settings change here goes
      // through a full re-apply and therefore takes effect. Claim that vendor and the
      // loader takes the volatile path instead, finds no `Volatile` reference in this
      // plain object, and drops every settings edit **silently**.
      // `test/settings.test.ts` pins the string.
      vendor: 'dsh-task-progress',
      // The resolver is total by construction (it clamps a hand-edited document
      // rather than refusing it), so validation cannot report issues.
      validate: (value: unknown) => ({ value: resolveProgressSettings(value) }),
    },
  })
  schema.toJSON = () => envelopeOf(fields)
  return schema
}
