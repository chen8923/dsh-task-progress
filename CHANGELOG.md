# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version here, in `package.json`, and in both READMEs is checked by
`test/release.test.ts`, so they cannot drift apart.

## [Unreleased]

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
