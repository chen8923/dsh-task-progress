/**
 * The settings form: this plugin's knobs, inside DSH's Plugins page.
 *
 * Registered into the Plugins page's `plugins.item` list, which is the documented
 * way a plugin distributed outside DSH's own repository reaches that page. The
 * page draws the card — its title, its icon, its description line, and the
 * disclosure that opens it — and asks this entry for two different things: a
 * one-liner under that title (`view: 'summary'`), and the body of the plugin's
 * own page (`view: 'page'`). So this module returns a line of copy for the first
 * and the form for the second, and draws **no card chrome of its own**.
 *
 * That last part is the fix, not a style preference. The plugin was migrated to
 * this slot without changing what it painted, so it drew a complete card into
 * both answers: the page showed two identical boxes, and because the card's own
 * disclosure started collapsed, the form never rendered at all. The slot's
 * contract is in DSH's `ui-plugin-manager/src/client/slot-contract.ts`, and the
 * shipped settings pages answer it the same way (`if (view === 'summary') return
 * t('description')`).
 *
 * @module dsh-task-progress/client/SettingsCard
 */

import { Fragment, useSyncExternalStore, type ReactNode } from 'react'
import type { CardState } from './settings-form.ts'
import type { Translate } from './locales.ts'

/** Every field this card can draw. */
type FieldName =
  | 'scanMs' | 'pollMs' | 'retainMs' | 'historyLimit' | 'maxTasks' | 'maxFileBytes' | 'roots'
  | 'remindAfterMs' | 'overlayUnreported'

/** One control the card draws. */
interface FieldSpec {
  /** Field name inside the settings section. */
  readonly field: FieldName
  /** Control kind: a numeric box, one line per list entry, or a checkbox. */
  readonly kind: 'number' | 'list' | 'toggle'
}

/**
 * The fields this card edits, in reading order: how often the Host half looks,
 * how often the browser asks, how much is kept — then the two knobs that are
 * about other things and cost somebody something.
 *
 * `remindAfterMs` is here rather than hidden because it spends the *model's*
 * context: a notice per silent job per step is a real cost, so the number that
 * decides when it happens has to be visible to the person paying it. `0` is a
 * legitimate value and means the reminder never happens.
 *
 * `overlayUnreported` is here for the opposite reason: the floating panel is the
 * one surface that interrupts, and opting into that for work nobody reported for
 * is a choice, not a default.
 *
 * `dirName` is deliberately absent: it is composition-level (it is part of every
 * path already written) and stays a plugin-row setting.
 */
const FIELDS: readonly FieldSpec[] = [
  { field: 'scanMs', kind: 'number' },
  { field: 'pollMs', kind: 'number' },
  { field: 'retainMs', kind: 'number' },
  { field: 'historyLimit', kind: 'number' },
  { field: 'maxTasks', kind: 'number' },
  { field: 'maxFileBytes', kind: 'number' },
  { field: 'roots', kind: 'list' },
  { field: 'remindAfterMs', kind: 'number' },
  { field: 'overlayUnreported', kind: 'toggle' },
]

/** Props the slot binds for this card. */
export interface SettingsCardProps {
  /**
   * Which of the two answers the page is asking for: the one-liner that goes
   * under the card title it drew (`summary`), or the form for the body of the
   * plugin's own page (`page`). The page has already drawn the card around both.
   */
  readonly view: 'summary' | 'page'
  /** Namespace-bound translator. */
  readonly t: Translate
  /** Subscribe to form-state changes. */
  readonly subscribe: (listener: () => void) => () => void
  /** Current form state; stable until something changes. */
  readonly getSnapshot: () => CardState
  /** Stage draft text for one field. */
  readonly edit: (field: string, text: string) => void
  /** Stage a clear for one field. */
  readonly resetField: (field: string) => void
  /** Write every staged edit. */
  readonly save: () => void
  /** Drop every staged edit. */
  readonly discard: () => void
}

/**
 * Render one field's row.
 * @param props - the card props plus this field's state and spec.
 * @returns the row.
 */
function Field({
  t, spec, text, overridden, invalid, disabled, onEdit, onReset,
}: {
  readonly t: Translate
  readonly spec: FieldSpec
  readonly text: string
  readonly overridden: boolean
  readonly invalid: boolean
  readonly disabled: boolean
  readonly onEdit: (text: string) => void
  readonly onReset: () => void
}): ReactNode {
  const id = `dtp-setting-${spec.field}`
  const hint = t(`settings.${spec.field}.hint` as Parameters<Translate>[0])
  return (
    <div className="dtp-setField">
      <div className="dtp-setLabelRow">
        <label className="dtp-setLabel" htmlFor={id}>
          {t(`settings.${spec.field}` as Parameters<Translate>[0])}
        </label>
        {/* Badge and reset ride together, and only where an override stands:
            there is nothing to reset in a field that has none, and a disabled
            button on every row is noise the shipped cards do not have. */}
        {overridden
          ? (
            <Fragment>
              <span className="dtp-setOverride">{t('settings.overridden')}</span>
              <button
                type="button"
                className="dtp-setReset"
                disabled={disabled}
                onClick={onReset}
              >
                {t('settings.reset')}
              </button>
            </Fragment>
          )
          : null}
      </div>
      {spec.kind === 'number'
        ? (
          <input
            id={id}
            className="dtp-setInput"
            type="text"
            inputMode="numeric"
            spellCheck={false}
            value={text}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            onChange={(event) => { onEdit(event.target.value) }}
          />
        )
        : spec.kind === 'toggle'
          ? (
            // The draft is the checkbox's state, and the row's own label is its
            // accessible name, so there is no second label to keep in sync.
            <input
              id={id}
              className="dtp-setToggle"
              type="checkbox"
              checked={text === 'true'}
              disabled={disabled}
              onChange={(event) => { onEdit(event.target.checked ? 'true' : 'false') }}
            />
          )
          : (
            <textarea
              id={id}
              className="dtp-setInput dtp-setTextarea"
              rows={3}
              spellCheck={false}
              value={text}
              disabled={disabled}
              aria-invalid={invalid || undefined}
              onChange={(event) => { onEdit(event.target.value) }}
            />
          )}
      <span className={invalid ? 'dtp-setHint dtp-setHintBad' : 'dtp-setHint'}>
        {invalid ? t('settings.invalid') : hint}
      </span>
    </div>
  )
}

/**
 * The settings card's two answers.
 *
 * The page has drawn the card — title, description, disclosure and all — so the
 * summary answer is that description line alone, and the page answer is the form
 * with its own save control. Anything else here is a second copy of something the
 * page already drew.
 * @param props - the view the page asked for, the translator, the form snapshot source, and its actions.
 * @returns one line of copy, the form, or null while the namespace is not served here.
 */
export function SettingsCard(props: SettingsCardProps): ReactNode {
  const { t } = props
  const state = useSyncExternalStore(props.subscribe, props.getSnapshot, props.getSnapshot)

  // No form and no state are needed to answer the one-liner, and the page's own
  // card already carries the title above it.
  if (props.view === 'summary') return t('settings.description')

  // A deployment that does not serve this namespace (or a memory-mode
  // connection) has nothing for the form to edit; rendering nothing is the
  // contract the slot expects from an unserved key.
  if (!state.available) return null

  const disabled = !state.writable
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <Fragment>
      {disabled
        ? <p className="dtp-setReadonly" role="status">{t('settings.readonly')}</p>
        : null}
      <div className="dtp-setFields">
        {FIELDS.map((spec) => {
          const field = state.fields[spec.field]
          return (
            <Field
              key={spec.field}
              t={t}
              spec={spec}
              text={field?.text ?? ''}
              overridden={field?.overridden ?? false}
              invalid={field?.invalid ?? false}
              disabled={disabled}
              onEdit={(text) => { props.edit(spec.field, text) }}
              onReset={() => { props.resetField(spec.field) }}
            />
          )
        })}
      </div>
      <div className="dtp-setFoot">
        <span className="dtp-setFootText">
          {state.failed ? <span className="dtp-setNoticeBad" role="status">{t('settings.failed')}</span> : null}
          {state.invalid ? <span className="dtp-setNotice">{t('settings.blocked')}</span> : null}
          {/* Staged edits have no card header to carry this marker any more, so
              they say so where the button that would write them is. */}
          {state.dirty ? <span className="dtp-setPending">{t('settings.unsaved')}</span> : null}
        </span>
        <button
          type="button"
          className="dtp-setDiscard"
          disabled={!state.dirty || state.saving}
          onClick={props.discard}
        >
          {t('settings.discard')}
        </button>
        <button
          type="button"
          className="dtp-setSave"
          disabled={disabled || blocked}
          onClick={props.save}
        >
          {t(state.saving ? 'settings.saving' : 'settings.save')}
        </button>
      </div>
    </Fragment>
  )
}
