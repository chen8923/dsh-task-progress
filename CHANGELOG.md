# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version here, in `package.json`, and in both READMEs is checked by
`test/release.test.ts`, so they cannot drift apart.

## [Unreleased]

### Added

- **A real screenshot at the top of both READMEs**, replacing the ASCII mock-up
  that used to stand in for one. A description of a progress bar and a picture of
  one are not the same argument, and the mock-up had drifted: it showed two tasks
  and numbers no capture would ever match. The shot is the floating panel from a
  running session — one task reporting, with its bar, message, elapsed time, unit
  counters and ETA — taken as-is, with a synthetic demo task reporting into it
  (the panel cannot be photographed without something reporting to it). The
  decorative skin layer in the session behind it was hidden for the shot so no
  personal imagery ends up in a public repository. It ships in `docs/`, so the
  relative link renders on the repository and the bytes are in the package.
- **`dsh-progress run` — wrap the command and stop writing producers.** Setting a
  long task up used to cost a small program per task kind: probe the tool's
  output, write a script that parses it, discover that stderr needs merging, get
  the encoding right, add a BOM, syntax-check, launch. A real session spent six
  round trips and seven stretches of reasoning on exactly that — before a
  17-minute job had produced anything. One command replaces it:

  ```
  dsh-progress run --task sync-catalog -- python sync_catalog.py --task sync-catalog
  ```

  It announces the task, follows the command's output, reports a percentage when
  it can read one (`12%` or `12/88` anywhere in a line, with `--pattern` for the
  rest), relays that output to its own stdout, and writes the ending itself from
  the exit code — non-zero is `failed`, a signal is `cancelled`, a clean exit is
  `done` with a full bar. Reported percentages are passed through as printed; the
  reader derives one from `done`/`total` rather than having two places compute it.
  A change is reported and so is the passage of time (every 30 s), so a command
  printing one unchanging line stops looking stalled without filling the file.
  The task id lands in the command line by construction, which is the correlation
  the settle below needs — and a wrapped command that is killed is settled from
  its job record like any other producer.

  The child's output is relayed through a **file descriptor, never a pipe**: a
  shell running under DSH's sandbox cannot create the pipes a piped child needs
  (`spawn` + `stdio: 'pipe'` → `EPERM`; the same spawn with a file descriptor
  works — both measured here). The relay file is removed when the run ends, and
  the test that covers this fails with `EPERM` if anyone ever simplifies it back
  to a pipe.
- **Two knobs in the settings panel, and a checkbox to render them.**
  `remindAfterMs` was in the schema but hidden, which is the wrong place for a
  number that spends the *model's* context: it is now editable, and `0` (never
  remind) is stated as a legitimate answer. `overlayUnreported` is new: whether
  the floating panel may appear for a background job whose script reports
  nothing. The settings card learned a `toggle` kind for it — a checkbox whose
  draft is `'true'`/`'false'`, with the row's own label as its accessible name,
  and the reset control still meaning *inherit* rather than *off*.
- `AGENTS.md` in the repository root: how work happens here. A fix starts with a
  test that fails the way the report fails; a feature starts with its contract;
  diagnosis runs the experiment first and leaves the probe in `notes/`; a green
  suite is followed by breaking each load-bearing branch on purpose to confirm
  the tests bite. The kill case and the pipe case are the worked examples.

### Changed

- **The floating panel no longer summons itself for work nobody reported for.**
  Its amber pill used to appear whenever the only live work was a background job
  with no progress reported — a widget that pops up to announce a missing report
  is a summons nobody opted into, and the job was launched for the work, not for
  this panel. Those rows are still in the sidebar tab, which a reader opens
  deliberately, and the loud behaviour is now opt-in through
  `overlayUnreported`. The wording changed with it: *"{n} background jobs running
  (no progress reported)"* states a fact instead of sounding like a complaint.
- **The prompt section leads with the wrapper.** It taught the raw protocol —
  "append one JSON event per line, or run `emit`" — which is why a session that
  followed it hand-wrote a producer and debugged PowerShell for six round trips.
  The instruction now names `run --task` first, keeps the hand-written line as the
  escape hatch, and stays inside its 800-character budget, because every session
  pays for it.
- `docs/PROTOCOL.md` gains **Wrapping a command instead of writing a producer**,
  and the two settings above are documented where the rest of the configuration
  is. The panel's empty state shows the wrapper first for the same reason.

### Fixed

- **A task whose writer was killed no longer says `running` forever.** A task's
  ending had exactly one author: the script. Killing a background job terminates
  the process tree, and on Windows that is `taskkill`, which runs no user code —
  so the `finally` block never runs and the terminal event is not late, it is
  never coming. Measured rather than assumed: a background `pwsh` job whose
  `finally` appends to a file, killed with `job_kill`, wrote nothing after the
  kill. The Host half now reads the one record that outlives the process — DSH's
  job registry — and publishes a `running` task whose writing job has ended as
  ended: `killed` reads as cancelled, `failed` as failed, a clean exit as done.
  The row carries an `ended` marker and says so underneath (*process was killed
  without reporting an ending*), so an inference is never passed off as a
  report, and the percentage stays where the producer left it: a killed run never
  reported a completion. The progress file is untouched — a script that resumes
  and appends `running` again supersedes the inference by itself.
  The rule is narrow on purpose, because a wrong settle would *hide* work the
  user is waiting on: the job's label must name the task, **no live job may name
  that task** (a second writer still running means the row is not orphaned), the
  job must have spanned the task's last event, and it must publish both a start
  and a finish. Where the composition has no job registry — both `ctx.jobs` and
  `ctx.agents` are optional injections — nothing is inferred and the file is
  again the whole truth.
- **Deleting a progress file deletes its row, as documented.** The scan walked
  the directory's *current* entries and never reconciled them against the files
  it already held, so a cleared or rotated-away file kept its folded task: the
  row went on reporting a file that was no longer there, and
  `dsh-progress clear --task x` left a phantom. The listing is now read whole
  (the per-directory read cap only bounds what is re-folded, so a cap can never
  look like a deletion) and records whose file is gone are dropped.
- **The settings card now looks like the cards it sits among.** Every other row
  in the plugin configuration section is a raised card with a visible hairline, a
  16px corner, a 15px name over a 13px description, and controls on the house
  scale. This one sat on the page layer with a dark-mode-thin border (6% white —
  invisible in dark mode), a 14px corner, a 13px name, and inputs and buttons a
  size down, so it read as an unconfigured row rather than as the fifth plugin in
  the list. The chrome is now transcribed from the components DSH ships into that
  very slot (`ui-settings-plugins`), because a plugin living outside the DSH
  repository cannot import them — the browser half may require only the platform
  modules the shell seeds — so the values are copied rather than approximated:
  the same tokens, the same metrics, and the states a still screenshot cannot
  show (the pointer's border, the focus ring, the open card's layer, the inverted
  fill on the primary action, the neutral capsule on both the unsaved and the
  overridden badge). Verified against a running DSH by comparing this card's
  computed styles with a shipped card's, in both themes: the values are equal
  now, where the resting fill and the border alpha previously were not.
- **The per-field reset appears only where there is an override to reset.** It
  was drawn disabled on all seven fields, which no shipped card does and which
  made the panel noisier than its neighbours. Emptying a field and saving still
  clears the override, and an overridden field still shows the badge and the
  reset together, as its neighbours do.
- **The code surfaces name the theme's code font.** They asked for
  `--dsw-font-family-mono`, which this theme does not define
  (`--ds-font-family-code` is the token), so the plugin's own stack was used —
  one without CJK coverage on Windows, where a command line containing Chinese
  renders in a fallback that the theme sheet deliberately avoids. The same
  applies to `--dsw-alias-label-error`, which the shipped sheets reference and
  this theme also does not define: the card's error text uses the error token the
  theme does define, and the departure is noted in the sheet itself.
- The settings card's disclosure glyph is now the icon the shipped cards use
  (`IconChevronDownOutline14`, a filled path on a 14px grid) rather than a
  hand-drawn stroke chevron, which rendered at a different weight in the same box.

### Added

- `docs/PROTOCOL.md` gains **When the writer dies**: the measured behaviour of a
  force kill, the `ended` field and its mapping from the registry's statuses, the
  four conditions the inference requires, and what it deliberately leaves alone.
  The producer rules now state the three things that this makes load-bearing: the
  task id must appear in the command line the job was launched with, one task id
  should have exactly one writer, and the ending should still be written — it
  covers exceptions and Ctrl+C, it is simply no longer the only thing that ends
  a row.
- The bundled CLI's `--help` carries the same correction, including the trap its
  own example used to walk into: a native command's non-zero exit does **not**
  throw in PowerShell, so a `catch`-only script reports a failed run as `done`
  unless it checks `$LASTEXITCODE`.
- `test/jobs.test.ts`, `test/store.test.ts`, `test/host.test.ts`, and
  `test/protocol.test.ts` cover the inference from the rule's edges up to the
  route `apply()` serves. Two mutations confirmed the tests bite: dropping the
  live-job veto fails exactly the two tests written for it, and dropping the
  "spanned the task" bound fails exactly the one.
- `test/settings-chrome.test.ts`: the card's chrome, pinned to the values of the
  components it copies. It is the one part of this plugin whose correctness lives
  in another repository, and it can neither be imported nor read from a test, so
  the contract is recorded here — and checked rule by rule, because an unbounded
  scan of the sheet happily finds the token it wants in some later rule and
  passes while the rule under test is wrong.

## [0.1.1] — 2026-09-21

### Added

- **`SECURITY.md`**, plus private vulnerability reporting switched on for the
  repository. The plugin ecosystem has no security-reporting channel, so this
  plugin carries its own — and it states the whole footprint (what it reads,
  creates, exposes over HTTP, and adds to the prompt and the UI), so that a
  mismatch between that document and the code is itself a report.
- **Access and compatibility sections in both READMEs**: the footprint table, the
  DSH build this was verified against (`@deepseek-ai/dsh` 0.1.5-rc.2, commit
  `0e77055`), the Node floor, the public seams used, and the fact that the plugin
  adds **no tools** — so installing it does not push tool descriptions into the
  cached prefix.
- **CI** (`.github/workflows/ci.yml`): the suite on every push, plus a check that
  the committed `lib/` is exactly what the sources build — the discipline that
  makes the one-command git install honest.
- **`publish.yml`**: releases publish from a tag through npm trusted publishing
  (OIDC) with a signed provenance attestation and no stored token. It is also the
  path that keeps working after npm retires direct publishing for bypass-2FA
  tokens in January 2027.
- **Dependabot** for the two dev dependencies, the lockfile, and the workflows.
- **Every background job gets a row, whether or not a script reports for it.**
  A job that ran for fifteen minutes with nothing reported used to show *nothing*
  at all — the floating pill disappeared, and an absent pill reads as "no work is
  running", which is the one thing it did not mean. The browser half now draws
  DSH's own per-session job mirror (command label, state, elapsed time, exit
  detail) for jobs no reported task accounts for, and the pill stays up in a
  warning colour while that is the only live work. Nothing about it is invented:
  with no script reporting there is no percentage, and the group says so.
- **A reminder that reaches the model at the decision, not in the abstract.** A
  system-prompt section states the convention once, among hundreds of lines, at a
  moment when no decision is being made; in practice it was skipped, and a session
  that never reported had no way to notice. The Host half now observes the job
  registry's **non-consuming snapshots** (`ctx.jobs.list`) before each model step
  and appends **one** notice when a job has run past `remindAfterMs` (default 30 s)
  with nothing reported for it — phrased to forbid the one destructive reading it
  could invite ("do not restart a job that is already running"). It delegates
  first, never vetoes, speaks once per job, forgets ids that are no longer live,
  and swallows its own failures so a broken reminder can never break a step.
  `remindAfterMs: 0` disables it, in the plugin row's config or in settings.
- `src/jobs.ts`: the one place the two job projections are reconciled, shared by
  the Host's reminder and the browser's rows, so the row drawn and the notice sent
  can never disagree about which jobs are already reported for.

### Changed

- **The prompt section is an instruction now.** It said long tasks *can* report
  progress — a capability note — and never mentioned background jobs, which is
  where long work actually goes. It now says what to do, when, and what the user
  sees if it is skipped.
- **Developer notes are local now** (`.gitignore`), and the planning note that
  had been committed is gone from the tree. A note is written for one machine and
  one moment; `docs/` ships inside the package, so anything meant for readers
  belongs in `docs/`, the READMEs, or here.

### Fixed

- Both READMEs claimed 38 tests and 69 checks. The suite has 88.
- Both READMEs stated that a background job with no reporting is invisible here.
  That was the bug, not the contract; both now describe the two kinds of row.
- The settings schema did not cover `remindAfterMs`, so a settings layer would
  have dropped a value the plugin row had configured. It is a schema field now,
  resolved and clamped like the rest, and the Host reads the live value so turning
  the reminder off takes effect on the next step.

## [0.1.0] — 2026-09-20

First release.

### Added

- **Progress file protocol** (`docs/PROTOCOL.md`): append-only JSONL, one file per
  task, at `<workspace>/.dsh-progress/<session-id>/<task>.jsonl`. Any language can
  write it; no IPC, no ports, no authentication.
- **Host half**: a `ctx.shellEnv` contributor handing every shell call
  `DSH_PROGRESS_DIR` and `DSH_PROGRESS_CLI`; a directory-polling store that folds
  those files into tasks; and one read-only, cookie-authenticated route
  (`GET /plugins/task-progress/state`) behind the composition's connection trust.
- **Browser half**: a floating overlay in `shell.overlay` that appears only while
  work is running, and a right-sidebar tab listing the session's tasks, finished
  ones included.
- **Settings page**: the namespace `task-progress`, editable in
  Settings → Plugins → Plugin configuration, with the plugin row's `config` as the
  composition base layer and live application of every change.
- **Out-of-the-box convention**: a short system-prompt section, so the model
  reports long commands without the user editing their own instructions.
- **Producer CLI** (`dsh-progress`): `emit`, `done`, `fail`, `cancel`, `path`,
  `list`, `clear` — dependency-free, Node 20+.
- **Example**: `examples/simulate.ps1` prints a self-reporting long task.

### Notes

- The plugin never reads a background job's output. That cursor is
  single-consumer and belongs to the model's `job_output` tool, so progress here
  is what a *script* chooses to report.
- Zero runtime dependencies: the host half imports Node built-ins only, and the
  browser half bundles everything it owns (React is a platform external).

### Security

First release, so these are properties rather than changes:

- The state endpoint is scoped to one session per request and carries no
  filesystem paths. DSH's web login fences the instance, not a session, so an
  unscoped endpoint would expose every session's task names to any authenticated
  caller.
- `maxTasks` bounds the Host's in-memory task set as well as the wire document,
  so a producer cannot grow the process by minting task ids.
- Producer input is constrained by regular expressions at every level that
  becomes a path (session segment, task id, directory name), and the store reads
  only `*.jsonl` files it finds inside those directories.
- No runtime dependencies, no `postinstall`, no network calls from either half,
  and no HTML injection surface in the browser half.

[0.1.1]: https://github.com/chen8923/dsh-task-progress/releases/tag/v0.1.1
[0.1.0]: https://github.com/chen8923/dsh-task-progress/releases/tag/v0.1.0
