# dsh-task-progress

**Live progress for long-running tasks in DeepSeek Harness.** A script reports
structured progress to a file; the Web UI shows it in a floating overlay and a
right-sidebar tab — no polling the agent, no waiting for the command to finish.

**Version 0.1.0** · MIT · [中文](README.zh.md) · [Changelog](CHANGELOG.md)

```
┌──────────────────────────────────────┐
│ ⟳ 2 tasks running                    │   ← floating pill, appears only while
└──────────────────────────────────────┘     something is running
┌──────────────────────────────────────┐
│ Long-task progress      2 running · 1│
│ ██████████░░░░░░░░░░  52%  build     │   ← click the pill, or open the
│ linking objects                      │     "Task progress" sidebar tab
│ 12m04s elapsed · 5/9 files · ~11m left│
└──────────────────────────────────────┘
```

## Why this exists

DSH's `pwsh`/`bash` tools are not streaming: a foreground command's output
appears only when it finishes, and a background job's output lives behind the
model's `job_output` cursor. The session-header job list shows status, but not a
single line of output. So a ten-minute build is a black box to the human watching
the GUI.

This plugin gives long tasks a **second, purpose-built channel** that is theirs to
write and the human's to read.

## Install

```bash
# from npm (once published)
dsh plugin --profile web add dsh-task-progress

# from a git checkout
dsh plugin --profile web add github:chen8923/dsh-task-progress

# from a local checkout of this repository (see Development)
./tools/rebuild.ps1 -Profile web -Checkout <path-to-dsh-checkout>
```

DSH mounts a profile bundle at startup, so **restart DSH** afterwards. The plugin
requires the Web profile (`webServer`, `connection`, `shellEnv`, and the right
sidebar); in a composition without them it stays unloaded and changes nothing.

## Use

Inside a DSH shell call the plugin hands the script its directory:

```powershell
# PowerShell — one append per event
$line = '{"v":1,"task":"build","state":"running","pct":42,"msg":"linking"}'
[System.IO.File]::AppendAllText(
  (Join-Path $env:DSH_PROGRESS_DIR 'build.jsonl'), $line + "`n",
  [System.Text.UTF8Encoding]::new($false))
```

```bash
# bash
printf '{"v":1,"task":"build","pct":42,"msg":"linking"}\n' >> "$DSH_PROGRESS_DIR/build.jsonl"
```

```python
# Python (any language works — it is just a file)
import json, os
path = os.path.join(os.environ["DSH_PROGRESS_DIR"], "build.jsonl")
with open(path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"v": 1, "task": "build", "pct": 42, "msg": "linking"}) + "\n")
```

Or let the bundled helper do the quoting:

```bash
node "$DSH_PROGRESS_CLI" emit --task build --pct 42 --msg "linking"
node "$DSH_PROGRESS_CLI" done --task build --msg "shipped"
node "$DSH_PROGRESS_CLI" list          # print what the directory currently says
```

Try it with no setup at all:

```powershell
pwsh ./examples/simulate.ps1 -Task demo -Steps 30 -DelayMs 500
```

Then open the **Task progress** tab in the right sidebar (or click the floating
pill once it appears).

### Out of the box

Installing the plugin is enough for the *agent* to know the convention: the host
half contributes a short section to the system prompt, right where the
background-jobs guidance already is, so the model arranges progress reporting for
long commands on its own. There is nothing to configure and no `AGENTS.md` edit —
a feature that only works after you edit your own instructions is not one you can
install.

If you want it stronger, or you run a composition without that prompt seam, the
same instruction can live in your workspace `AGENTS.md`:

```markdown
## Long-running tasks
For any command expected to run longer than ~30s, report progress from inside the
script to `$DSH_PROGRESS_DIR/<task>.jsonl` (one JSON line per event, see the
dsh-task-progress protocol), or use
`node "$env:DSH_PROGRESS_CLI" emit --task <id> --pct N --msg "..."`.
Never read the progress file back — it is for the human.
```

### When nothing appears

The panel shows what scripts report; it never reads a running job's output. A
background job started by a script that does not report is therefore invisible
here, and existing jobs cannot be retrofitted — but the sidebar tab says so
instead of looking broken: with jobs live and nothing reported, its empty state
names the count.

## Settings

The plugin registers one settings namespace, so its knobs are editable where
every plugin's are: **Settings → Plugins → Plugin configuration → Task progress**.

| Field | Default | Meaning |
| --- | --- | --- |
| Scan interval (ms) | `1000` | How often the Host half re-reads changed progress files. |
| Poll interval (ms) | `2000` | How often the browser asks for progress. |
| Keep finished for (ms) | `1800000` | How long a finished task stays listed. |
| Messages per task | `30` | Recent messages kept per task. |
| Max tasks | `200` | Cap on tasks in one state document. |
| File tail bytes | `262144` | Bytes read from the tail of one progress file. |
| Extra roots | – | Absolute paths whose `.dsh-progress` is scanned too. |

Saving writes the namespace's user layer into `$DSH_HOME/settings.yaml`; pressing
**Reset** (or emptying a field) removes the override, so the value falls back to
the plugin row's `config` and then to the schema default. Changes apply live: a
new scan interval re-arms the Host loops on their next tick, and the state
document's `pollMs` follows the value the browser should use.

`dirName` is deliberately absent from the panel — it is part of every path
already written, so it stays a composition-level setting on the plugin row.

## Design

Three layers, each independently replaceable — the point is that neither a
producer nor the UI knows about the other, and neither knows about DSH internals.

| Layer | What it is | Why it is shaped that way |
| --- | --- | --- |
| **Protocol** (`docs/PROTOCOL.md`) | Append-only JSONL, one file per task | Any language, no IPC, no ports, no auth, survives restarts. Works with the plugin uninstalled — the files are just files. |
| **Host half** | `ctx.shellEnv` contributor + directory poll + one HTTP route + a system-prompt section | Uses only public DSH seams (`webServer`, `connection`, `shellEnv`, `settings`, `systemPrompt`), and never touches the job registry. |
| **Browser half** | One polling store, two panels (`shell.overlay` + a sidebar tab), and a settings card | The panels read the same snapshot and the card reads its own namespace scope, so adding or removing a surface never touches the data path. |

**Why the plugin does not read job output.** `ctx.jobs.read()` consumes a
single-consumer cursor that belongs to the model's `job_output` tool; a browser
path reading it would silently steal bytes the model can then never see (DSH
pins that as a tested invariant). Progress here is therefore something the
*script* chooses to report, which is what makes this plugin safe to install
alongside anything else.

**Why polling instead of push.** The data is a couple of kilobytes of JSON on
localhost, and a poll loop is the one design that cannot desynchronize: every
reader sees the same last-wins document, a missed tick costs one interval, and
there is no reconnect logic to get wrong. The interval comes from the Host
half's configuration.

**Zero dependencies.** The host half imports Node built-ins only; the browser
half bundles everything it owns and treats `react` as a platform external. That
extends to the settings schema: `ctx.settings.register` takes a schemastery
schema, and this plugin supplies a minimal compatible node — callable for
resolution, `toJSON()` in schemastery's reference-graph form, and walkable by the
settings redactor — instead of depending on a package that a profile install
cannot resolve. Its own browser card passes a decoder so it never has to
rehydrate a schema envelope at all.

### What it deliberately does not do

- **No history.** Progress is live state, not a log; finished tasks age out.
- **No cancel button.** Stopping a job is the model's `job_kill` (a human-initiated
  interrupt needs a delivery-semantics decision this plugin does not own).
- **No remote producers.** Everything is local files in the workspace the session
  already writes to.
- **No session lookup.** Directories are learned from the shell calls that were
  handed them, plus configured roots — so the plugin never revives a session or
  reads a path the browser suggested.
- **No cross-session reads.** The state endpoint answers for exactly one session
  per request and puts no filesystem path on the wire. DSH's web login fences the
  whole instance rather than a session, so an endpoint that answered with
  everything the process knows would hand any authenticated caller every other
  session's task names and messages.

## Development

```bash
npm test          # 38 tests, one process (works in restricted sandboxes)
npm run test:runner   # the same suite through node --test
npm run build         # requires tsdown
```

Source layout:

```
src/protocol.ts        the shared contract (pure, bundled into both halves)
src/host/              settings namespace, store, shell-environment contributor, HTTP route, prompt section, entry
src/client/            polling store, formatting, settings form, React components, slots, styles
bin/dsh-progress.mjs   the dependency-free producer CLI
docs/PROTOCOL.md       the file contract and every configuration key
test/                  protocol, store, formatting, host-wiring, settings, prompt, and release suites
tools/                 test entry and the build/pack/install script
```

`lib/` is not committed: `npm run build` produces it, and `prepublishOnly` runs
that build so a publish can never ship a package without its entry points. The
suites run on Node 22.18+ (they execute the TypeScript sources directly through
type stripping), while the plugin itself runs on Node 20+.

### Releasing

```bash
npm test                                  # 69 checks, one process
npm publish                               # builds first, then publishes
git tag v0.1.0 && git push --tags
```

`test/release.test.ts` fails if the version in `package.json` is not also stated
in both READMEs and the changelog, if a documented example is missing from
`files`, or if the repository links disagree with the install instructions — so
the four places a version or a URL appears cannot drift apart.

## License

MIT
