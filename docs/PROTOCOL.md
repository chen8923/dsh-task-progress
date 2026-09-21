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

The bundled CLI's `--task` follows the same rule as the reader, so it cannot
leave the progress directory. Its `--file` option deliberately does not: it
writes exactly the path given, which makes it the right tool for a producer
whose file layout is fixed and the wrong tool for anything whose arguments come
from somewhere you do not control (`clear --file` removes that path).

## Wrapping a command instead of writing a producer

The cheap path is the one to reach for first:

```
dsh-progress run --task sync-catalog -- python sync_catalog.py --task sync-catalog
```

It announces the task, follows the command's output, reports what it can read, and
writes the ending itself. Four things follow from that, and each one is a step
somebody used to have to write by hand:

- **Nothing to synthesise.** There is no script per task kind, so there is no
  PowerShell trap to discover, no `2>&1` to remember, no BOM to add and no syntax
  check to run before the work can start. That whole loop — probe, author, fix,
  re-encode, launch — is why setting a long task up used to cost more round trips
  than the task's first result.
- **The ending comes from the exit code.** A non-zero exit is `failed`, a clean one
  is `done` with a full bar, and a signal is `cancelled`. This is also the trap a
  hand-written producer walks into: in PowerShell a native command's non-zero exit
  does **not** throw, so a `catch`-only script reports a failed run as `done`.
- **Progress is read, not demanded.** A `12%` or a `12/88` anywhere in a line is
  understood without being told what the tool prints; `--pattern` covers the rest.
  Repeated identical lines do not fill the file — a change is reported, and so is
  the passage of time (every 30 s), because a command printing one unchanging line
  is still alive.
- **The task id is in the command line by construction**, which is the
  correlation the reader needs (see *When the writer dies*). A wrapper that is
  killed is settled from its job record like any other.

The relay is a **file**, not a pipe, and that is a hard constraint rather than a
preference: a shell running under DSH's sandbox cannot create the pipes a piped
child needs (`spawn` + `stdio: 'pipe'` fails with `EPERM`; the same spawn with a
file descriptor works — both measured on this project's machine). The command's
output is echoed to the wrapper's stdout as it arrives, so a job's output is still
there to read, and the relay file is removed when the run ends. A wrapper exits
with the wrapped command's exit code, so a shell can still branch on it.

For anything the wrapper cannot express — a producer inside a longer script, a
program that reports through a socket, a task stitched together from several
commands — the file format below is the whole contract, and it is small on
purpose.

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

The task rows a reader receives carry one more field, added to the wire for
inferred endings and never written by a producer:

| Field | Type | Meaning |
| --- | --- | --- |
| `ended` | object | Present only when the state was inferred from the job registry: `{job, status, detail?}` — the job that was writing, how it ended (`completed` \| `killed` \| `failed`), and its own detail line when it published one. See *When the writer dies*. |

### Rules that matter

- **Append, never rewrite.** One `>>` / `Add-Content` / `appendFile` per event.
  A whole-file rewrite also works but is detected only through size or mtime.
- **A task id is a file name.** 1–40 characters of `A-Z a-z 0-9 . _ -`, starting
  with an alphanumeric. Anything else is ignored by the reader.
- **A terminal state ends the run.** Appending `running` after `done` starts a new
  run: the clock and the percentage reset, while the recent-message history stays.
- **An ending is not only the producer's to write.** A script can be killed
  between two lines, and then no user code runs at all (see *When the writer
  dies*). Write the ending — it carries the real outcome and message — but do not
  rely on it being the only thing that ends the row.
- **Name the task after something in the command line.** The reader matches a
  task to the background job running it by looking for the task id inside the
  job's label, which for a shell job is the command. A task id that appears
  nowhere in the command is invisible to that match, and its row will keep
  reporting whatever the file last said.
- **One writer per task id.** Two jobs appending to one file is not a task with
  two writers: it is a task whose ending two of them cannot write, and whose
  percentage is whichever one appended last.
- **`done` with no percentage fills the bar** (100%).
- **Junk is tolerated.** Blank lines, banner text, a half-flushed tail, a UTF-8
  BOM on the first line — all dropped or skipped, never fatal.
- **Deleting the file deletes the task.** The Host half forgets it on the next
  scan — including when the scan was already past its read cap for that
  directory, because the listing is read whole and the cap only bounds the files
  actually re-folded.
- **Keep the file small.** The reader takes the last 256 KiB; older lines are
  ignored. Progress files are logs, not archives — point real logs elsewhere.

## How it is read

The Host half polls the directories it knows about (default every second) and
re-reads only files whose size or mtime moved. It folds each file into one task
record and answers **one session at a time**:

```
GET /plugins/task-progress/state?session=<session-id>   (same origin, cookie-authenticated)
{"v":1,"generatedAt":1730000000123,"pollMs":2000,"overlayUnreported":false,"tasks":[ ... ]}
```

`pollMs` and `overlayUnreported` ride this document rather than the settings
transport: every surface already polls here, and a panel that had to fetch its own
configuration before deciding whether to render would be a second data path to
keep correct. `overlayUnreported` is strictly `true` or absent — a deployment that
never configured it must not have its panel start summoning itself because a
proxy echoed something truthy.

The session is part of the request, not a filter applied afterwards. DSH's web
login is a fence around the whole instance rather than around a session, so an
endpoint that answered "everything this process knows" would hand any
authenticated caller every other session's task names and messages. A request
that names no session is therefore answered with an empty document, and an
unknown session id is indistinguishable from one with nothing to report.

The wire carries no filesystem path: a task is its session id, its task id, its
state, its message and its counters, and nothing else. Task names and messages
are still the *producer's* text — a script that puts a secret in a `--msg` value
is publishing it to anyone holding this instance's login.

The browser half polls that endpoint (every `pollMs` while work is running, and
more slowly when idle) and renders it in the floating overlay and the sidebar
tab. Finished tasks stay visible for `retainMs` (30 minutes by default), then
age out. `maxTasks` bounds both the document and the Host's in-memory task set,
so a producer that mints a new task id on every line cannot grow the process
without bound.

## When the writer dies

A task's ending used to have exactly one author: the script. That is a hole, not
a design, because the script is the thing that gets killed.

`job_kill` terminates the process tree. On Windows that is `taskkill`, which runs
**no user code**: a `finally` block does not run, no handler runs, and the
terminal event is not late — it is never coming. Measured rather than assumed: a
background `pwsh` job whose `finally` appends to a file, killed with `job_kill`,
wrote nothing after the kill. So a producer cannot be the only thing that ends a
row, however carefully its script is written.

The registry knows, because a job's record outlives its process:

```
{"task":"sync-catalog","state":"cancelled","pct":40,"updatedAt":1730000009000,
 "ended":{"job":"pwsh-7","status":"killed","detail":"signal: SIGTERM"}}
```

`ended` is the one field no producer writes. It appears exactly when the state
beside it was **inferred rather than reported**: the job writing the task had
ended while the file still said `running`. The mapping is total —

| job status | published state |
| --- | --- |
| `completed` | `done` (with `pct: 100` when the producer never reported one) |
| `killed` | `cancelled` |
| `failed` | `failed` |

— and three things move with it: the state, `updatedAt` (set to the job's finish,
so the retention window starts when the reader learned the ending and the row's
duration is the run's real duration), and the `ended` marker. The percentage is
whatever the producer last reported: a killed run never reported a completion,
and inventing 100% for it would be worse than showing where it stopped. The file
is not touched. The Host half reads the ending, it does not write one: the record
stays exactly what the producer wrote, so a later run that appends `running`
again supersedes the inference on its own.

The inference is deliberately narrow, because a wrong one would *hide* work the
user is waiting on — the failure this whole plugin exists to prevent:

1. the job's label must name the task (the same match the unreported-job rows
   use, which is why a task id worth reporting is one that appears in the command
   line);
2. **no live job may name that task** — a second writer still running means the
   row is not orphaned, whatever an earlier job did;
3. the job must have started before the task's last event and ended after it, so
   a job from an earlier run cannot claim this ending;
4. the job must publish both a start and a finish, which the registry's own
   invariant pairs with a terminal status.

A task nothing proves dead is left alone: a row that keeps saying `running` is
the honest answer to "nobody knows", and the panel's own *no update for …* marker
(60 s of silence) says the rest. Where the composition has no job registry — the
plugin uses `ctx.jobs` and `ctx.agents` through optional injection — nothing is
inferred at all, and the file is again the whole truth.

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
| `remindAfterMs` | `30000` | How long a background job may run with nothing reported before the Host tells the model **once** about it. It costs one short notice in that session's context, which is exactly why the number is editable in the panel rather than buried: `0` turns the reminder off, and that is a legitimate answer for somebody paying the context. |
| `overlayUnreported` | `false` | Whether the floating panel may **appear on its own** for a background job whose script reports nothing. Off by default: the floating panel is the one surface that interrupts, so it shows up for work the user asked to watch rather than for the absence of a report. Those rows are still in the sidebar tab, which a reader opens deliberately. |

A settings change is live. The Host half re-points its store, re-reads the extra
roots, and picks up a new scan interval on its next tick; the state document's
`pollMs` and `overlayUnreported` are read from the same value, so the browser
follows without a reload.

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
