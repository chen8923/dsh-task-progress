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
 * and a successful save closes it again.
 *
 * @module dsh-task-progress/client/SettingsCard
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { CardState } from './settings-form.ts'
import type { Translate } from './locales.ts'

/** One control the card draws. */
interface FieldSpec {
  /** Field name inside the settings section. */
  readonly field: 'scanMs' | 'pollMs' | 'retainMs' | 'historyLimit' | 'maxTasks' | 'maxFileBytes' | 'roots'
  /** Control kind: a single-line numeric box, or one line per list entry. */
  readonly kind: 'number' | 'list'
}

/**
 * The fields this card edits, in reading order: how often the Host half looks,
 * how often the browser asks, and how much is kept.
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

/** The glyph the header toggles with; inline so no icon package is needed. */
function Chevron({ open }: { readonly open: boolean }): ReactNode {
  return (
    <svg
      className={open ? 'dtp-setChevron dtp-setChevronOpen' : 'dtp-setChevron'}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="M4 6.5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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
        {overridden ? <span className="dtp-setOverride">{t('settings.overridden')}</span> : null}
        <button
          type="button"
          className="dtp-setReset"
          disabled={disabled || !overridden}
          onClick={onReset}
        >
          {t('settings.reset')}
        </button>
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
              ? <p className="dtp-setNotice" role="status">{t('settings.readonly')}</p>
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
