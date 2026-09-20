/**
 * Settings-card form tests: staging, override marking, validation, and the
 * save/discard lifecycle, driven through a fake namespace scope.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSettingsForm, decodeSettingsSection, listField, numberField,
  type SettingsScopeLike, type ScopeSnapshotLike,
} from '../src/client/settings-form.ts'

/** A namespace scope that behaves like the transport's: writes move the layers. */
function fakeScope(initial: {
  value?: Record<string, unknown>
  base?: Record<string, unknown>
  user?: Record<string, unknown>
  writable?: boolean
  status?: ScopeSnapshotLike['status']
  failWrites?: boolean
} = {}) {
  let snapshot: ScopeSnapshotLike = {
    status: initial.status ?? 'ready',
    value: initial.value ?? { pollMs: 2000, roots: [] },
    base: initial.base ?? {},
    user: initial.user ?? {},
    writable: initial.writable ?? true,
  }
  const listeners = new Set<() => void>()
  const announce = (): void => { for (const listener of [...listeners]) listener() }
  const scope: SettingsScopeLike = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field, value) => {
      if (initial.failWrites === true) throw new Error('refused')
      const value_ = { ...(snapshot.value as Record<string, unknown>), [field]: value }
      snapshot = { ...snapshot, value: value_, user: { ...(snapshot.user as Record<string, unknown>), [field]: value } }
      announce()
    },
    unset: async (field) => {
      if (initial.failWrites === true) throw new Error('refused')
      const user = { ...(snapshot.user as Record<string, unknown>) }
      delete user[field]
      const value_ = { ...(snapshot.value as Record<string, unknown>), [field]: (snapshot.base as Record<string, unknown>)[field] }
      snapshot = { ...snapshot, value: value_, user }
      announce()
    },
  }
  return { scope, read: () => snapshot, writeCount: () => Object.keys(snapshot.user as object).length }
}

const SPECS = [numberField('pollMs'), listField('roots')]

test('the decoder takes a resolved section as it stands', () => {
  // The Host resolved it through the namespace's own schema; a decoder exists
  // so the scope never has to rehydrate a schema envelope to trust it.
  assert.deepEqual(decodeSettingsSection({ pollMs: 2000 }), { pollMs: 2000 })
  assert.equal(decodeSettingsSection(null), undefined)
  assert.equal(decodeSettingsSection('nope'), undefined)
  assert.equal(decodeSettingsSection([1, 2]), undefined)
})

test('an unserved namespace renders nothing', () => {
  const { scope } = fakeScope({ status: 'unavailable' })
  const form = createSettingsForm(scope, SPECS)
  assert.equal(form.getSnapshot().available, false)
})

test('a served namespace seeds its fields from the resolved value', () => {
  const { scope } = fakeScope({ value: { pollMs: 2000, roots: ['C:/a'] } })
  const form = createSettingsForm(scope, SPECS)
  const state = form.getSnapshot()
  assert.equal(state.available, true)
  assert.equal(state.dirty, false)
  assert.equal(state.fields['pollMs']?.text, '2000')
  assert.equal(state.fields['roots']?.text, 'C:/a')
  assert.equal(state.fields['pollMs']?.overridden, false)
})

test('staging marks the form dirty and the field overridden', () => {
  const { scope } = fakeScope()
  const form = createSettingsForm(scope, SPECS)
  form.edit('pollMs', '5000')
  const state = form.getSnapshot()
  assert.equal(state.dirty, true)
  assert.equal(state.invalid, false)
  assert.deepEqual(state.fields['pollMs'], { text: '5000', overridden: true, invalid: false })
  assert.equal(state.fields['roots']?.overridden, false)
})

test('the snapshot reference is stable until something changes', () => {
  const { scope } = fakeScope()
  const form = createSettingsForm(scope, SPECS)
  const first = form.getSnapshot()
  assert.equal(form.getSnapshot(), first)
  form.edit('pollMs', '1')
  assert.notEqual(form.getSnapshot(), first)
})

test('an unparseable draft blocks the save instead of dropping the edit', async () => {
  const { scope, read } = fakeScope()
  const form = createSettingsForm(scope, SPECS)
  form.edit('pollMs', 'not a number')
  assert.equal(form.getSnapshot().invalid, true)
  form.save()
  await Promise.resolve()
  assert.equal(read().user?.['pollMs'], undefined)
  // The draft is still there for the user to fix.
  assert.equal(form.getSnapshot().fields['pollMs']?.text, 'not a number')
})

test('saving writes the staged value and clears the draft', async () => {
  const { scope, read } = fakeScope()
  const form = createSettingsForm(scope, SPECS)
  form.edit('pollMs', '5000')
  form.save()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(read().user?.['pollMs'], 5000)
  const state = form.getSnapshot()
  assert.equal(state.dirty, false)
  assert.equal(state.failed, false)
  assert.equal(state.saving, false)
  assert.equal(state.fields['pollMs']?.overridden, true)
})

test('a list field edits one entry per line and clears when emptied', async () => {
  const { scope, read } = fakeScope({ value: { roots: ['C:/a'] }, base: { roots: [] } })
  const form = createSettingsForm(scope, SPECS)
  form.edit('roots', 'C:/a\n\n C:/b \n')
  form.save()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(read().user?.['roots'], ['C:/a', 'C:/b'])

  form.edit('roots', '   ')
  form.save()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(read().user?.['roots'], undefined)
  assert.equal(form.getSnapshot().fields['roots']?.text, '')
})

test('reset stages the base value and saving removes the override', async () => {
  const { scope, read } = fakeScope({ value: { pollMs: 2000 }, base: { pollMs: 7000 }, user: { pollMs: 2000 } })
  const form = createSettingsForm(scope, SPECS)
  assert.equal(form.getSnapshot().fields['pollMs']?.overridden, true)
  form.resetField('pollMs')
  const staged = form.getSnapshot()
  assert.equal(staged.fields['pollMs']?.text, '7000')
  assert.equal(staged.dirty, true)
  form.save()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(read().user?.['pollMs'], undefined)
  assert.equal(form.getSnapshot().fields['pollMs']?.overridden, false)
})

test('discard drops every draft and clears a failure', async () => {
  const { scope } = fakeScope({ failWrites: true })
  const form = createSettingsForm(scope, SPECS)
  form.edit('pollMs', '1234')
  form.save()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(form.getSnapshot().failed, true)
  assert.equal(form.getSnapshot().dirty, true)
  form.discard()
  const state = form.getSnapshot()
  assert.equal(state.dirty, false)
  assert.equal(state.failed, false)
  assert.equal(state.fields['pollMs']?.text, '2000')
})

test('a rejected write keeps the drafts so the user can retry', async () => {
  const { scope, read } = fakeScope({ failWrites: true })
  const form = createSettingsForm(scope, SPECS)
  form.edit('pollMs', '4321')
  form.save()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(read().user?.['pollMs'], undefined)
  assert.equal(form.getSnapshot().fields['pollMs']?.text, '4321')
  assert.equal(form.getSnapshot().failed, true)
})

test('a scope change re-projects an unedited field', () => {
  const { scope } = fakeScope()
  const form = createSettingsForm(scope, SPECS)
  assert.equal(form.getSnapshot().fields['pollMs']?.text, '2000')
  void scope.set('pollMs', 9000)
  // The write announced itself; the next read sees the new section.
  return Promise.resolve().then(() => {
    assert.equal(form.getSnapshot().fields['pollMs']?.text, '9000')
  })
})
