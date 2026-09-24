/**
 * The settings form's chrome, and the card it deliberately does not draw.
 *
 * This card is the only part of the plugin whose correctness lives in another
 * repository. A plugin distributed outside DSH draws into the Plugins page's
 * `plugins.item` list — a slot, not a widget kit — so it cannot import the
 * components that render the cards beside it and has to reproduce their look
 * from the theme tokens. Reproducing it approximately is exactly the failure
 * that was there before: same shape, different fill, hairline border instead of
 * a visible one, a 13px name where its neighbours use 15px.
 *
 * **What changed, and why the file is shaped this way.** The slot's contract
 * (`slot-contract.ts`) is that the *page* draws the card — its title, its icon,
 * its description line — and asks the entry twice: `summary` for the one-liner
 * under that title, `page` for the form in the card's body. This plugin was
 * migrated to that slot without changing what it paints, so it drew a second,
 * complete card into both views: two identical boxes on the page, and — because
 * the card's own disclosure started collapsed — no form at all. That was
 * measured in the live page (`titles: 2`, `descs: 2`, one unrelated input).
 * Everything below is therefore about the **form**, and the one assertion that
 * matters most is that no card chrome of ours exists any more.
 *
 * The values cannot be read from DSH at test time (the DSH checkout is not this
 * package, and a machine path may not enter the tree — see `privacy.test.ts`),
 * so they are recorded here as the contract they are, taken from
 * `packages/client/ui-settings-plugins/src/client/fields.module.css` at DSH
 * 0.1.5-rc.2. When a DSH upgrade moves them, this is where the difference shows
 * up, and updating it is a decision rather than drift.
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
 * The form's own slice of the injected sheet: from its banner comment to the
 * motion query that follows it.
 * @returns the CSS the settings form owns.
 */
function cardSection(): string {
  const sheet = read('src/client/styles.ts')
  const start = sheet.indexOf('/* ---- settings form')
  const end = sheet.indexOf('@media (prefers-reduced-motion')
  assert.ok(
    start >= 0 && end > start,
    'the settings-form block is no longer between its banner comment and the motion query: update this test with it',
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
  assert.ok(at >= 0, `the settings form has no rule of its own for ${selector}`)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  assert.ok(open >= 0 && close > open, `the rule for ${selector} is unterminated`)
  return css.slice(open + 1, close)
}

test('the card answers the slot twice, as its contract asks, and draws no card of its own', () => {
  const card = read('src/client/SettingsCard.tsx')
  // The slot's owner props carry the view; a component that ignores it renders the
  // same thing in the one-liner position and in the page body. That is the whole
  // defect: two identical cards, and a form that never rendered because the card's
  // own disclosure started closed.
  assert.match(card, /view === 'summary'/, 'the card does not branch on the view the slot asks for')
  // The page draws the title, the description and the disclosure; ours would be a
  // second copy of each.
  assert.doesNotMatch(card, /dtp-setHeader/, 'the card still draws a header the page already draws')
  assert.doesNotMatch(card, /dtp-setHeadText|dtp-setTitle|dtp-setDescription/, 'the card still draws its own title or description')
  assert.doesNotMatch(card, /dtp-setChevron|viewBox="0 0 14 14"/, 'the card still draws a disclosure glyph of its own')
  // And the chrome that went with them is gone from the sheet rather than left dead.
  assert.doesNotMatch(cardSection(), /^\.dtp-set \{/m, 'the sheet still paints a card the page draws')
  assert.doesNotMatch(cardSection(), /^\.dtp-setOpen \{/m, 'the sheet still has an open-card state for a card it does not draw')
})

test('the form keeps the fields and the actions the shipped cards use', () => {
  const css = cardSection()
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
  // The actions are pushed right, and the primary one is the house inverted fill
  // rather than an accent colour of this plugin's own.
  assert.match(rule(css, '.dtp-setFoot'), /justify-content: flex-end;/, 'the actions are not right-aligned')
  assert.match(
    rule(css, '.dtp-setSave'),
    /background: var\(--dsw-alias-label-primary\);/,
    'the primary action is not the house inverted button',
  )
})

test('the form paints with theme tokens and a foreign palette nowhere', () => {
  const card = cardSection()
  // The colour literals this block used to carry are how it drifted: a fallback
  // in the wrong theme, and a button blue nothing else in the section paints.
  // A form is themed or it is a bug, and there is no third state.
  assert.doesNotMatch(card, /#[0-9a-fA-F]{3,8}\b/, 'the form hardcodes a colour instead of naming a theme token')
  assert.doesNotMatch(card, /\brgba?\(/, 'the form hardcodes a colour instead of naming a theme token')
  assert.doesNotMatch(card, /--dsw-alias-state-business-primary/, 'the accent blue has no place in this chrome')
  // The one finding this contract records against the shipped sheet: it names a
  // token this theme does not define, so its error text paints nothing. The form
  // uses the error token that exists, which is why this assertion is here.
  assert.match(card, /--dsw-alias-state-error-primary/, 'the form has no error colour the theme actually defines')
})
