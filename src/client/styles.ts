/**
 * The plugin's stylesheet, injected once as a `<style>` element.
 *
 * A standalone client bundle has no CSS-module toolchain behind it and the
 * loader transports no stylesheets, so the module body injects its own `<style>`
 * (which the module system then claims for this plugin id). Every selector is
 * `dtp-` prefixed, and the only shared surface used is the theme's custom
 * properties (`--dsw-alias-*`, and the `--ds-font-family-code` stack) — the same
 * intentional seam the shipped client plugins use, which is what makes this
 * panel follow light/dark themes for free.
 *
 * The settings card is the one block with a counterpart in DSH itself, and it is
 * held to that counterpart's values rather than to this file's older tastes; see
 * the comment above `.dtp-set`.
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

/* A row whose ending came from the job registry rather than from the script.
   Muted when the process exited on its own — an ordinary finish the producer
   simply did not get to write down — and in the attention colour when it was
   killed or broke, because then the row ends somewhere the producer never
   agreed to. */
.dtp-ended { color: var(--dsw-alias-label-tertiary, #8b8b95); }

.dtp-ended[data-state='cancelled'],
.dtp-ended[data-state='failed'] { color: var(--dsw-alias-state-warn-primary, #d29922); }

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

.dtp-emptyRunning { color: var(--dsw-alias-state-warn-primary, #d29922); }

.dtp-code {
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.2));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.08));
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 16px;
  white-space: pre;
}

.dtp-note {
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 11px;
  line-height: 16px;
}

/* ---- background jobs that report nothing ---- */

.dtp-jobs {
  border-bottom: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.2));
}

.dtp-jobsHead {
  padding: 8px 12px 4px;
  color: var(--dsw-alias-state-warn-primary, #d29922);
  font-size: 11px;
  font-weight: 600;
}

.dtp-job {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 12px;
  list-style: none;
}

/* The observed output tail: what the job is printing right now.
   A full-width basis puts it on its own line under the label and the clock,
   which is what the wrapped row is for. */
.dtp-jobTail {
  flex: 1 0 100%;
  max-height: 54px;
  margin: 0;
  padding: 6px 8px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-secondary, #a9a9b3);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 15px;
  white-space: pre;
  text-overflow: ellipsis;
}

.dtp-jobGap {
  flex: 1 0 100%;
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 10px;
}

.dtp-jobLabel {
  overflow: hidden;
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dtp-jobMeta {
  flex: none;
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 11px;
}

.dtp-jobState {
  margin-left: 6px;
  color: var(--dsw-alias-state-warn-primary, #d29922);
}

.dtp-jobsNote {
  margin: 0;
  padding: 0 12px 8px;
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 11px;
  line-height: 16px;
}

/* The pill when the only live work is unreported: same shape, warning colour,
   because "nothing is running" and "something is running unseen" must not look
   identical — telling those two apart is the whole point of the row group. */
.dtp-pillWarn { color: var(--dsw-alias-state-warn-primary, #d29922); }

/* ---- settings card, inside DSH's plugin configuration section ----

   The chrome is transcribed value-for-value from the cards DSH ships into this
   same slot (packages/client/ui-settings-plugins, PluginCard.module.css and
   fields.module.css, at DSH 0.1.5-rc.2), because a plugin living outside
   the DSH repository cannot import them: the browser half may only require the
   platform words the shell seeds, and the UI primitives are not among them.
   So this card is not "inspired by" its neighbours, it paints with their
   tokens, their metrics, and their states — including the ones that only show
   up on hover, on focus, and while a card is open. A row that looks like its
   neighbours but fills, borders, or sizes itself differently is the defect this
   block exists to remove: the theme tokens are the shared surface, and nothing
   else may stand in for them.

   Two deliberate departures, each marked below:
   - error text uses the theme's state-error token, because the
     --dsw-alias-label-error the shipped sheet names is not defined by this
     theme, so referencing it paints nothing at all;
   - the roots list is a textarea, a control this section has no other instance
     of: it is styled as a shipped input with room for several lines. */

.dtp-set {
  display: flex;
  flex-direction: column;
  list-style: none;
  margin: 0;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color 0.16s, background 0.16s;
}

.dtp-set:hover { border-color: var(--dsw-alias-label-dimmed); }

/* An open card reads as the one being worked on, not merely taller. */
.dtp-setOpen {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}

/* The header is the disclosure toggle, exactly as the shipped cards are: the
   whole row is the button, so the gesture is the same everywhere. It carries no
   hover fill of its own — the card's border is what answers the pointer. */
.dtp-setHeader {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  appearance: none;
  padding: 14px 16px;
  border: 0;
  border-radius: 12px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.dtp-setHeader:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}

.dtp-setHeadText {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dtp-setChevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 0.16s;
}

.dtp-setChevronOpen { transform: rotate(180deg); }

.dtp-setBody {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding-bottom: 8px;
}

.dtp-setTitle {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}

.dtp-setDescription {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}

/* Fields the way the shipped cards lay their own out: each one pads itself and
   a hairline separates it from the one above, so the body needs no gap. */
.dtp-setFields {
  display: flex;
  flex-direction: column;
}

.dtp-setField {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}

.dtp-setField + .dtp-setField { border-top: 0.5px solid var(--dsw-alias-border-l2); }

.dtp-setLabelRow {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dtp-setLabel {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

/* The unsaved marker the collapsed header carries, and the per-field override
   badge — the same shape, two different facts. Geometry and palette are the
   shipped Tag at its neutral tone, which is what a card in this section
   draws for both. */
.dtp-setPending,
.dtp-setOverride {
  display: inline-flex;
  flex: none;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
  white-space: nowrap;
}

/* A reset exists only where there is an override to reset, so this is a text
   control and never a bordered one. */
.dtp-setReset {
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
}

.dtp-setReset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dtp-setReset:disabled { cursor: default; }

.dtp-setInput {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
}

.dtp-setInput:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  outline: none;
}

.dtp-setInput:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

/* A departure: the shipped sheet names --dsw-alias-label-error, which this
   theme does not define — so it paints nothing there. This is the error token
   the theme does define. */
.dtp-setInput[aria-invalid] { border-color: var(--dsw-alias-state-error-primary); }

/* A checkbox: the row's own label is its accessible name, so it sits alone under
   it. Sized and tinted from the theme rather than left to the platform default,
   which is the one control that would otherwise not follow the palette. */
.dtp-setToggle {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}

.dtp-setToggle:disabled { cursor: default; }

.dtp-setTextarea {
  height: auto;
  min-height: 62px;
  padding: 8px 12px;
  resize: vertical;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}

.dtp-setHint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}

.dtp-setHintBad { color: var(--dsw-alias-state-error-primary); }

/* Right-aligned actions under a hairline, as every shipped card ends. */
.dtp-setFoot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

.dtp-setFootText {
  display: flex;
  flex: 1;
  gap: 8px;
  min-width: 0;
}

.dtp-setDiscard,
.dtp-setSave {
  appearance: none;
  padding: 5px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}

.dtp-setDiscard {
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}

.dtp-setDiscard:hover:not(:disabled) {
  border-color: var(--dsw-alias-label-dimmed);
  color: var(--dsw-alias-label-primary);
}

/* The house primary: inverted fill, not an accent colour of its own. */
.dtp-setSave {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}

.dtp-setDiscard:disabled,
.dtp-setSave:disabled { opacity: 0.4; cursor: default; }

.dtp-setDiscard:focus-visible,
.dtp-setSave:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

.dtp-setNotice {
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}

/* A namespace that accepts no writes says so once, above the fields. */
.dtp-setReadonly {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}

.dtp-setNoticeBad {
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}

@media (prefers-reduced-motion: reduce) {
  .dtp-fill { transition: none; }
  .dtp-set { transition: none; }
  .dtp-setChevron { transition: none; }
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
