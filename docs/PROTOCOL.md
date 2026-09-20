# The progress file protocol

The whole contract between a producer and this plugin is **one append-only file
per task**. Nothing in it mentions DSH, cordis, or the Web UI, which is what lets
a build script, a training run, a Python job, or a shell one-liner report
progress with no integration work.

## Where the file goes

```
<workspace>/.dsh-progress/<session-id>/<task>.jsonl
```

Inside a DSH model shell call the Host half sets the directory for you:

| Variable | Meaning |
| --- | --- |
| `DSH_PROGRESS_DIR` | The session's directory. Write `<task>.jsonl` here. |
| `DSH_PROGRESS_CLI` | Absolute path of the bundled `dsh-progress` helper (run with `node`). |

Both are injected per shell call by `ctx.shellEnv`, so an ordinary script only
has to say `$env:DSH_PROGRESS_DIR` / `$DSH_PROGRESS_DIR`. The directory is
created before the script starts.

Outside a DSH shell call (a scheduled job, a human at a terminal) the variable is
simply absent; pass the directory explicitly, or configure extra roots with the
plugin's `roots` option.

## One line per event

Each line is a JSON object. Fields are optional; **the last value of each field
wins**, so a producer that can only cheaply compute one thing per line just
sends that one thing.

```json
{"v":1,"task":"build","state":"running","pct":42,"msg":"linking objects","done":4,"total":9,"unit":"files","at":1730000000000}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | number | Protocol version. Currently `1`. Optional. |
| `task` | string | Task id, also the file's base name. Defaults to the file name. |
| `state` | string | `running` (default), `done`, `failed`, `cancelled`. |
| `pct` | number | Completion 0–100. Clamped. Derived from `done`/`total` when omitted. |
| `msg` | string | One status line. Longer messages are truncated to 200 characters. |
| `done` / `total` | number | Unit counters. |
| `unit` | string | Unit name, e.g. `files`, `frames`, `epochs`. |
| `at` | number | Producer clock in epoch milliseconds. Falls back to the file's mtime. |

### Rules that matter

- **Append, never rewrite.** One `>>` / `Add-Content` / `appendFile` per event.
  A whole-file rewrite also works but is detected only through size or mtime.
- **A task id is a file name.** 1–40 characters of `A-Z a-z 0-9 . _ -`, starting
  with an alphanumeric. Anything else is ignored by the reader.
- **A terminal state ends the run.** Appending `running` after `done` starts a new
  run: the clock and the percentage reset, while the recent-message history stays.
- **`done` with no percentage fills the bar** (100%).
- **Junk is tolerated.** Blank lines, banner text, a half-flushed tail, a UTF-8
  BOM on the first line — all dropped or skipped, never fatal.
- **Deleting the file deletes the task.** The Host half forgets it on the next
  scan.
- **Keep the file small.** The reader takes the last 256 KiB; older lines are
  ignored. Progress files are logs, not archives — point real logs elsewhere.

## How it is read

The Host half polls the directories it knows about (default every second) and
re-reads only files whose size or mtime moved. It folds each file into one task
record and serves the whole set as one document:

```
GET /plugins/task-progress/state        (same origin, cookie-authenticated)
{"v":1,"generatedAt":1730000000123,"pollMs":2000,"tasks":[ ... ]}
```

The browser half polls that endpoint (every `pollMs` while work is running, and
more slowly when idle) and renders it in the floating overlay and the sidebar
tab. Finished tasks stay visible for `retainMs` (30 minutes by default), then
age out.

## Configuration

Every key has a default, and unusable values are clamped rather than fatal. They
are editable in **Settings → Plugins → Plugin configuration → Task progress**:
saving writes the namespace's user layer into `$DSH_HOME/settings.yaml`, and
resetting a field removes the override so the value falls back to the plugin
row's `config` and then to the default below.

| Key | Default | Meaning |
| --- | --- | --- |
| `dirName` | `.dsh-progress` | Directory under each root. Composition-level only: it is part of every path already written, so the settings panel does not expose it. |
| `scanMs` | `1000` | Host re-read interval. |
| `pollMs` | `2000` | Interval advertised to the browser half. |
| `retainMs` | `1800000` | How long a finished task stays visible. |
| `historyLimit` | `30` | Distinct messages kept per task. |
| `maxTasks` | `200` | Cap on tasks in one document. |
| `maxFileBytes` | `262144` | Tail read from one progress file. |
| `roots` | `[]` | Extra absolute roots to discover directories under. |

A settings change is live. The Host half re-points its store, re-reads the extra
roots, and picks up a new scan interval on its next tick; the state document's
`pollMs` is read from the same value, so the browser follows without a reload.

```yaml
# A plugin row may still configure the composition base layer, which is what a
# field reverts to when the user clears it:
- insert:
    - id: dsh-task-progress
      name: dsh-task-progress
      config:
        pollMs: 1000
        retainMs: 600000
```
