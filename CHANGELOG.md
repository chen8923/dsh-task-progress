# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version here, in `package.json`, in both READMEs and in the CLI's own `--version`
string is checked by `test/release.test.ts`, so they cannot drift apart.

## [0.2.1] — 2026-09-24

### Added

- **A task can be followed instead of asked about.** `dsh-progress watch` prints a
  task the first time it sees one and then only when that task's reading actually
  changes, so a long run scrolls at the pace of the work rather than at the pace of
  the clock. It follows the files rather than a process, which is what lets it watch
  work another shell started. `--once` is a single pass, and it prints exactly what
  `list` prints — the clock belongs to a follow, not to a read — so a script can take
  either; both readers accept `--task <id>` now, because they share the fold. Asking
  `list` again by hand was the alternative to watching, at a round trip per look and
  the same row back every time. The three pieces the suite can reach are the ones
  that decide what a reader sees: the comparison that calls a change a change
  (`sameRow`), the fold both readers share (`rowsOf`), and the line a read prints
  versus a follow (`lineFor`). The CLI itself is never spawned from the suite — a
  restricted sandbox forbids the pipes a child needs — which is exactly why those
  three are exported and pure; the loop was driven for real instead, by
  `notes/watch-smoke.mjs`, against the copy the model actually calls.

- **A job that reports nothing now shows what it is printing.** The row for an
  unreported background job used to carry its command line, its state, and how
  long it had been running — enough to know that something was happening, not
  enough to know what. It now shows the last few lines the job printed, read from
  the output tail DSH already streams to this browser (`ctx.jobs.observe`),
  clipped to three lines with the full tail in the row's tooltip. Three things
  bound it and `SECURITY.md` records all three: the stream is **DSH's own push to
  this client** rather than a read this plugin opens, DSH bounds the tail and
  flags dropped bytes, and the row renders a fixed three clipped lines. The
  registry's single-consumer `read()` cursor — the one the model's `job_output`
  tool owns — is still never touched, and a tail never reaches the Host half or a
  model step.

### Removed

- **`registerProgressSettings`, `SettingsProviderLike` and the host `SettingsScopeLike`
  are gone, from the sources and from the package's exports.** They described the
  registration call DSH 0.1.7 replaced with a schema the entry exports itself, and the
  function would have thrown if anything had called it: `settings.register` is not a
  method of the new service. Nothing did — its only caller was its own test, whose fake
  provider supplied the very method that had gone, which is the shape the 0.2.0 notes
  name as the reason the settings breakage passed every test at the time.
  `SETTINGS_NAMESPACE` stays, because an older config document was written under that
  key; `PROTOCOL.md` now says so where a migrating reader would look.

### Fixed

- **The CLI's readers bound how many files one listing reads, and say so once.** A
  directory that accumulated years of task files made `list` a one-off cost and `watch`
  a per-tick one, in the reader whose whole reason to exist is being the cheap path.
  Both read at most 64 files now, mirroring the Host half's own working-set bound, and
  mention the rest on stderr; `watch` mentions it on the first look and again only when
  the count moves, because a note per tick would scroll the terminal at the pace of the
  clock — the same defect, moved from the filesystem to the output.
- **A clipped tail line is cut between characters, never inside one.** The clip was a
  `slice`, which counts UTF-16 code units, so a boundary landing on a surrogate pair cut
  it in half and the browser drew the replacement glyph where the character was. It
  counts code points now, and a test pins both the width and the absence of that glyph.
- **The Plugins page shows one settings card again, and the form it opens actually
  renders.** That page draws the card itself — title, icon, description line and the
  disclosure that opens it — and asks the entry twice by contract: `summary` for the
  one-liner under the title, `page` for the body of the plugin's own page. This card
  ignored the view and painted a complete card into both answers, so the page showed
  two identical boxes, and because that card's own disclosure started collapsed the
  form never rendered at all — no knob on that page could be edited. It now answers
  the two views the way DSH's own settings pages do, and draws no card chrome of its
  own; the rule that painted it is gone from the sheet rather than left dead. Measured
  on the live page: two identical description lines and no form before, one line and
  nine field rows after. The drift that let it through was in the module's own note,
  which still described the pre-0.1.7 `settings.plugin.item` slot.
- **The reminder's notice is admitted by the session log again.** DSH moved its
  session format to V4, and the V4 writer refuses a message whose source is the
  retired `{ kind: 'plugin' }` wrapper: `format v4 message requires a producer-owned
  source kind`. It refuses it **at the append**, so the notice did not quietly go
  missing — the model step that carried it failed, which is what a user running any
  session with a background job silent past 30 s saw as a failed turn. The notice now
  declares its own kind, `plugin:dsh-task-progress`, which is also the kind DSH's own
  V3→V4 migration stamps on a notice from a producer outside the harness, so a log
  spanning the cutover keeps **one** identity for this plugin instead of two. The claim
  that the reminder "can never break a step" was a claim about our own `try`/`catch`,
  not about DSH's admission; the module note now says which is which, and the kind is
  pinned by `test/reminder.test.ts` — every other field of the message can be read off
  `createUserMessage`, and this one cannot.
- **The memory bound is named the way the code names it, and the suite size is stated
  once.** The `Memory` row in both READMEs and in `SECURITY.md` named `fileTailBytes`
  **and `messagesPerTask`**, and no code has either: the ceiling is `maxFileBytes` and
  the message cap is `historyLimit`, as `config.ts` and `PROTOCOL.md` both already
  said — a reader trying to bound memory would have looked for two knobs that do not
  exist. (The first pass at this fixed one of the two names and left the other, in the
  same row, which is why the row is now checked against `config.ts` line by line
  rather than against the prose beside it.) The two READMEs also stated two different
  sizes for the same suite, `187 tests` in Development and `168 checks` in Releasing,
  neither of them current, and the count then went stale again within six commits —
  so both now say "the whole suite" and the number is gone. The version never drifts
  because `test/release.test.ts` reads it in five places; nothing pinned the count,
  which was the actual defect.
- **The CLI's reader takes the tail of a progress file, like everything else that
  reads one.** `list` and `watch` read a file whole while the Host half applied the
  256 KiB ceiling `PROTOCOL.md` documents and both READMEs promise — and `watch`
  re-reads on a timer, so one oversized progress file cost a full read per second in
  the script whose whole reason to exist is being the cheap way in. The bound is
  written again inside `bin/` rather than imported, because `src/` is not in the
  package's `files`: a `bin/` script that reached into it would break the moment the
  tarball is what you have.
- **A task name is recognised as a word, not as any run of characters inside the
  command.** The rule that ties a reported task to the background job running it — one
  function, consulted by the settle, the reported-nothing rows and the reminder — was a
  plain substring search, so a task called `com` matched `docker compose up -d`, `load`
  matched `payload`, and `test` matched `latest`. A false match is the expensive
  direction and the quiet one: the job counts as covered, so it neither reminds the
  model nor appears as a row, and work nobody is reporting for simply disappears. The
  boundaries are lookarounds rather than `\b` because a task id may end in `.`, `-` or
  `_`, where `\b` would demand a word character on the far side and never match, and
  the name is escaped before it becomes a pattern so that `crack.rar` cannot match
  `crackXrar`. The one assertion that had pinned the old behaviour — `com` inside
  `compose` is a match — is now the case that must fail, which is the difference
  between a rule and a recording of one.
- **Both features that read the job registry now ask it the way the host answers.**
  `ctx.jobs.list(caller)` used to be handed the agent that owns a job; it now
  compares its caller against `job.owner.id`, a session id, so an agent object
  matched nothing and the registry replied with the unowned jobs alone — which for
  a session's own work means an empty list. Neither reader failed loudly, so both
  went **silent**: a task whose writer was killed stayed `running` for good, and the
  reminder for an unreported job never fired again. The registry is now asked as
  the session id, which also removed the agent-registry lookup the settle used to
  bridge a session to its agent.
- **A job's owning session is read under the registry's own field name.** It is
  `owner` on `@deepseek-ai/dsh-jobs/view`, not `ownerSession`; under the old name
  it is `undefined` on every job, and the coverage rule would then turn inside out
  — every live job would look unreported, and the reminder would nag about work
  that is reporting perfectly well. Fixing the caller alone would have made this
  worse rather than better, which is why the two land together.
- **The floating overlay comes back.** It asked the session list which session was
  in view through a `current` field that 0.1.7 removed, so the answer was
  `undefined` forever and the surface rendered nothing at all. The session in view
  is the row the **main view retains** — the same judgement DSH's own document
  title and workspace browser make — and the whole client half was reading a
  session list that no longer carries a current selection.
- **The settings card returns to the Plugins page.** It registered into
  `settings.plugin.item`, which 0.1.7 no longer declares, and bound its values
  through `settingsScope`, which is no longer a service — both silent, both
  leaving an empty space where the card used to be. It now registers into
  `plugins.item` while the settings domain serves its namespace
  (`ctx.configForms.whileServed`) and takes its values from `ctx.configForms`.
- **Background jobs that report nothing are listed again.** The browser-side job
  mirror left the session list; the rows now come from `ctx.jobs`, whose snapshot
  has to be **watched per session** (`watchRows`) — reading it without watching
  answers with nothing for a session that has jobs.
- The client half's session and job seams are now pinned by
  `test/client-contract.test.ts`, which asserts the **names** this plugin writes
  and DSH reads. Every breakage above was a rename that produced no error at all:
  the plugin kept running and simply stopped drawing.
- **The settings card exists again, and its edits reach the plugin.** DSH 0.1.7
  replaced `ctx.settings` with a schema-derived **form** service that has no
  `register` at all, so the Host half's `inject(['settings'])` callback threw on
  its very first line — measured in DSH's own startup log as
  `TypeError: settings.register is not a function`. Everything after that line was
  skipped with it: the namespace was never published (no card, and nothing in the
  panel to say why) and `store.setRoots` never ran, so a `roots` override silently
  did nothing either. The plugin now **exports the `Config` schema its entry is
  configured by** — the settings domain builds the form from
  `entry.fiber.runtime.Config` and keeps only what sits under a `meta.volatile`
  node, skipping an entry that has neither — takes its configuration from the
  plugin row's own `config` argument, and the browser half addresses the form by
  **entry id** (`dsh-task-progress`, the `id` in `cordis.patch.yml`) rather than by
  the runtime namespace. A contract test reads both files and fails if they drift.
- **The plugin loads again: its `Config` now speaks Standard Schema.** cordis
  resolves a plugin's configuration with `runtime.Config['~standard'].validate(raw)`
  **before `apply` runs**. The exported schema had no `~standard` face, so the
  loader threw `TypeError: Cannot read properties of undefined (reading 'validate')`
  and the plugin never mounted at all — the state route answered 404, the shell
  environment stopped injecting `DSH_PROGRESS_DIR`, and both panels disappeared
  together, with nothing in the plugin's own output to read. Verified against
  cordis's own `resolveConfig`, which now returns the resolved section; a contract
  test pins the face.
- **An event that omits `state` now means `running`, as the protocol always said.**
  `PROTOCOL.md`'s field table documents `running` as `state`'s default, but the
  fold fell back to the previous value instead — so a producer that named a
  terminal state once and then kept appending messages stayed frozen there. The
  CLI made this the normal case: `emit` writes no `state` field unless `--state`
  is passed, so a watcher that had reported `done` and then kept reporting `{pct,
  msg}` showed a finished row for work that was plainly still running (and the
  reminder went on nagging about a job the file claimed had finished). Only an
  explicit `running` restarts a run's counters; an absent state flips the status
  and leaves the progress alone, because losing progress is the bigger surprise.
- **The reminder quotes the threshold the deployment actually set.** A 30-second
  `remindAfterMs` was announced as "over 1 min" — `Math.max(1, Math.round(ms /
  60_000))` — which overstated how long the job had been quiet and hid that the
  user had asked for a much shorter bar. Anything under a minute now reads in
  seconds. The test that asserted `/1 min/` had been pinning the bug, not catching
  it.
- **The security and install documentation now describes what the code does.**
  `SECURITY.md` still said `ctx.jobs.list(agent)` and described the settings card
  as writing "that namespace's user layer" — both were the pre-0.1.7 shapes
  (`list(caller)` takes a session id, and an entry is configured by its own
  `Config` schema rather than a runtime-registered namespace). The README now
  states plainly **what installing runs** (nothing: the package declares no
  `install`/`postinstall`/`prepare` script) and **how to verify the published
  bytes** against this source tree, because "trust the maintainer" was the only
  option it offered before.

## [0.2.0] — 2026-09-22

### Security

- **`--pattern` can no longer wedge a wrapped command.** The flag takes a regular
  expression from a command line the model writes, and `(a+)+$`-style nesting
  backtracks exponentially — measured, 20 characters of input took 10 ms and 40
  never finished. Such a pattern is now **refused with a message** rather than
  compiled (`patternRejection`), a custom pattern only ever sees the first 1000
  characters of a line, and the guard is exercised through the same path `run`
  takes, so disconnecting it fails the suite. The refusal came out of a security
  review of the unreleased work; the reach is the wrapped job's own process, never
  the DSH host.
- **`readTail` no longer reads into uninitialised memory.** It allocated with
  `allocUnsafe` and decoded the whole buffer while ignoring `readSync`'s return,
  so a file truncated between the `stat` and the read could be folded from heap
  bytes — and a run of them that happened to parse would go on the wire as a task
  message. The buffer is zero-filled and the read count is honoured.
- `requestedSession` parses its URL defensively; `src/protocol.ts` re-validates a
  task id and bounds a unit on the reading side as well as the writing one, so the
  browser is a last gate rather than a trusting one; the settle truncates the
  registry's `detail` where it is copied, not only where it is drawn.

### Fixed

- **A relative entry in Extra roots is dropped instead of resolved against
  wherever the DSH process was started.** The setting has always been documented
  as *absolute* roots, and the resolver accepted anything non-empty. An entry that
  is not absolute now disappears from the card after saving — visibly, because the
  card re-seeds from what the Host accepted. A drive-letter path, a UNC path, and a
  POSIX path are all absolute; a bare `relative/dir` is not.

### Added

- **`test/privacy.test.ts` now guards what a text scan cannot see.** It used to
  skip images, archives and anything over 4 MB, which left the committed
  screenshot — a surface that can show a wallpaper, a session title, another
  plugin's balance widget — outside every rule. It now refuses an image that is
  not in an explicit audited list, inspects the PNG chunks of the ones that are
  (no `tEXt`/`iTXt`/`zTXt`/`eXIf`/`tIME`), refuses an archive, refuses any file
  larger than the scan ceiling, and refuses an address that is not one of GitHub's
  noreply forms. Nine mutations confirm the new guards bite; the tenth is
  documented as intentionally undetectable (see below).
- **`SECURITY.md`** states the two things the reviews found it had left implicit:
  the reminder notice quotes the job's own command label, and the history rewrite
  removed paths naming *this machine* — the pre-rewrite blobs still hold synthetic
  drive-letter placeholders, which the worktree scan now refuses as well.

### Changed

- **`docs/PROTOCOL.md` names the one case the settle cannot see**: a second writer
  whose command line never mentions the task id is invisible to the live-job veto,
  so two writers on one id can still produce a row published as ended while the
  silent one works. The rule that prevents it (one writer per task id, and an id
  that appears in the command line) was already documented; it now says what
  happens when it is broken.

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

[0.2.1]: https://github.com/chen8923/dsh-task-progress/releases/tag/v0.2.1
[0.2.0]: https://github.com/chen8923/dsh-task-progress/releases/tag/v0.2.0
[0.1.1]: https://github.com/chen8923/dsh-task-progress/releases/tag/v0.1.1
[0.1.0]: https://github.com/chen8923/dsh-task-progress/releases/tag/v0.1.0
