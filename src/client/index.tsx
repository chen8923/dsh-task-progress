/**
 * Browser half of `dsh-task-progress`.
 *
 * Three surfaces over one store, so none of them knows the others exist:
 *
 * - a **floating overlay** in `shell.overlay` (the frame-wide, click-through
 *   layer) that appears only while tasks are running,
 * - a **right-sidebar tab** that lists the session's tasks, finished ones
 *   included, and
 * - a **settings card** on the Plugins page's `plugins.item` list, keyed by the
 *   settings namespace this plugin registers on the Host.
 *
 * The first two read the same polled document through `progressStore` and DSH's
 * client job roster through `rosterSlot`; the card reads its own namespace
 * through `ctx.configForms`, which the settings domain binds for this plugin's
 * fiber. Adding or removing a surface never touches the data path.
 *
 * Two of those seams were renamed by DSH 0.1.7 and both renames are silent:
 * `settings.plugin.item` no longer exists, and `settingsScope` is no longer a
 * service. `test/client-contract.test.ts` pins the current names, because this
 * file's mistakes do not raise — they just stop drawing.
 *
 * @module dsh-task-progress/client
 */

import { createElement } from 'react'
import { ProgressBody } from './ProgressBody.tsx'
import { ProgressOverlay } from './ProgressOverlay.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import { TAB_KIND, taskProgressDefinition } from './definition.tsx'
import { en, NS, zh, type Translate } from './locales.ts'
import { createSettingsForm, decodeSettingsSection, listField, numberField, toggleField, type FieldSpec, type SettingsForm, type SettingsSection, type SettingsScopeLike } from './settings-form.ts'
import { createRosterSlot, type JobRosterLike } from './session-hook.ts'
import { progressStore } from './store.ts'
import { injectStyles } from './styles.ts'

// Styles are the module body's side effect, which is where the loader looks for
// the sheet it claims for this plugin id.
injectStyles()

/** This overlay entry's id inside the frame-wide layer. */
const OVERLAY_ID = 'task-progress'

/**
 * This plugin entry's id — the key DSH's settings page addresses this entry by.
 *
 * It is **not** the runtime settings namespace (`SETTINGS_NAMESPACE`): since DSH
 * 0.1.7 the settings domain builds its forms from each **plugin entry** and names
 * them after `entry.options.id`, so the value here must equal the `id` this
 * package declares in `cordis.patch.yml`. `test/client-contract.test.ts` reads
 * both files and fails if they drift, because a mismatch is invisible: the form
 * simply never resolves and the card never appears.
 */
const ENTRY_ID = 'dsh-task-progress'

/** This settings card's id inside the Plugins page's item list. */
const CARD_ID = ENTRY_ID

/** Required services: slots, copy, and the right sidebar's tab registry. */
export const inject = ['slots', 'locale', 'sidebarRightTabs'] as const

/** The fields the settings card edits, in card order. */
const SETTINGS_FIELDS: readonly FieldSpec[] = [
  numberField('scanMs'),
  numberField('pollMs'),
  numberField('retainMs'),
  numberField('historyLimit'),
  numberField('maxTasks'),
  numberField('maxFileBytes'),
  listField('roots'),
  numberField('remindAfterMs'),
  toggleField('overlayUnreported'),
]

/**
 * The slice of the settings domain's `ctx.configForms` this plugin uses.
 *
 * `get` hands back the same external-store contract the card already consumes
 * (`getSnapshot` / `subscribe` / `set` / `unset`), so `createSettingsForm` binds
 * to it unchanged. `whileServed` is what ties the card to the namespace's
 * presence: a deployment whose Host half never loaded shows no card at all,
 * rather than an empty one that cannot save.
 */
interface ConfigFormsLike {
  get(namespace: string): SettingsScopeLike
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

/** Minimal structural view of the client context this plugin uses. */
interface ClientContextLike {
  effect(callback: () => void | (() => void), label: string): void
  /**
   * Cordis inject: runs the callback once the named client service exists, with
   * that service on the scope. Declared per service rather than as one bag, so
   * the callback body cannot reach for a service it did not ask for.
   */
  inject(
    deps: readonly ['jobs'],
    callback: (scope: ClientContextLike & { readonly jobs: JobRosterLike }) => void,
  ): void
  inject(
    deps: readonly ['configForms'],
    callback: (scope: ClientContextLike & { readonly configForms: ConfigFormsLike }) => void,
  ): void
  readonly locale: {
    bind(namespace: string): Translate
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  }
  readonly slots: {
    inject(name: string, callback: () => () => void): void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  readonly sidebarRightTabs: {
    register(definition: ReturnType<typeof taskProgressDefinition>): () => void
  }
}

/**
 * Client plugin body: dictionaries, the poll loop, the overlay, the tab, and the settings card.
 * @param ctx - client root context carrying the slot, locale, tab, and service registries.
 */
export function apply(ctx: ClientContextLike): void {
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh: { ...zh }, en: { ...en } }), 'task-progress: dictionaries')
  ctx.effect(() => progressStore.start(), 'task-progress: state polling')

  // DSH's own job roster, filled in when the service is there. The surfaces are
  // registered below, before this resolves, and read it through the slot — so a
  // late (or absent) `ctx.jobs` costs the unreported-job rows and nothing else.
  const rosterSlot = createRosterSlot()
  ctx.inject(['jobs'], (withJobs) => {
    rosterSlot.set(withJobs.jobs)
    withJobs.effect(() => () => { rosterSlot.set(undefined) }, 'task-progress: job roster')
  })

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    // A list slot: a fresh `id` is added beside the shipped entries. The layer
    // is click-through, and the component opts back in on its own boxes only.
    { name: 'shell.overlay', id: OVERLAY_ID, order: 60, label: () => t('overlay.label') },
    (props: Record<string, unknown>) => createElement(ProgressOverlay, { ...props, t, roster: rosterSlot }),
  )), 'task-progress: floating overlay')

  ctx.effect(() => ctx.sidebarRightTabs.register(taskProgressDefinition(t)), 'task-progress: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_KIND, locale: NS },
    (props: Record<string, unknown>) => createElement(ProgressBody, { ...props, roster: rosterSlot }),
  )), 'task-progress: tab body')

  // The settings namespace this Host half registered. DSH's settings domain owns
  // the form now (`ctx.configForms`), and the Plugins page owns the list slot
  // (`plugins.item`); the card follows the namespace, so it appears exactly when
  // the Host serves it. Nothing here is optional in a deployment that has a
  // settings surface — but one without it still gets both panels, it just has no
  // page to edit the knobs from.
  ctx.inject(['configForms'], (withForms) => {
    withForms.effect(() => {
      // Addressed by this entry's id, not by the runtime namespace: the settings
      // domain keys its forms by plugin entry (`entry.options.id`), and a key it
      // has no entry for stays `loading` forever — a missing card and nothing else.
      // See decodeSettingsSection: the Host already resolved the section through
      // the entry's own schema, so the card takes it as it stands rather than
      // re-validating a wire envelope this client cannot rehydrate.
      const form: SettingsForm = createSettingsForm(
        wrapScope(withForms.configForms.get(ENTRY_ID)),
        SETTINGS_FIELDS,
      )
      return withForms.configForms.whileServed([ENTRY_ID], () => withForms.slots.inject('plugins.item', () => withForms.slots.register(
        // `id` and `label` are the list slot's contract — a fresh id is added
        // beside the shipped entries, and the label is what a reader searches.
        { name: 'plugins.item', id: CARD_ID, order: 60, label: () => t('settings.title'), locale: NS, inject: () => form },
        SettingsCard,
      )))
    }, 'task-progress: settings card')
  })
}

/**
 * Adopt DSH's form snapshot as this card's scope.
 *
 * The two shapes agree on `status` / `value` / `base` / `user`, but the domain's
 * `value` is the section the settings transport already validated against the
 * namespace's Host-side schema — and re-validating it here would mean shipping
 * schemastery just to rehydrate the same descriptor. {@link decodeSettingsSection}
 * is the honest decoder: it accepts a plain object and refuses anything else, so
 * a malformed envelope leaves the card in `loading` instead of claiming a section
 * it does not have.
 *
 * @param form - the settings domain's form for this namespace.
 * @returns the scope `createSettingsForm` consumes.
 */
function wrapScope(form: SettingsScopeLike): SettingsScopeLike {
  return {
    getSnapshot: () => {
      const snapshot = form.getSnapshot()
      const decoded = decodeSettingsSection(snapshot.value)
      return decoded === undefined ? snapshot : { ...snapshot, value: decoded }
    },
    subscribe: listener => form.subscribe(listener),
    set: (field, value) => form.set(field, value),
    unset: field => form.unset(field),
  }
}
