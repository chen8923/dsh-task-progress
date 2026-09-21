/**
 * The settings card's chrome, pinned to the values the shipped cards use.
 *
 * This card is the only part of the plugin whose correctness lives in another
 * repository. A plugin distributed outside DSH draws into
 * `settings.plugin.item` — a slot, not a widget kit — so it cannot import the
 * components that render the cards beside it and has to reproduce their look
 * from the theme tokens. Reproducing it approximately is exactly the failure
 * that was there before: same shape, different fill, hairline border instead of
 * a visible one, a 13px name where its neighbours use 15px. Every row in that
 * list is a card; one that paints differently reads as an unconfigured row.
 *
 * The values cannot be read from DSH at test time (the DSH checkout is not this
 * package, and a machine path may not enter the tree — see `privacy.test.ts`),
 * so they are recorded here as the contract they are, taken from
 * `packages/client/ui-settings-plugins/src/client/PluginCard.module.css` and
 * `fields.module.css` at DSH 0.1.5-rc.2. When a DSH upgrade moves them, this is
 * where the difference shows up, and updating it is a decision rather than
 * drift.
 *
 * Every assertion reads one rule's own declarations, never the sheet from a
 * selector onwards: an unbounded scan happily finds the token it is looking for
 * in some later rule and passes while the rule under test is wrong — which is
 * what the first version of this file did, and what the mutation check in the
 * handover notes caught.
 *
 * @module dsh-task-progress/test/settings-chrome
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

/**
 * The card's own slice of the injected sheet: from its banner comment to the
 * motion query that follows it.
 * @returns the CSS the settings card owns.
 */
function cardSection(): string {
  const sheet = read('src/client/styles.ts')
  const start = sheet.indexOf('/* ---- settings card')
  const end = sheet.indexOf('@media (prefers-reduced-motion')
  assert.ok(
    start >= 0 && end > start,
    'the settings-card block is no longer between its banner comment and the motion query: update this test with it',
  )
  return sheet.slice(start, end)
}

/**
 * One rule's declarations, without its neighbours.
 *
 * A selector can appear twice in a sheet — once in a shared list of selectors
 * that carry common geometry, and once in the rule that finishes it. Only the
 * second is the rule this test means, so an occurrence that follows a comma is
 * skipped: asserting against the shared list would check padding while claiming
 * to check a fill, which is the same unbounded-scan mistake in a new costume.
 *
 * @param css - the slice to look in.
 * @param selector - the rule's selector, spelled exactly as the sheet writes it.
 * @returns everything between that rule's braces.
 */
function rule(css: string, selector: string): string {
  const needle = `${selector} {`
  let at = -1
  for (let found = css.indexOf(needle); found >= 0; found = css.indexOf(needle, found + 1)) {
    if (css.slice(0, found).trimEnd().endsWith(',')) continue
    at = found
    break
  }
  assert.ok(at >= 0, `the settings card has no rule of its own for ${selector}`)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  assert.ok(open >= 0 && close > open, `the rule for ${selector} is unterminated`)
  return css.slice(open + 1, close)
}

test('the card rests on the same layer, edge, and radius as the shipped cards', () => {
  const card = rule(cardSection(), '.dtp-set')
  // Three facts a user reads at a glance, and the three that were wrong: the
  // raised layer rather than the page layer, the visible hairline rather than a
  // dark-mode-thin one, and the 16px corner rather than 14px.
  assert.match(card, /background: var\(--dsw-alias-bg-layer-3\);/, 'the card does not rest on the raised layer')
  assert.match(card, /border: 0\.5px solid var\(--dsw-alias-border-l4\);/, 'the card edge is not the shipped hairline')
  assert.match(card, /border-radius: 16px;/, 'the card corner is not the shipped radius')
  assert.match(card, /transition: border-color 0\.16s, background 0\.16s;/, 'the card does not animate its edge and fill')
})

test('the card answers the pointer and opens the way its neighbours do', () => {
  const css = cardSection()
  assert.match(
    rule(css, '.dtp-set:hover'),
    /border-color: var\(--dsw-alias-label-dimmed\);/,
    'the card edge does not answer the pointer',
  )
  // An open card sinks a layer and takes the hover edge, so it reads as the one
  // being worked on rather than as merely taller.
  const open = rule(css, '.dtp-setOpen')
  assert.match(open, /background: var\(--dsw-alias-bg-layer-2\);/, 'an open card does not sink to the working layer')
  assert.match(open, /border-color: var\(--dsw-alias-label-dimmed\);/, 'an open card does not keep the active edge')
})

test('its header, fields, and actions are sized like the shipped ones', () => {
  const css = cardSection()
  // Name over description: the shipped card drops the description to 13px and
  // raises the name to 15px. Inheriting the body size made them 13px and 12px.
  assert.match(rule(css, '.dtp-setTitle'), /font-size: 15px;/, 'the card name is not the shipped size')
  assert.match(rule(css, '.dtp-setDescription'), /font-size: 13px;/, 'the card description is not the shipped size')
  assert.match(rule(css, '.dtp-setHeader'), /padding: 14px 16px;/, 'the header does not keep the shipped padding')
  // A field pads itself and is separated from the one above by a hairline, and
  // the control is the shipped input: 34px tall, 8px corner, raised fill.
  assert.match(rule(css, '.dtp-setField'), /padding: 12px 0;/, 'fields do not pad themselves as the shipped ones do')
  assert.match(
    rule(css, '.dtp-setField + .dtp-setField'),
    /border-top: 0\.5px solid var\(--dsw-alias-border-l2\);/,
    'fields are not separated by the shipped hairline',
  )
  const input = rule(css, '.dtp-setInput')
  assert.match(input, /height: 34px;/, 'the field control is not the shipped height')
  assert.match(input, /border-radius: 8px;/, 'the field control is not the shipped shape')
  assert.match(input, /background: var\(--dsw-alias-bg-layer-3\);/, 'the field control is not on the raised layer')
  // The body is ruled off from the header, the actions are ruled off from the
  // body and pushed right, and the primary action is the house inverted fill
  // rather than an accent colour of this plugin's own.
  assert.match(
    rule(css, '.dtp-setBody'),
    /border-top: 0\.5px solid var\(--dsw-alias-border-l2\);/,
    'the body is not ruled off from the header',
  )
  assert.match(rule(css, '.dtp-setFoot'), /justify-content: flex-end;/, 'the actions are not right-aligned')
  assert.match(
    rule(css, '.dtp-setSave'),
    /background: var\(--dsw-alias-label-primary\);/,
    'the primary action is not the house inverted button',
  )
})

test('the card paints with theme tokens and a foreign palette nowhere', () => {
  const card = cardSection()
  // The colour literals this block used to carry are how it drifted: a fallback
  // in the wrong theme, and a button blue nothing else in the section paints.
  // A card is themed or it is a bug, and there is no third state.
  assert.doesNotMatch(card, /#[0-9a-fA-F]{3,8}\b/, 'the card hardcodes a colour instead of naming a theme token')
  assert.doesNotMatch(card, /\brgba?\(/, 'the card hardcodes a colour instead of naming a theme token')
  assert.doesNotMatch(card, /--dsw-alias-state-business-primary/, 'the accent blue has no place in this chrome')
  // The one finding this contract records against the shipped sheet: it names a
  // token this theme does not define, so its error text paints nothing. The card
  // uses the error token that exists, which is why this assertion is here.
  assert.match(card, /--dsw-alias-state-error-primary/, 'the card has no error colour the theme actually defines')
})

test('the disclosure glyph is the shipped icon rather than a local one', () => {
  const card = read('src/client/SettingsCard.tsx')
  // The icon is a filled path on a 14px grid. A hand-drawn stroke chevron at the
  // same box size renders at a different weight, which is one more thing that
  // does not match the row beside it.
  assert.match(card, /viewBox="0 0 14 14"/, 'the chevron is no longer drawn on the shipped 14px grid')
  assert.match(card, /d="M11\.8486 5\.5/, 'the chevron is no longer the filled icon the shipped cards use')
})
