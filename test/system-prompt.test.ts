/**
 * Prompt-section tests: what makes the plugin work without the user editing
 * anything. These pin the text's load-bearing facts, not its wording.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROMPT_ORDER_NAME, PROMPT_SECTION_NAME, progressPromptText, registerProgressPrompt,
  type SystemPromptLike,
} from '../src/host/system-prompt.ts'

/** A system-prompt service that records what was registered. */
function fakePrompt(order: number | undefined = 1600) {
  const sections: { name: string, order: number, text: string }[] = []
  const asked: string[] = []
  let disposals = 0
  const systemPrompt: SystemPromptLike = {
    section: (section) => {
      sections.push(section)
      return () => { disposals += 1 }
    },
    getSectionOrder: (name) => {
      asked.push(name)
      return order
    },
  }
  return { systemPrompt, sections, asked, disposals: () => disposals }
}

test('the section shares the background-jobs slot', () => {
  const fake = fakePrompt()
  registerProgressPrompt(fake.systemPrompt)
  assert.deepEqual(fake.asked, [PROMPT_ORDER_NAME])
  assert.equal(fake.sections.length, 1)
  assert.equal(fake.sections[0]?.name, PROMPT_SECTION_NAME)
  assert.equal(fake.sections[0]?.order, 1600)
})

test('a composition without that slot still gets a section, in the same place', () => {
  const fake = fakePrompt(undefined)
  registerProgressPrompt(fake.systemPrompt)
  assert.equal(fake.sections[0]?.order, 1600)
})

test('the disposer is the service\'s own', () => {
  const fake = fakePrompt()
  const dispose = registerProgressPrompt(fake.systemPrompt)
  dispose()
  assert.equal(fake.disposals(), 1)
})

test('the text carries every fact a producer needs, and the one it must not do', () => {
  const text = progressPromptText()
  // Where to write, in both directions the environment offers.
  assert.match(text, /DSH_PROGRESS_DIR/)
  assert.match(text, /DSH_PROGRESS_CLI/)
  // What a line looks like, and which states exist.
  assert.match(text, /"v":1/)
  assert.match(text, /running\/done\/failed\/cancelled/)
  // When it is worth doing, and that the file is not the model's to read.
  assert.match(text, /30 seconds/)
  assert.match(text, /Do not read the progress file back/)
})

test('the text stays short enough to pay for in every session', () => {
  assert.ok(progressPromptText().length < 800, 'prompt section grew past its budget')
  assert.equal(progressPromptText().includes('\n'), false, 'a prompt section is one paragraph')
})
