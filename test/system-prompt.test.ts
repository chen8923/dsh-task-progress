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
  assert.match(text, /Never read the progress file back/)
})

test('the text instructs rather than describes, and names the failure it prevents', () => {
  const text = progressPromptText()
  // The first version said long tasks *can* report progress. A capability note
  // competes with everything else in the prompt and was skipped in practice; an
  // instruction attached to the decision is what actually changes behaviour.
  assert.match(text, /For any command you expect to run longer/, 'the trigger is a directive')
  assert.doesNotMatch(text, / can report /, 'a capability note is not an instruction')
  // Background jobs are where long work actually goes, and they were missing.
  assert.match(text, /background job/)
  // The consequence is what makes the instruction worth following.
  assert.match(text, /empty progress panel/)
  // The name is how the panel and the reminder recognise a job that reports.
  assert.match(text, /nam(?:e|ing) the task after something recognisable/)
})

test('the text leads with the cheap path, because that is what the model will do', () => {
  const text = progressPromptText()
  // Wrapping a command costs one tool call. Hand-writing a producer costs a
  // probe, a script, an encoding fix and a syntax check — measured in a real
  // session that spent six round trips on setup before the work started. The
  // instruction therefore names the wrapper first and the escape hatch second.
  assert.match(text, /run --task/, 'the cheapest recipe is named')
  assert.ok(
    text.indexOf('run --task') < text.indexOf('append one JSON event'),
    'the wrapper is offered before the hand-written line',
  )
  assert.match(text, /longer than about 30 seconds/, 'the trigger still comes first')
  assert.match(text, /append one JSON event/, 'the raw protocol stays as the escape hatch')
  // The two traps a hand-written producer walks into are the wrapper's job now,
  // so the section does not have to spend context on them.
  assert.ok(text.length < 800, 'and it is still one paragraph: the section is paid for every session')
})

test('the text stays short enough to pay for in every session', () => {
  assert.ok(progressPromptText().length < 800, 'prompt section grew past its budget')
  assert.equal(progressPromptText().includes('\n'), false, 'a prompt section is one paragraph')
})
