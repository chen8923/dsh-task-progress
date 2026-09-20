/**
 * Browser half of `dsh-task-progress`.
 *
 * Three surfaces over one store, so none of them knows the others exist:
 *
 * - a **floating overlay** in `shell.overlay` (the frame-wide, click-through
 *   layer) that appears only while tasks are running,
 * - a **right-sidebar tab** that lists the session's tasks, finished ones
 *   included, and
 * - a **settings card** in `settings.plugin.item`, keyed by the settings
 *   namespace this plugin registers on the Host.
 *
 * The first two read the same polled document through `progressStore`; the card
 * reads its own namespace scope through `settingsScope`, which the settings
 * transport binds on this plugin's fiber. Adding or removing a surface never
 * touches the data path.
 *
 * @module dsh-task-progress/client
 */

import { createElement } from 'react'
import { SETTINGS_NAMESPACE } from '../protocol.ts'
import { ProgressBody } from './ProgressBody.tsx'
import { ProgressOverlay } from './ProgressOverlay.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import { TAB_KIND, taskProgressDefinition } from './definition.tsx'
import { en, NS, zh, type Translate } from './locales.ts'
import { createSettingsForm, decodeSettingsSection, listField, numberField, type FieldSpec, type SettingsForm, type SettingsSection } from './settings-form.ts'
import { progressStore } from './store.ts'
import { injectStyles } from './styles.ts'

// Styles are the module body's side effect, which is where the loader looks for
// the sheet it claims for this plugin id.
injectStyles()

/** This overlay entry's id inside the frame-wide layer. */
const OVERLAY_ID = 'task-progress'

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
]

/** The slice of the client settings binder this plugin uses. */
interface SettingsScopeBinderLike {
  /**
   * Bind this namespace's scope; the disposer rides the calling fiber.
   *
   * `decode` is required in practice, not optional polish: see
   * `decodeSettingsSection`.
   */
  bind<T>(spec: {
    readonly namespace: string
    readonly decode?: (section: unknown) => T | undefined
  }): Parameters<typeof createSettingsForm>[0]
}

/** Minimal structural view of the client context this plugin uses. */
interface ClientContextLike {
  effect(callback: () => void | (() => void), label: string): void
  /** Cordis inject: runs the callback once the named client service exists. */
  inject(
    deps: readonly string[],
    callback: (scope: ClientContextLike & { readonly settingsScope: SettingsScopeBinderLike }) => void,
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
 * @param ctx - client root context carrying the slot, locale, tab, and settings registries.
 */
export function apply(ctx: ClientContextLike): void {
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh: { ...zh }, en: { ...en } }), 'task-progress: dictionaries')
  ctx.effect(() => progressStore.start(), 'task-progress: state polling')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    // A list slot: a fresh `id` is added beside the shipped entries. The layer
    // is click-through, and the component opts back in on its own boxes only.
    { name: 'shell.overlay', id: OVERLAY_ID, order: 60, label: () => t('overlay.label') },
    (props: Record<string, unknown>) => createElement(ProgressOverlay, { ...props, t }),
  )), 'task-progress: floating overlay')

  ctx.effect(() => ctx.sidebarRightTabs.register(taskProgressDefinition(t)), 'task-progress: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_KIND, locale: NS },
    ProgressBody,
  )), 'task-progress: tab body')

  // The settings namespace this Host half registered. Binding adds no wire read
  // of its own — the scope derives from the shared describe mirror. The binder
  // is optional: a deployment with no settings surface still gets both panels,
  // it just has no page to edit the knobs from.
  ctx.inject(['settingsScope'], (withSettings) => {
    const scope = withSettings.settingsScope.bind<SettingsSection>({
      namespace: SETTINGS_NAMESPACE,
      // See decodeSettingsSection: this is what keeps the card independent of
      // schemastery rehydration on the client.
      decode: decodeSettingsSection,
    })
    const form: SettingsForm = createSettingsForm(scope, SETTINGS_FIELDS)
    withSettings.effect(() => withSettings.slots.inject('settings.plugin.item', () => withSettings.slots.register(
      // Keyed by the namespace: that key is the whole handshake between the Host
      // registration and this card. It must equal the namespace exactly.
      { name: 'settings.plugin.item', key: SETTINGS_NAMESPACE, locale: NS, inject: () => form },
      SettingsCard,
    )), 'task-progress: settings card')
  })
}
