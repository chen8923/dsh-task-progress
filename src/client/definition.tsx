/**
 * The sidebar tab *type*: what a `task-progress` tab is.
 *
 * Stage one of the documented two-stage registration — the type goes into
 * `ctx.sidebarRightTabs`, and the body goes into the keyed
 * `sidebar.right.pane.tab` seat under this type's `id`. This type claims no
 * address (it is a page, like the artifacts tab): it lists what the Host half
 * currently sees for its session, so there is nothing to open it *at*.
 *
 * @module dsh-task-progress/client/definition
 */

import type { ReactNode } from 'react'
import type { Translate } from './locales.ts'

/** This tab kind, and the key its body registers under. */
export const TAB_KIND = 'task-progress'

/** Icon props as the sidebar's guide capsule draws them. */
interface GlyphProps {
  readonly size?: number
  readonly className?: string
}

/** Three rising bars: "work in progress", drawn inline so no icon package is needed. */
function ProgressGlyph({ size = 16, className }: GlyphProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <rect x="2" y="9.5" width="3" height="4.5" rx="1" fill="currentColor" />
      <rect x="6.5" y="6" width="3" height="8" rx="1" fill="currentColor" opacity="0.75" />
      <rect x="11" y="2.5" width="3" height="11.5" rx="1" fill="currentColor" opacity="0.5" />
    </svg>
  )
}

/** One guide capsule the sidebar offers for opening this type. */
export interface TabGuideEntry {
  readonly order: number
  readonly title: () => string
  readonly description: () => string
  readonly icon: (props: GlyphProps) => ReactNode
}

/** The tab registry's definition shape, structurally. */
export interface TabDefinition {
  readonly id: string
  readonly kind: string
  readonly title: (address?: string) => string
  readonly guide: readonly TabGuideEntry[]
}

/**
 * Build this plugin's tab definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function taskProgressDefinition(t: Translate): TabDefinition {
  return {
    id: TAB_KIND,
    kind: TAB_KIND,
    title: () => t('tab.title'),
    guide: [{
      order: 60,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: ProgressGlyph,
    }],
  }
}
