/**
 * The plugin's stylesheet, injected once as a `<style>` element.
 *
 * A standalone client bundle has no CSS-module toolchain behind it and the
 * loader transports no stylesheets, so the module body injects its own `<style>`
 * (which the module system then claims for this plugin id). Every selector is
 * `dtp-` prefixed, and the only shared surface used is the theme's `--dsw-*`
 * custom properties — the same intentional seam the shipped client plugins use,
 * which is what makes this panel follow light/dark themes for free.
 */

/** Marks the injected sheet so the module loader can attribute it to this plugin. */
const STYLE_ID = 'dsh-task-progress'

const CSS = `
.dtp-overlay {
  position: fixed;
  right: 20px;
  bottom: 96px;
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
}

.dtp-pill,
.dtp-card {
  pointer-events: auto;
}

.dtp-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 360px;
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.3));
  border-radius: 999px;
  background: var(--dsw-specific-input-major, rgba(28, 28, 32, 0.92));
  box-shadow: var(--dsw-shadow-lv3, 0 6px 20px rgba(0, 0, 0, 0.28));
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  backdrop-filter: blur(8px);
}

.dtp-pill:hover {
  border-color: var(--dsw-alias-state-business-primary, #4f8cff);
}

.dtp-pillText {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.dtp-pillTask {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dtp-card {
  display: flex;
  flex-direction: column;
  width: 360px;
  max-width: min(360px, calc(100vw - 48px));
  max-height: min(52vh, 520px);
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.3));
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, rgba(22, 22, 26, 0.96));
  box-shadow: var(--dsw-shadow-lv3, 0 10px 30px rgba(0, 0, 0, 0.35));
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-size: 12px;
  backdrop-filter: blur(10px);
}

.dtp-cardHead,
.dtp-bodyHead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.2));
}

.dtp-cardTitle,
.dtp-bodyTitle {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #e8e8ea);
}

.dtp-cardCount,
.dtp-bodyCounts {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-variant-numeric: tabular-nums;
}

.dtp-cardClose {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font: inherit;
  cursor: pointer;
}

.dtp-cardClose:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16));
  color: var(--dsw-alias-label-primary, #e8e8ea);
}

.dtp-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  list-style: none;
}

.dtp-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.dtp-rowHead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.dtp-name {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dtp-state {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16));
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  font-size: 11px;
  line-height: 16px;
}

.dtp-state[data-state='done'] { color: var(--dsw-alias-state-success-primary, #2ea043); }
.dtp-state[data-state='failed'] { color: var(--dsw-alias-state-error-primary, #e5534b); }
.dtp-state[data-state='cancelled'] { color: var(--dsw-alias-state-warn-primary, #d29922); }

.dtp-pct {
  flex: none;
  margin-left: auto;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  font-variant-numeric: tabular-nums;
}

.dtp-track {
  position: relative;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.2));
}

.dtp-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary, #4f8cff);
  transition: width 240ms ease-out;
}

.dtp-fill[data-state='done'] { background: var(--dsw-alias-state-success-primary, #2ea043); }
.dtp-fill[data-state='failed'] { background: var(--dsw-alias-state-error-primary, #e5534b); }
.dtp-fill[data-state='cancelled'] { background: var(--dsw-alias-state-warn-primary, #d29922); }

/* No percentage reported: motion says "working" without inventing a number. */
.dtp-fill[data-indeterminate] {
  width: 35% !important;
  animation: dtp-slide 1.4s ease-in-out infinite;
}

@keyframes dtp-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(320%); }
}

.dtp-msg {
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dtp-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.dtp-meta > span + span::before {
  margin-right: 10px;
  content: '·';
}

.dtp-meta [data-warn] { color: var(--dsw-alias-state-warn-primary, #d29922); }

.dtp-spinner {
  flex: none;
  width: 12px;
  height: 12px;
  border: 2px solid var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.3));
  border-top-color: var(--dsw-alias-state-business-primary, #4f8cff);
  border-radius: 50%;
  animation: dtp-spin 0.9s linear infinite;
}

@keyframes dtp-spin {
  to { transform: rotate(360deg); }
}

.dtp-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-size: 12px;
}

.dtp-body .dtp-list {
  flex: 1;
  min-height: 0;
}

.dtp-bodyFoot {
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.2));
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 11px;
}

.dtp-empty {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 14px;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
}

.dtp-emptyTitle {
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-weight: 600;
}

.dtp-code {
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.2));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.08));
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 16px;
  white-space: pre;
}

.dtp-note {
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 11px;
  line-height: 16px;
}

@media (prefers-reduced-motion: reduce) {
  .dtp-fill { transition: none; }
  .dtp-fill[data-indeterminate],
  .dtp-spinner { animation: none; }
}
`

/**
 * Inject the stylesheet once per document.
 *
 * Called from the module body so the injection happens inside the bundle
 * factory's closure, which is where the loader looks for the styles it claims.
 */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin-css', STYLE_ID)
  style.textContent = CSS
  document.head.append(style)
}
