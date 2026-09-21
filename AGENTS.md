# Working on this plugin

Notes for whoever — human or agent — is changing this repository. They are about
*how* work happens here, not about what the plugin does; the plugin's own
contract is `docs/PROTOCOL.md`, and the invariants are enforced by the suite.

## Tests come first, and the first one is a reproduction

A fix starts with a test that fails **the way the report fails**. Write it, run
it, watch it go red, then implement. A test written after the code passes by
construction: it records what the code does, not what was wrong with it. The
kill case is the example to copy — the failing test was "a task whose writer was
killed is published as cancelled", written before the settle existed.

A feature starts with its contract: the pure rule, the wire field, the CLI
surface. Write the assertion for the behaviour someone will depend on, not for
the shape of the implementation.

Two things are **not** test-first, and pretending otherwise wastes a cycle:

- **Diagnosis.** You cannot assert a behaviour you have not measured. Run the
  experiment first — the probe is the artifact, and it belongs in `notes/`
  (gitignored), not in the suite. Measured examples that shaped this plugin:
  `finally` does not run under `taskkill`, and a sandboxed `spawn` with
  `stdio: 'pipe'` fails with EPERM while a file descriptor works.
- **Appearance.** The artifact for a visual change is a contract test
  (`test/settings-chrome.test.ts` pins the values the card copies) plus looking
  at the real UI. A screenshot is evidence; it is not a test.

## Then break it on purpose

With the suite green, mutate each load-bearing branch — one at a time — and
confirm the failure lands on the test that claims to cover it. A test that cannot
fail is decoration:

- removing the live-job veto → exactly the two tests written for it;
- relaying a wrapped command through a pipe → the wrapper tests, with EPERM.

Revert each mutation before moving on.

## Housekeeping the suite already checks

- `npm run build` and commit the rebuilt `lib/` **in the same commit** as the
  sources; CI fails a tree where the two disagree.
- No machine paths anywhere in the tree (`test/privacy.test.ts`). Notes, plans,
  handovers and probe scripts go in `notes/`, which is gitignored.
- The version is stated in five places and `test/release.test.ts` reads all of
  them.
- A new CLI command must appear in `HELP` and in the `switch`; the CLI tests
  compare the two.

## Writing the change itself

Match the file you are editing: every module here opens with a note saying why it
exists, and comments explain decisions rather than restating code. When a fix has
a cost or a trap, write it down where the next reader will hit it — that is what
`docs/PROTOCOL.md` and the changelog are for, and it is why the changelog reads
like prose rather than like a list of commits.
