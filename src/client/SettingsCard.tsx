/**
 * The settings card: this plugin's knobs, inside DSH's plugin configuration.
 *
 * Registered into the keyed `settings.plugin.item` slot under the settings
 * namespace this plugin owns, which is the documented way a plugin distributed
 * outside DSH's own repository reaches the settings page. The card renders its
 * own controls — the section dispatches namespaces and stacks what comes back,
 * it does not render forms for anyone.
 *
 * Its disclosure behaviour deliberately mirrors the cards DSH ships, because a
 * row that looks like its neighbours but does not behave like them is worse than
 * one that looks different: the whole header is the toggle, it starts collapsed,
 * staged edits survive collapsing (so the header carries the unsaved marker),
 * and a successful save closes it again. Its *chrome* mirrors them just as
 * closely, and for the same reason — see the `.dtp-set` block in `styles.ts`
 * for where those values come from, and why they are transcribed rather than
 * imported.
 *
 * @module dsh-task-progress/client/SettingsCard
 */

import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
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
 * The glyph the header toggles with, drawn as the icon the shipped cards use
 * (`IconChevronDownOutline14`) rather than a chevron of this plugin's own: the
 * outline is a filled path on a 14px grid, and a hand-drawn stroke next to it
 * reads as a different weight at the same size. The package that exports the
 * icon is not in the module table a browser half may require, so the path is
 * carried here verbatim.
 */
function Chevron({ open }: { readonly open: boolean }): ReactNode {
  return (
    <svg
      className={open ? 'dtp-setChevron dtp-setChevronOpen' : 'dtp-setChevron'}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
        fill="currentColor"
      />
    </svg>
  )
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
 * The plugin's settings card.
 * @param props - the translator, the form snapshot source, and its actions.
 * @returns the card, or null while the namespace is not served here.
 */
export function SettingsCard(props: SettingsCardProps): ReactNode {
  const { t } = props
  const state = useSyncExternalStore(props.subscribe, props.getSnapshot, props.getSnapshot)
  const [open, setOpen] = useState(false)
  const saveStarted = useRef(false)

  // Close only after a Host-confirmed settlement: a rejected write keeps its
  // retained drafts and its diagnostic on screen.
  useEffect(() => {
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && !state.failed) setOpen(false)
  }, [state.dirty, state.failed, state.saving])

  // A deployment that does not serve this namespace (or a memory-mode
  // connection) has nothing for the card to edit; rendering nothing is the
  // contract the section expects from an unserved key.
  if (!state.available) return null

  const title = t('settings.title')
  const disabled = !state.writable
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <li className={open ? 'dtp-set dtp-setOpen' : 'dtp-set'}>
      <button
        type="button"
        className="dtp-setHeader"
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className="dtp-setHeadText">
          <span className="dtp-setTitle">{title}</span>
          <span className="dtp-setDescription">{t('settings.description')}</span>
        </span>
        {state.dirty ? <span className="dtp-setPending">{t('settings.unsaved')}</span> : null}
        <Chevron open={open} />
      </button>
      {open
        ? (
          <div className="dtp-setBody">
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
          </div>
        )
        : null}
    </li>
  )
}
