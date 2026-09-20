/**
 * The settings card's form model.
 *
 * The shipped plugin cards build on a `CardForm` class that is private to DSH's
 * own settings package (a third-party bundle may not import it), so this is a
 * lean re-implementation of the same contract — deliberately smaller, because
 * this card edits scalars and string lists and nothing else:
 *
 * - **Staged, not live.** What the user types is held here and written only on
 *   save, so a settings write is never a side effect of typing, and what is on
 *   screen is exactly what a save would store.
 * - **Overridden means present.** A field counts as overridden when the *user
 *   layer carries it*, not when its value differs from the base: an override
 *   that happens to equal the composition base is still an override, and
 *   `reset` is what removes it.
 * - **The Host decides.** A write is confirmed by reading the section back, not
 *   predicted: a save that did not land keeps its drafts so the user can fix
 *   them instead of retyping.
 *
 * React-free on purpose: the card reads it through `useSyncExternalStore`, and
 * the tests drive it with a fake scope.
 *
 * @module dsh-task-progress/client/settings-form
 */

/** Sync state of one settings namespace, as the transport mirrors it. */
export interface ScopeSnapshotLike {
  /** `loading` until the first accepted section; `unavailable` when not served. */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted resolved value. */
  readonly value: unknown
  /** Composition layer the value was resolved over. */
  readonly base: unknown
  /** Raw user layer; a field's presence here is what marks it overridden. */
  readonly user: unknown
  /** Whether the Host document accepts writes. */
  readonly writable: boolean
}

/** The slice of the client settings scope this form uses. */
export interface SettingsScopeLike {
  getSnapshot(): ScopeSnapshotLike
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** The write one field's staged text performs on save. */
export type FieldWrite =
  | { readonly kind: 'set', readonly value: unknown }
  | { readonly kind: 'clear' }

/** How one field converts between its stored value and its draft text. */
export interface FieldSpec {
  /** Field name inside the namespace section. */
  readonly field: string
  /** Render a stored value as draft text; the empty string when there is none. */
  readonly format: (value: unknown) => string
  /** The write this draft stages, or undefined when the draft is not acceptable. */
  readonly parse: (text: string) => FieldWrite | undefined
}

/** One control as the card renders it. */
export interface FieldState {
  /** Draft text. */
  readonly text: string
  /** Whether saving would leave a user-layer entry for this field. */
  readonly overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  readonly invalid: boolean
}

/** Everything the card renders. */
export interface CardState {
  /** False while the namespace is not served to this client; the card renders nothing. */
  readonly available: boolean
  /** Whether the Host document accepts writes. */
  readonly writable: boolean
  /** Whether a save would write something. */
  readonly dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  readonly invalid: boolean
  /** Whether a save is crossing the wire. */
  readonly saving: boolean
  /** Whether the last save did not land as staged. */
  readonly failed: boolean
  /** Per-field state, keyed by field name. */
  readonly fields: Readonly<Record<string, FieldState>>
}

/** The card's actions. */
export interface FormActions {
  /** Stage draft text for one field. */
  edit(field: string, text: string): void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField(field: string): void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save(): void
  /** Drop every staged edit. */
  discard(): void
}

/** The form the card holds, plus the actions the slot entry injects. */
export interface SettingsForm extends FormActions {
  /** Current card state; the reference is stable until something changes. */
  getSnapshot(): CardState
  /** Observe card-state changes. */
  subscribe(listener: () => void): () => void
}

/** A settings section as this plugin's own scope carries it. */
export type SettingsSection = Record<string, unknown>

/**
 * Accept one section as the settings transport delivered it.
 *
 * A bound scope needs a decoder. Without one it rehydrates the descriptor's
 * serialized schema with schemastery to validate the value — a wire dependency
 * on a library this plugin deliberately does not ship, and one whose failure
 * mode is silent: an envelope the client cannot rehydrate vouches for no
 * section at all, so the scope never leaves `loading` and the card renders
 * nothing. The Host already resolved the section through the namespace's own
 * schema, so the honest decoder takes it as it stands.
 *
 * @param section - the section from the settings mirror, of unknown shape.
 * @returns the section as a plain object, or undefined when it is not one.
 */
export function decodeSettingsSection(section: unknown): SettingsSection | undefined {
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    ? section as SettingsSection
    : undefined
}

/** A whole-number field. An empty draft clears it; anything unparseable blocks the save. */
export function numberField(field: string): FieldSpec {
  return {
    field,
    format: value => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/**
 * A string list edited as one line per entry.
 * An empty box clears the field, so emptying it and saving is the same gesture
 * as resetting it.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function listField(field: string): FieldSpec {
  return {
    field,
    format: value => (Array.isArray(value) ? value.filter(entry => typeof entry === 'string').join('\n') : ''),
    parse: (text) => {
      const entries = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
      return entries.length === 0 ? { kind: 'clear' } : { kind: 'set', value: entries }
    },
  }
}

/** One staged edit. */
interface StagedEdit {
  readonly text: string
  /** True when this edit clears the field whatever text it shows. */
  readonly clear: boolean
}

/** One planned write; `run` is undefined when the draft blocks the save. */
interface PlannedWrite {
  readonly run: (() => Promise<boolean>) | undefined
}

/**
 * Create the form over one settings namespace.
 * @param scope - the bound client scope for this plugin's namespace.
 * @param specs - the fields this card edits.
 * @returns the form and its actions.
 */
export function createSettingsForm(scope: SettingsScopeLike, specs: readonly FieldSpec[]): SettingsForm {
  const byField = new Map(specs.map(spec => [spec.field, spec]))
  const staged = new Map<string, StagedEdit>()
  const listeners = new Set<() => void>()
  let saving = false
  let failed = false
  let cached: CardState | null = null

  const snapshot = (): ScopeSnapshotLike => scope.getSnapshot()
  const sectionValue = (field: string): unknown =>
    (snapshot().value as Record<string, unknown> | undefined)?.[field]
  const baseValue = (field: string): unknown =>
    (snapshot().base as Record<string, unknown> | undefined)?.[field]
  const userLayer = (): Record<string, unknown> | undefined =>
    snapshot().user as Record<string, unknown> | undefined
  const stored = (field: string): boolean => {
    const user = userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  const spec = (field: string): FieldSpec => {
    const found = byField.get(field)
    // Every call site names a field this card declared; a missing one is a
    // wiring mistake that must not degrade into a silently inert control.
    if (found === undefined) throw new Error(`settings card has no field ${field}`)
    return found
  }

  /** Every write a save would perform, in staging order. */
  const plan = (): PlannedWrite[] => {
    const planned: PlannedWrite[] = []
    for (const [field, edit] of staged) {
      if (edit.clear) {
        if (stored(field)) planned.push({ run: () => clear(field) })
        continue
      }
      if (edit.text === spec(field).format(sectionValue(field))) continue
      const write = spec(field).parse(edit.text)
      if (write === undefined) planned.push({ run: undefined })
      else if (write.kind === 'clear') planned.push({ run: () => clear(field) })
      else planned.push({ run: () => store(field, write.value) })
    }
    return planned
  }

  const clear = async (field: string): Promise<boolean> => {
    await scope.unset(field)
    return !stored(field)
  }

  const store = async (field: string, value: unknown): Promise<boolean> => {
    await scope.set(field, value)
    return userLayer()?.[field] === value
  }

  const project = (): CardState => {
    const view = snapshot()
    const planned = plan()
    const fields: Record<string, FieldState> = {}
    for (const { field } of specs) {
      const edit = staged.get(field)
      if (edit === undefined) {
        fields[field] = { text: spec(field).format(sectionValue(field)), overridden: stored(field), invalid: false }
        continue
      }
      const write = edit.clear ? { kind: 'clear' as const } : spec(field).parse(edit.text)
      fields[field] = {
        text: edit.text,
        overridden: write?.kind === 'set',
        invalid: write === undefined,
      }
    }
    return {
      available: view.status === 'ready',
      writable: view.writable,
      dirty: planned.length > 0,
      invalid: planned.some(entry => entry.run === undefined),
      saving,
      failed,
      fields,
    }
  }

  const publish = (): void => {
    cached = null
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A broken subscriber must not stop the others.
      }
    }
  }

  // The scope can move underneath a card the user is looking at (another tab, a
  // hand-edited document, a reconnect); re-project whenever it does.
  scope.subscribe(publish)

  const stage = (field: string, edit: StagedEdit): void => {
    staged.set(field, edit)
    failed = false
    publish()
  }

  const form: SettingsForm = {
    getSnapshot: () => cached ??= project(),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    edit: (field, text) => { stage(field, { text, clear: false }) },
    resetField: (field) => {
      // The draft shows what the field reverts to, so the user sees the reset
      // before saving it.
      stage(field, { text: spec(field).format(baseValue(field)), clear: true })
    },
    discard: () => {
      if (staged.size === 0 && !failed) return
      staged.clear()
      failed = false
      publish()
    },
    save: () => {
      const planned = plan()
      const writes = planned.flatMap(entry => (entry.run === undefined ? [] : [entry.run]))
      if (planned.length === 0 || saving || writes.length !== planned.length) return
      saving = true
      failed = false
      publish()
      void (async () => {
        let landed = true
        for (const write of writes) {
          try {
            landed = (await write()) && landed
          } catch {
            // A refused write (a conflict, a transport failure) is a failed
            // save: the drafts stay and the user can retry.
            landed = false
          }
        }
        if (landed) staged.clear()
        saving = false
        failed = !landed
        publish()
      })()
    },
  }
  return form
}
