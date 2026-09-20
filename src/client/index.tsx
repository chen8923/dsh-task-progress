/**
 * Browser half of `dsh-task-progress`.
 *
 * Two surfaces over one store, so neither knows the other exists:
 *
 * - a **floating overlay** in `shell.overlay` (the frame-wide, click-through
 *   layer) that appears only while tasks are running, and
 * - a **right-sidebar tab** that lists the session's tasks, finished ones
 *   included.
 *
 * Both read the same polled document through `progressStore`, which is why
 * adding or removing a surface never touches the data path.
 *
 * @module dsh-task-progress/client
 */

import { createElement } from 'react'
import { ProgressBody } from './ProgressBody.tsx'
import { ProgressOverlay } from './ProgressOverlay.tsx'
import { TAB_KIND, taskProgressDefinition } from './definition.tsx'
import { en, NS, zh, type Translate } from './locales.ts'
import { progressStore } from './store.ts'
import { injectStyles } from './styles.ts'

// Styles are the module body's side effect, which is where the loader looks for
// the sheet it claims for this plugin id.
injectStyles()

/** This overlay entry's id inside the frame-wide layer. */
const OVERLAY_ID = 'task-progress'

/** Required services: the slot registry, copy, and the right sidebar's tab registry. */
export const inject = ['slots', 'locale', 'sidebarRightTabs'] as const

/** Minimal structural view of the client context this plugin uses. */
interface ClientContextLike {
  effect(callback: () => void | (() => void), label: string): void
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
 * Client plugin body: dictionaries, the poll loop, the overlay, and the tab.
 * @param ctx - client root context carrying the slot, locale, and tab registries.
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
}
