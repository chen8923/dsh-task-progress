# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version here, in `package.json`, and in both READMEs is checked by
`test/release.test.ts`, so they cannot drift apart.

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

[0.1.0]: https://github.com/OWNER/dsh-task-progress/releases/tag/v0.1.0
