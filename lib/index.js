import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
//#region src/protocol.ts
/** The read-only state endpoint the Host half serves and the browser half polls. */
const STATE_ROUTE = "/plugins/task-progress/state";
/**
* The settings namespace this plugin registers on the Host and keys its browser
* card on. Spelled once, here, because both halves must agree on it and the two
* halves must not import each other (the browser bundle may not pull Node code).
*/
const SETTINGS_NAMESPACE = "task-progress";
/** Task id: what a file is named after, and what the row is keyed by. */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** Session id segment: the directory level between the root and the files. */
const SESSION_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** True when `value` is usable as a task id (and therefore as a file name). */
function isValidTaskId(value) {
	return typeof value === "string" && TASK_ID_RE.test(value);
}
/** True when `value` is usable as the session directory segment. */
function isValidSessionSegment(value) {
	return typeof value === "string" && SESSION_SEGMENT_RE.test(value);
}
/** Normalize an unknown value to a known state, or null when it is not one. */
function normalizeState(value) {
	return value === "running" || value === "done" || value === "failed" || value === "cancelled" ? value : null;
}
/** True for the states that end a run. */
function isTerminal(state) {
	return state !== "running";
}
/** Clamp an unknown percentage into 0–100, or null when it is not a number. */
function clampPct(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(100, Math.max(0, value));
}
/** Trim an unknown value to a bounded single-line message, or ''. */
function normalizeMessage(value) {
	if (typeof value !== "string") return "";
	const single = value.replace(/[\r\n\t]+/g, " ").trim();
	return single.length > 200 ? `${single.slice(0, 199)}…` : single;
}
/** A finite non-negative number, or null. */
function nonNegative(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	return value;
}
/**
* Parse one produced line. Tolerant by design: a producer that writes a banner,
* a blank line, or a half-flushed tail must never break the fold, and a line
* that carries nothing usable is dropped rather than reported.
* @param line - one raw line from a progress file.
* @returns the event, or null when the line carries no usable event.
*/
function parseEvent(line) {
	const text = line.trim();
	if (text.length === 0 || text[0] !== "{") return null;
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record = raw;
	const state = normalizeState(record["state"]);
	const pct = clampPct(record["pct"]);
	const msg = normalizeMessage(record["msg"]);
	const done = nonNegative(record["done"]);
	const total = nonNegative(record["total"]);
	const at = nonNegative(record["at"]);
	const task = isValidTaskId(record["task"]) ? record["task"] : void 0;
	const unit = typeof record["unit"] === "string" ? record["unit"].slice(0, 24) : void 0;
	if (state === null && pct === null && msg.length === 0 && done === null && total === null) return null;
	return {
		v: typeof record["v"] === "number" ? record["v"] : void 0,
		task,
		state: state ?? void 0,
		pct: pct ?? void 0,
		msg: msg.length > 0 ? msg : void 0,
		at: at ?? void 0,
		done: done ?? void 0,
		total: total ?? void 0,
		unit: unit !== void 0 && unit.length > 0 ? unit : void 0
	};
}
/** The configuration every deployment gets when it configures nothing. */
const CONFIG_DEFAULTS = {
	dirName: ".dsh-progress",
	scanMs: 1e3,
	pollMs: 2e3,
	retainMs: 30 * 6e4,
	historyLimit: 30,
	maxTasks: 200,
	maxFileBytes: 256 * 1024,
	roots: [],
	remindAfterMs: 3e4,
	overlayUnreported: false
};
/** Directory names that are a single safe path segment. */
const DIR_NAME_RE$1 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** Clamp a number into a range, falling back to the default when unusable. */
function bounded(value, fallback, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}
/**
* The usable entries of a configured root list.
*
* The setting is documented as "extra absolute roots", and a relative entry would
* silently resolve against whatever directory the DSH process happens to have
* been started in — which is not a root anybody chose. Entries that are not
* absolute are dropped, deduplicated, and capped; a directory that does not exist
* is kept, because it may simply not exist yet.
* @param value - the raw setting.
* @returns absolute paths, in the order given.
*/
function absoluteRoots(value) {
	if (!Array.isArray(value)) return [...CONFIG_DEFAULTS.roots];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed.length === 0) continue;
		if (!isAbsolutePath(trimmed)) continue;
		seen.add(trimmed);
		if (seen.size >= 32) break;
	}
	return [...seen];
}
/** Whether a path is absolute on the platform this plugin is running on. */
function isAbsolutePath(value) {
	return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || value.startsWith("/");
}
/**
* Read the plugin row's configuration.
* @param raw - the config object DSH passed to `apply`, of unknown shape.
* @returns a complete configuration; unusable keys fall back to their defaults.
*/
function readConfig(raw) {
	const record = typeof raw === "object" && raw !== null ? raw : {};
	return {
		dirName: typeof record["dirName"] === "string" && DIR_NAME_RE$1.test(record["dirName"]) ? record["dirName"] : CONFIG_DEFAULTS.dirName,
		scanMs: bounded(record["scanMs"], CONFIG_DEFAULTS.scanMs, 250, 6e4),
		pollMs: bounded(record["pollMs"], CONFIG_DEFAULTS.pollMs, 500, 1e4),
		retainMs: bounded(record["retainMs"], CONFIG_DEFAULTS.retainMs, 0, 24 * 36e5),
		historyLimit: bounded(record["historyLimit"], CONFIG_DEFAULTS.historyLimit, 1, 200),
		maxTasks: bounded(record["maxTasks"], CONFIG_DEFAULTS.maxTasks, 1, 2e3),
		maxFileBytes: bounded(record["maxFileBytes"], CONFIG_DEFAULTS.maxFileBytes, 4096, 8 * 1024 * 1024),
		roots: absoluteRoots(record["roots"]),
		remindAfterMs: bounded(record["remindAfterMs"], CONFIG_DEFAULTS.remindAfterMs, 0, 36e5),
		overlayUnreported: typeof record["overlayUnreported"] === "boolean" ? record["overlayUnreported"] : CONFIG_DEFAULTS.overlayUnreported
	};
}
//#endregion
//#region src/jobs.ts
/** The two live statuses, spelled the same by the registry and the mirror. */
const LIVE_STATUSES = /* @__PURE__ */ new Set(["running", "stopping"]);
/** A delegated agent is a job, but it has no script of its own to report from. */
const NON_REPORTING_KIND = "subagent";
/**
* Shortest task name allowed to match inside a command label.
*
* A one- or two-character name (`a`, `up`) appears in almost every command line,
* so matching on it would silently hide jobs that never reported anything.
*/
const MIN_MATCH_LENGTH = 3;
/**
* Whether a job is still live.
* @param job - one job projection.
* @returns true for `running` and `stopping`.
*/
function jobIsLive(job) {
	return typeof job.status === "string" && LIVE_STATUSES.has(job.status);
}
/**
* Whether this job's producer could report progress at all.
* @param job - one job projection.
* @returns false for a delegated agent, which reports through its own transcript.
*/
function jobCanReport(job) {
	return job.kind !== NON_REPORTING_KIND;
}
/**
* The job's terminal status, or null while it is live (or unknown).
*
* Spelled here rather than compared to string literals at each call site,
* because two halves and three readings depend on agreeing about it: a job that
* ended is what the settle below turns into a task's ending.
* @param job - one job projection.
* @returns the outcome, or null for a job that is still live.
*/
function jobOutcome(job) {
	const status = job.status;
	return status === "completed" || status === "killed" || status === "failed" ? status : null;
}
/**
* The task state a job's outcome is read as.
*
* A job that exited on its own leaves work that finished; a killed one leaves
* work that was stopped; a failed one leaves work that broke. Nothing here
* consults the producer: it never got to speak.
* @param outcome - the job's terminal status.
* @returns the state the task is read as.
*/
function settledState(outcome) {
	if (outcome === "failed") return "failed";
	if (outcome === "killed") return "cancelled";
	return "done";
}
/**
* What the job registry proves about a task that still says `running`.
*
* A producer that is killed forces the question this protocol used to leave
* open: a task's ending was written by the script, so a script that never
* reached its last line leaves a row that says `running` forever. `job_kill`
* terminates the process tree — measured on Windows, it runs no user code at
* all, so neither `finally` nor any handler gets to report anything. The
* terminal line is not "missing yet"; it is never coming.
*
* The registry does know: a job's record outlives its process and says how it
* ended. So a `running` task whose writer's job has ended is *settled* from that
* record — in the reading, never in the file, which stays exactly what the
* producer wrote.
*
* The rule is deliberately narrow, because a false settle would hide work the
* user is waiting on, which is the failure this plugin exists to prevent:
*
* 1. the job's label must name the task (the same heuristic the unreported-job
*    rows use, and the reason a task id worth reporting is one that appears in
*    the command line);
* 2. **no live job may name that task** — a second writer still running means
*    the row is not orphaned, whatever an earlier one did;
* 3. the job must have existed before the task's last event and ended after it,
*    so a job from an earlier run (or a later one) cannot claim this ending;
* 4. the job must publish a start and a finish. `finishedAt` is the registry
*    invariant's "a terminal status has a finish", so a record without one is
*    not evidence.
*
* @param task - the task as the file folded it.
* @param jobs - this session's job projections, terminal ones included.
* @returns the settlement, or null when nothing proves the writer is gone.
*/
function settleTask(task, jobs) {
	if (jobs === void 0) return null;
	const named = jobs.filter((job) => jobCanReport(job) && labelNamesTask(job.label, task.task));
	if (named.length === 0) return null;
	if (named.some(jobIsLive)) return null;
	let best = null;
	let bestOutcome = null;
	for (const job of named) {
		const outcome = jobOutcome(job);
		const startedAt = job.startedAt;
		const finishedAt = job.finishedAt;
		if (outcome === null || typeof startedAt !== "number" || typeof finishedAt !== "number") continue;
		if (startedAt > task.updatedAt || finishedAt < task.updatedAt) continue;
		if (best === null || finishedAt > (best.finishedAt ?? 0)) {
			best = job;
			bestOutcome = outcome;
		}
	}
	if (best === null || bestOutcome === null) return null;
	return {
		job: best,
		outcome: bestOutcome,
		state: settledState(bestOutcome)
	};
}
/**
* Whether one reported task name is recognisable inside a job's command label.
*
* This is the reconciliation heuristic, and it is deliberately one-directional:
* a script that names its task after something in its own command line (the
* usual `--task sync-catalog` for `sync_catalog.py`) is recognised, and anything
* less obvious is treated as *not* reported. A false negative costs one extra
* reminder or one extra grey row; a false positive would hide a job the user is
* waiting on, which is the failure this whole plugin exists to fix.
*
* @param label - the job's label, usually the command line.
* @param task - a task name some producer reported.
* @returns true when the label mentions the task.
*/
function labelNamesTask(label, task) {
	if (typeof label !== "string" || label.length === 0) return false;
	if (task.length < MIN_MATCH_LENGTH) return false;
	return label.toLowerCase().includes(task.toLowerCase());
}
//#endregion
//#region src/host/reminder.ts
/**
* The reminder that makes the convention reachable without editing any file.
*
* A system-prompt section tells the model the convention once, among hundreds of
* other lines, at a moment when it is not yet making the decision. This module
* tells it *at the decision*: before each model step, if this session has a
* background job that has been running past the threshold and that no reported
* task accounts for, one notice rides along with that step.
*
* It reads only `ctx.jobs.list()` — registry **snapshots**, which are documented
* as non-consuming and leave the read cursor alone. A job's output stays the
* model's `job_output` cursor, exactly as before.
*
* Three properties matter more than the feature:
*
* 1. **It can never break a step.** Everything is wrapped: the downstream
*    decision is taken first and returned unchanged on any failure of ours.
* 2. **It never vetoes.** The listener delegates, then optionally appends. A
*    composition without `jobs` simply never registers it.
* 3. **It speaks once per job, and only about old ones.** The notice costs
*    context, so the threshold (default 30 s) and the per-job memory keep it
*    rare: a session whose scripts report, or whose jobs are short, pays nothing.
*
* @module dsh-task-progress/host/reminder
*/
/** Default delay before a silent job is mentioned to the model, milliseconds. */
const DEFAULT_REMIND_AFTER_MS = 3e4;
/** How many job labels the notice names before it just counts the rest. */
const MAX_LISTED_JOBS = 3;
/** Longest command label quoted into the notice. */
const MAX_LABEL_CHARS = 60;
/**
* The reported task names this session is currently reporting under.
* @param store - the task store.
* @param now - current epoch ms.
* @param sessionId - the session whose reports to read, when known.
* @returns live task names; empty when the session is unknown or reports nothing.
*/
function liveTaskNames(store, now, sessionId) {
	if (sessionId === void 0) return [];
	return store.snapshot(now, sessionId).tasks.filter((task) => task.state === "running").map((task) => task.task);
}
/**
* Whether a reported task already accounts for this job.
*
* Called only for jobs that are already past the threshold, so the cost is one
* fold of one session's small state document per candidate.
* @param job - the job under consideration.
* @param store - the task store.
* @param now - current epoch ms.
* @returns true when the job should be left alone.
*/
function isCovered(job, store, now) {
	return liveTaskNames(store, now, job.owner).some((name) => labelNamesTask(job.label, name));
}
/**
* The jobs worth one notice: live, able to report, past the threshold, unaccounted for.
* @param jobs - this agent's snapshots.
* @param store - the task store.
* @param now - current epoch ms.
* @param afterMs - how long a job must have been running; `0` disables the reminder.
* @param already - ids already mentioned to this agent.
* @returns the jobs to mention, in registry order.
*/
function dueForReminder(jobs, store, now, afterMs, already) {
	if (!(afterMs > 0)) return [];
	return jobs.filter((job) => !already.has(job.id) && job.status === "running" && jobCanReport(job) && typeof job.startedAt === "number" && now - job.startedAt >= afterMs && !isCovered(job, store, now));
}
/** Quote one job the way the notice names it. */
function describe(job) {
	const label = typeof job.label === "string" ? job.label.replace(/\s+/g, " ").trim() : "";
	const quoted = label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
	return quoted.length > 0 ? `${job.id} (${quoted})` : job.id;
}
/**
* The notice itself.
*
* It is written to prevent the one destructive reading a notice like this can
* invite: restarting work that is already halfway done is far worse than an
* empty panel, so the text forbids it in as many words.
* @param jobs - the jobs to mention.
* @param afterMs - the threshold that was crossed, for the wording.
* @returns the notice text.
*/
function reminderText(jobs, afterMs) {
	const minutes = Math.max(1, Math.round(afterMs / 6e4));
	const named = jobs.slice(0, MAX_LISTED_JOBS).map(describe).join(", ");
	const rest = jobs.length > MAX_LISTED_JOBS ? ` and ${jobs.length - MAX_LISTED_JOBS} more` : "";
	const plural = jobs.length === 1 ? "job has" : "jobs have";
	return `${jobs.length} background ${plural} been running for over ${minutes} min with no progress reported, so the user's progress panel shows nothing for ${jobs.length === 1 ? "it" : "them"}: ${named}${rest}. If a script is still working, have it append progress events to \`\$DSH_PROGRESS_DIR/<task>.jsonl\` (or run \`node "\$DSH_PROGRESS_CLI" emit --task <id> --pct N --msg "..."\`); if it cannot, tell the user these jobs have no progress detail. Do not restart a job that is already running.`;
}
/**
* Build one plugin-authored notice message.
*
* DSH builds these with `createUserMessage`, which only stamps a fresh uuid and
* a `user` role onto the given content and source. The shape is reproduced here
* rather than imported, because importing a DSH package would put a second
* dependency in a plugin whose whole installation story is "zero dependencies".
* @param text - the notice body.
* @returns a frozen message DSH can carry into the next step.
*/
function createReminderMessage(text) {
	const summary = text.slice(0, 80);
	return Object.freeze({
		id: randomUUID(),
		role: "user",
		content: Object.freeze([Object.freeze({
			type: "text",
			text
		})]),
		source: Object.freeze({
			kind: "plugin",
			plugin: "dsh-task-progress",
			form: "notice",
			summary
		})
	});
}
/**
* Register the reminder.
*
* `afterMs <= 0` disables it entirely, which is also how a composition opts out.
* A getter is accepted so a settings change takes effect on the next step
* instead of needing a reload.
* @param ctx - the host context carrying the agent-loop event bus.
* @param jobs - the job registry, read as snapshots only.
* @param store - the task store, consulted to avoid mentioning a job that reports.
* @param afterMs - how long a job must have been silent before the model hears about it.
* @returns the disposer that unregisters the listener.
*/
function registerProgressReminder(ctx, jobs, store, afterMs = DEFAULT_REMIND_AFTER_MS) {
	const readAfterMs = typeof afterMs === "function" ? afterMs : () => afterMs;
	if (typeof afterMs === "number" && !(afterMs > 0)) return () => {};
	/** Job ids already mentioned, per agent. Bounded by the live jobs of that agent. */
	const mentioned = /* @__PURE__ */ new WeakMap();
	return ctx.on("agent/pre-step", async (payload, next) => {
		const decision = await next();
		try {
			if (decision?.kind !== "enter") return decision;
			const threshold = readAfterMs();
			if (!(threshold > 0)) return decision;
			const agent = payload?.agent;
			if (typeof agent !== "object" || agent === null) return decision;
			const caller = typeof agent.id === "string" ? agent.id : void 0;
			if (caller === void 0) return decision;
			const now = Date.now();
			const snapshots = jobs.list(caller);
			const already = mentioned.get(agent) ?? /* @__PURE__ */ new Set();
			const live = new Set(snapshots.map((job) => job.id));
			for (const id of [...already]) if (!live.has(id)) already.delete(id);
			const due = dueForReminder(snapshots, store, now, threshold, already);
			if (due.length === 0) return decision;
			for (const job of due) already.add(job.id);
			mentioned.set(agent, already);
			const messages = decision.messages ?? [];
			return {
				...decision,
				messages: [...messages, createReminderMessage(reminderText(due, threshold))]
			};
		} catch {
			return decision;
		}
	});
}
//#endregion
//#region src/host/routes.ts
/**
* The session one request asks about.
*
* The route matches its path exactly, so the query string is the only input it
* reads at all: there is no body, no header, and no path segment to interpret.
*
* Defensive by construction: Node rejects a malformed request line before a
* handler ever runs, so an unparseable URL is unreachable in practice — but a
* request that cannot be parsed asks about no session, and "no session" is
* already answered with an empty document rather than an error.
* @param req - the incoming request.
* @returns the session id, or undefined when the caller named none.
*/
function requestedSession(req) {
	let url;
	try {
		url = new URL(String(req.url ?? "/"), "http://localhost");
	} catch {
		return;
	}
	const session = url.searchParams.get("session");
	return session === null || session.length === 0 ? void 0 : session;
}
/**
* Build the state handler.
* @param connection - the composition's trust fence.
* @param store - the store to serialize.
* @returns the route handler.
*/
function stateHandler(connection, store) {
	return (req, res) => {
		const rejection = connection.requestRejection(req);
		if (rejection !== void 0) {
			res.statusCode = rejection;
			res.end();
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.statusCode = 405;
			res.setHeader("allow", "GET, HEAD");
			res.end();
			return;
		}
		const body = JSON.stringify(store.snapshot(Date.now(), requestedSession(req)));
		res.statusCode = 200;
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.end(body);
	};
}
/**
* Register the state route.
* @param webServer - the composition's route table.
* @param connection - the composition's trust fence.
* @param store - the store to serialize.
* @returns the disposer that removes the route.
*/
function registerStateRoute(webServer, connection, store) {
	return webServer.register({
		kind: "exact",
		path: STATE_ROUTE,
		handler: stateHandler(connection, store)
	});
}
//#endregion
//#region src/host/settings.ts
/**
* The plugin's settings namespace: the one place its runtime knobs live.
*
* DSH's settings seam is "register and you are exposed": a Host plugin registers
* a namespace, the browser registers a card under that namespace's key in
* `settings.plugin.item`, and the Plugins section pairs the two without ever
* learning what the namespace means. This module is the Host half of that
* bargain.
*
* **Why the schema is hand-rolled.** `ctx.settings.register` takes a schemastery
* schema, and schemastery is not resolvable from a plugin installed into a
* profile (DSH itself lives in its own checkout; only plugins live beside the
* profile). Depending on it would mean either a bundled copy or a peer that a
* third-party install cannot satisfy. The service uses exactly three things from
* the schema, so this module provides exactly those:
*
* 1. it is **callable** — `resolve()` does `schema(mergeLayers(base, section))`
*    and takes the return value as the namespace's value;
* 2. it carries **`toJSON()`** — `describe()` serializes it into the descriptor
*    the browser receives;
* 3. it is **structurally walkable** — `redactSecrets` reads `type`, `meta.role`,
*    `dict`, and `inner` to find `role('secret')` fields. This namespace declares
*    none.
*
* Nothing else on a schema instance is consulted, and this module's tests pin
* all three. Normalization is total: a hand-edited `settings.yaml` is clamped
* into range rather than refused, so a typo can never strand a running plugin.
*
* @module dsh-task-progress/host/settings
*/
/** A bounded integer from an unknown value, falling back rather than throwing. */
function integer(value, fallback, min, max) {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}
/** A single safe path segment. */
const DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/**
* Resolve one candidate section into a complete, valid value.
*
* Total by design: every field falls back or clamps, so the only way to be
* wrong is to be out of range, never to be unusable.
* @param candidate - merged `base` and user layers, of unknown shape.
* @returns the resolved settings.
*/
function resolveProgressSettings(candidate) {
	const record = typeof candidate === "object" && candidate !== null ? candidate : {};
	return {
		dirName: typeof record["dirName"] === "string" && DIR_NAME_RE.test(record["dirName"]) ? record["dirName"] : CONFIG_DEFAULTS.dirName,
		scanMs: integer(record["scanMs"], CONFIG_DEFAULTS.scanMs, 250, 6e4),
		pollMs: integer(record["pollMs"], CONFIG_DEFAULTS.pollMs, 500, 1e4),
		retainMs: integer(record["retainMs"], CONFIG_DEFAULTS.retainMs, 0, 24 * 36e5),
		historyLimit: integer(record["historyLimit"], CONFIG_DEFAULTS.historyLimit, 1, 200),
		maxTasks: integer(record["maxTasks"], CONFIG_DEFAULTS.maxTasks, 1, 2e3),
		maxFileBytes: integer(record["maxFileBytes"], CONFIG_DEFAULTS.maxFileBytes, 4096, 8 * 1024 * 1024),
		roots: absoluteRoots(record["roots"]),
		remindAfterMs: integer(record["remindAfterMs"], CONFIG_DEFAULTS.remindAfterMs, 0, 36e5),
		overlayUnreported: typeof record["overlayUnreported"] === "boolean" ? record["overlayUnreported"] : CONFIG_DEFAULTS.overlayUnreported
	};
}
/** One numeric field node. */
function numberNode(defaultValue, min, max, description) {
	return {
		type: "number",
		meta: {
			default: defaultValue,
			min,
			max,
			description
		}
	};
}
/** The nodes describing this namespace's value, in field order. */
function fieldNodes() {
	return {
		dirName: {
			type: "string",
			meta: {
				default: CONFIG_DEFAULTS.dirName,
				description: "Directory under each root that holds progress files."
			}
		},
		scanMs: numberNode(CONFIG_DEFAULTS.scanMs, 250, 6e4, "How often the Host half re-reads changed progress files."),
		pollMs: numberNode(CONFIG_DEFAULTS.pollMs, 500, 1e4, "Poll interval advertised to the browser half."),
		retainMs: numberNode(CONFIG_DEFAULTS.retainMs, 0, 24 * 36e5, "How long a finished task stays visible."),
		historyLimit: numberNode(CONFIG_DEFAULTS.historyLimit, 1, 200, "Distinct messages kept per task."),
		maxTasks: numberNode(CONFIG_DEFAULTS.maxTasks, 1, 2e3, "Cap on tasks in one state document."),
		maxFileBytes: numberNode(CONFIG_DEFAULTS.maxFileBytes, 4096, 8 * 1024 * 1024, "Bytes read from the tail of one progress file."),
		roots: {
			type: "array",
			inner: {
				type: "string",
				meta: {}
			},
			meta: {
				default: [],
				description: "Extra absolute roots to discover progress directories under."
			}
		},
		remindAfterMs: numberNode(CONFIG_DEFAULTS.remindAfterMs, 0, 36e5, "How long a background job may run silently before the model is told once."),
		overlayUnreported: {
			type: "boolean",
			meta: {
				default: CONFIG_DEFAULTS.overlayUnreported,
				description: "Whether the floating panel may appear for a background job whose script reports nothing."
			}
		}
	};
}
/**
* Serialize the field nodes the way schemastery does.
*
* This is not cosmetic. `@deepseek-ai/schemastery`'s own `toJSON()` emits a
* *reference graph* — `{ uid, refs: { id: node } }` where a node's `dict` and
* `inner` hold child **ids**, and every node carries a `meta` object — and its
* constructor rehydrates exactly that shape. A hand-built envelope of inline
* nested nodes rehydrates into a partially-undefined schema and then throws
* while resolving, which is what a browser consumer hits when it validates a
* section against the descriptor we sent.
* @param fields - the live field nodes, sharing structure with the live schema.
* @returns the envelope to publish in a descriptor.
*/
function envelopeOf(fields) {
	const refs = {};
	let nextId = 0;
	const put = (node) => {
		nextId += 1;
		refs[String(nextId)] = node;
		return nextId;
	};
	const dict = {};
	for (const [field, node] of Object.entries(fields)) {
		if (node.type === "array") {
			const inner = put({
				type: node.inner?.type ?? "any",
				meta: node.inner?.meta ?? {}
			});
			dict[field] = put({
				type: node.type,
				meta: node.meta ?? {},
				inner
			});
			continue;
		}
		dict[field] = put({
			type: node.type,
			meta: node.meta ?? {}
		});
	}
	return {
		uid: put({
			type: "object",
			meta: { default: {} },
			dict
		}),
		refs
	};
}
/**
* Build the namespace schema.
*
* The returned object is one value serving three readers: the settings service
* calls it to resolve a section, serializes it with `toJSON()` for the browser
* descriptor, and walks `type`/`meta`/`dict`/`inner` to redact secrets (this
* namespace declares none).
* @returns a callable, serializable, walkable schema node for this namespace.
*/
function progressSchema() {
	const fields = fieldNodes();
	const schema = ((candidate) => resolveProgressSettings(candidate));
	Object.assign(schema, {
		type: "object",
		meta: { default: {} },
		dict: fields
	});
	schema.toJSON = () => envelopeOf(fields);
	return schema;
}
/**
* Register this plugin's settings namespace.
*
* The plugin row's own `config` becomes the composition **base** layer, which is
* what the configuration surface shows as the value a reset returns to; user
* edits sit above it in the profile's `settings.yaml`.
*
* @param settings - the live `ctx.settings` provider.
* @param base - the plugin row's config, if it declared one.
* @returns the owner handle, disposed with the calling fiber.
*/
function registerProgressSettings(settings, base) {
	return settings.register(SETTINGS_NAMESPACE, progressSchema(), {
		base: readConfig(base),
		applies: "live"
	});
}
//#endregion
//#region src/host/shell-env.ts
/** The directory a producer appends its `<task>.jsonl` files to. */
const PROGRESS_DIR_KEY = "DSH_PROGRESS_DIR";
/** Absolute path of the bundled `dsh-progress` helper, when it ships. */
const PROGRESS_CLI_KEY = "DSH_PROGRESS_CLI";
/**
* Read the reporting session's identity out of one execution.
* @param execution - the tool execution the environment is being built for.
* @returns the session id and workspace, or null when there is no session.
*/
function sessionOf(execution) {
	const header = execution?.agent?.session?.header;
	const id = header?.id;
	if (typeof id !== "string" || id.length === 0) return null;
	const cwd = header?.cwd;
	return {
		id,
		cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd()
	};
}
/**
* Register the progress environment variables.
*
* A call with no session (a host-level shell call) contributes nothing rather
* than a wrong path: the registry only injects the keys a resolver returns, so
* the producer simply does not see the variable.
*
* @param shellEnv - the live shell environment registry.
* @param store - the store that will read whatever is written.
* @param cliPath - absolute path of the bundled helper CLI, or null.
* @returns the disposer that unregisters the contribution.
*/
function registerProgressEnv(shellEnv, store, cliPath) {
	return shellEnv.register({
		name: "task-progress",
		variables: {
			[PROGRESS_DIR_KEY]: { description: "Directory for long-task progress files: append <task>.jsonl lines to report progress." },
			[PROGRESS_CLI_KEY]: { description: "Absolute path of the dsh-progress helper CLI (run it with node)." }
		},
		resolve: (execution) => {
			const session = sessionOf(execution);
			if (session === null) return {};
			const dir = store.remember(session.cwd, session.id);
			if (dir === null) return {};
			return cliPath === null ? { [PROGRESS_DIR_KEY]: dir } : {
				[PROGRESS_DIR_KEY]: dir,
				[PROGRESS_CLI_KEY]: cliPath
			};
		}
	});
}
//#endregion
//#region src/host/store.ts
/**
* The Host half's whole state: which directories to read, what their files last
* said, and what the browser should be told.
*
* Two deliberate simplifications keep this maintainable:
*
* - **No file watching.** A tick re-reads any file whose size or mtime moved.
*   `fs.watch` is platform-specific, fires duplicates, and loses events across
*   rename-on-write; a 1 s poll of a couple of small files costs nothing and
*   behaves identically everywhere. The browser polls the endpoint anyway.
* - **Refold from scratch.** A changed file is re-read and re-folded rather than
*   tracked by byte offset, so a truncated, rotated, or hand-edited file can
*   never desynchronize the store. Progress files are tiny and bounded.
*
* @module dsh-task-progress/host/store
*/
/** Suffix of a progress file. */
const FILE_SUFFIX = ".jsonl";
/**
* Most progress directories the host half watches at once.
*
* A long-lived instance sees a new session id for every session, fork and
* subagent, so this cap is reached in normal use. It is a working-set bound, not
* a refusal: the least recently used directory is evicted to make room, because
* silently leaving a live session untracked would lose its progress with no
* symptom anywhere.
*/
const MAX_DIRS = 64;
/** Most progress files tracked per directory. */
const MAX_FILES_PER_DIR = 64;
/**
* Read at most `maxBytes` from the tail of a file, dropping a partial first line.
*
* The buffer is zero-filled and the read count is honoured, rather than reading
* into `allocUnsafe` and decoding the whole buffer: a file truncated between the
* `stat` and the read (a producer rewriting its own file, an editor saving it)
* would otherwise fold whatever was in those heap bytes — and a stray run of them
* that happened to parse would go on the wire as a task message.
*/
function readTail(path, maxBytes) {
	const size = statSync(path).size;
	const start = size > maxBytes ? size - maxBytes : 0;
	if (size === 0) return "";
	const length = size - start;
	const buffer = Buffer.alloc(length);
	const fd = openSync(path, "r");
	let read = 0;
	try {
		read = readSync(fd, buffer, 0, length, start);
	} finally {
		closeSync(fd);
	}
	const text = buffer.subarray(0, read).toString("utf8");
	return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
}
/** Fold one file's lines into task records. */
function fold(text, base) {
	const tasks = /* @__PURE__ */ new Map();
	for (const line of text.split("\n")) {
		const event = parseEvent(line);
		if (event === null) continue;
		const id = event.task ?? base.fallbackTask;
		if (!isValidTaskId(id)) continue;
		const at = event.at ?? base.fallbackAt;
		let current = tasks.get(id);
		if (current === void 0) current = {
			sessionId: base.sessionId,
			task: id,
			state: "running",
			pct: null,
			msg: "",
			done: null,
			total: null,
			unit: "",
			startedAt: at,
			updatedAt: at,
			recent: []
		};
		else if (isTerminal(current.state) && event.state === "running") current = {
			...current,
			state: "running",
			pct: null,
			msg: "",
			done: null,
			total: null,
			startedAt: at,
			updatedAt: at,
			recent: []
		};
		let next = {
			...current,
			updatedAt: Math.max(current.updatedAt, at)
		};
		let state = next.state;
		if (event.state !== void 0) state = event.state;
		let pct = next.pct;
		if (event.pct !== void 0) pct = event.pct;
		else if (event.total !== void 0 && event.done !== void 0 && event.total > 0) pct = clampPct(event.done / event.total * 100);
		if (state === "done" && pct === null) pct = 100;
		if (event.done !== void 0) next = {
			...next,
			done: event.done
		};
		if (event.total !== void 0) next = {
			...next,
			total: event.total
		};
		if (event.unit !== void 0) next = {
			...next,
			unit: event.unit
		};
		if (event.msg !== void 0 && event.msg !== next.msg) next = {
			...next,
			msg: event.msg,
			recent: [...next.recent, event.msg].slice(-base.historyLimit)
		};
		tasks.set(id, {
			...next,
			state,
			pct
		});
	}
	return tasks;
}
/**
* Create the store.
* @param initial - the resolved configuration this store starts from.
* @returns the store the rest of the Host half uses.
*/
function createTaskStore(initial) {
	/**
	* The live configuration. Every read below goes through this binding, so a
	* settings change takes effect on the next tick without rebuilding the store
	* — which matters because the HTTP route holds a reference to it.
	*/
	let config = { ...initial };
	/** The job registry reader, once a composition supplies one; null asks nobody. */
	let jobs = null;
	const dirs = /* @__PURE__ */ new Map();
	/** Directories handed out through `remember`; discovery never claims these. */
	const remembered = /* @__PURE__ */ new Set();
	const files = /* @__PURE__ */ new Map();
	/**
	* Roots the plugin always looks under, added by the composition itself (its
	* working directory). Kept apart from the configured roots so a settings write
	* that replaces those cannot also drop these.
	*/
	const baseRoots = /* @__PURE__ */ new Set();
	/** Roots the settings namespace configures; `setRoots` replaces exactly these. */
	const configRoots = /* @__PURE__ */ new Set();
	const remember = (root, sessionId) => {
		if (root.length === 0 || !isValidSessionSegment(sessionId)) return null;
		const dir = join(root, config.dirName, sessionId);
		if (!dirs.has(dir) && dirs.size >= MAX_DIRS) evictLeastRecent();
		dirs.set(dir, {
			root,
			sessionId,
			lastUsedAt: Date.now()
		});
		remembered.add(dir);
		try {
			mkdirSync(dir, { recursive: true });
		} catch {}
		return dir;
	};
	/** Drop the directory nothing has touched for longest, to make room for a new one. */
	const evictLeastRecent = () => {
		let oldest;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [dir, tracked] of dirs) if (tracked.lastUsedAt < oldestAt) {
			oldest = dir;
			oldestAt = tracked.lastUsedAt;
		}
		if (oldest === void 0) return;
		forgetDir(oldest);
		remembered.delete(oldest);
	};
	const discover = () => {
		for (const root of /* @__PURE__ */ new Set([...baseRoots, ...configRoots])) {
			const parent = join(root, config.dirName);
			let entries;
			try {
				entries = readdirSync(parent, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() || !isValidSessionSegment(entry.name)) continue;
				const dir = join(parent, entry.name);
				const existing = dirs.get(dir);
				if (existing !== void 0) {
					existing.lastUsedAt = Date.now();
					continue;
				}
				if (dirs.size >= MAX_DIRS) evictLeastRecent();
				dirs.set(dir, {
					root,
					sessionId: entry.name,
					lastUsedAt: Date.now()
				});
			}
		}
	};
	/** Stop tracking one directory and forget every file folded under it. */
	const forgetDir = (dir) => {
		dirs.delete(dir);
		for (const path of [...files.keys()]) if (dirname(path) === dir) files.delete(path);
	};
	const scanDir = (dir, tracked, now) => {
		tracked.lastUsedAt = now;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			forgetDir(dir);
			return;
		}
		let seen = 0;
		/** Every file this directory holds right now, cap aside: the pruning key below. */
		const held = /* @__PURE__ */ new Set();
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(FILE_SUFFIX)) continue;
			held.add(entry.name);
			if (seen >= MAX_FILES_PER_DIR) continue;
			seen += 1;
			const path = join(dir, entry.name);
			let stats;
			try {
				stats = statSync(path);
			} catch {
				files.delete(path);
				continue;
			}
			const signal = `${stats.size}:${stats.mtimeMs}`;
			if (files.get(path)?.signal === signal) continue;
			let tasks;
			try {
				tasks = fold(readTail(path, config.maxFileBytes), {
					sessionId: tracked.sessionId,
					fallbackTask: entry.name.slice(0, -6),
					fallbackAt: Math.round(stats.mtimeMs),
					historyLimit: config.historyLimit
				});
			} catch {
				continue;
			}
			files.set(path, {
				signal,
				tasks
			});
			prune(tasks, now);
		}
		for (const path of [...files.keys()]) if (dirname(path) === dir && !held.has(basename(path))) files.delete(path);
	};
	const prune = (tasks, now) => {
		for (const [id, task] of tasks) if (isTerminal(task.state) && now - task.updatedAt > config.retainMs) tasks.delete(id);
	};
	const scan = (now = Date.now()) => {
		discover();
		for (const [dir, tracked] of [...dirs]) {
			if (!existsSync(dir)) {
				forgetDir(dir);
				continue;
			}
			scanDir(dir, tracked, now);
		}
		enforceBudget();
	};
	/**
	* A task as it should be read, once the job registry has been consulted.
	*
	* The fold never invents an ending: what the file says is what the file says.
	* This is the *reading*, and it exists because a producer can be killed
	* between two lines — on Windows by `taskkill`, which runs no user code, so
	* the terminal event is not late, it is never coming. The registry holds the
	* one fact that settles it: how the writing job ended.
	*
	* Three things move, and each is deliberate:
	*
	* - the **state**, from the job's outcome (`killed` reads as `cancelled`,
	*   `failed` as `failed`, a clean exit as `done`);
	* - **`updatedAt`**, to the job's finish, because that is when the reader
	*   learned the ending: the retention window then starts there instead of at
	*   a last report that may be hours old, and the row's duration becomes the
	*   run's real duration;
	* - **`ended`**, the marker that says this state was inferred, so nobody
	*   mistakes it for the producer's own last word.
	*
	* A percentage is never invented for a killed or failed run — the bar stops
	* where the producer left it. A `done` with no reported percentage fills the
	* bar, exactly as the fold does for a producer that says `done` itself.
	* @param task - one folded task.
	* @param source - the job registry reader, or null to read the file alone.
	* @returns the row to publish; the task itself when nothing proves it ended.
	*/
	const settle = (task, source) => {
		if (task.state !== "running" || source === null) return task;
		let found;
		try {
			found = source.jobsFor(task.sessionId);
		} catch {
			return task;
		}
		const settlement = settleTask(task, found);
		if (settlement === null) return task;
		const { job, outcome, state } = settlement;
		const detail = job.detail === void 0 ? "" : normalizeMessage(job.detail);
		const ended = detail.length === 0 ? {
			job: job.id,
			status: outcome
		} : {
			job: job.id,
			status: outcome,
			detail
		};
		return {
			...task,
			state,
			pct: state === "done" && task.pct === null ? 100 : task.pct,
			updatedAt: Math.max(task.updatedAt, job.finishedAt ?? task.updatedAt),
			ended
		};
	};
	/** Running work first, then the most recently touched, then by id — a total order. */
	const better = (left, right) => {
		const leftLive = isTerminal(left.state) ? 1 : 0;
		const rightLive = isTerminal(right.state) ? 1 : 0;
		if (leftLive !== rightLive) return leftLive - rightLive;
		if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
		return left.task.localeCompare(right.task);
	};
	/**
	* Keep the in-memory task set inside the bound the wire document already uses.
	*
	* `maxTasks` is the deployment's statement about how many tasks are worth
	* showing, and holding more than that serves nobody; the fold alone cannot
	* bound it, because a file may legally carry a new task id on every line.
	* Eviction drops the least interesting rows first (settled, then oldest), and a
	* running task evicted here returns on its next append — that append changes
	* the file, and a changed file is re-folded from scratch.
	*/
	const enforceBudget = () => {
		const budget = Math.max(1, config.maxTasks);
		let total = 0;
		for (const record of files.values()) total += record.tasks.size;
		if (total <= budget) return;
		const rows = [];
		for (const record of files.values()) for (const task of record.tasks.values()) rows.push({
			tasks: record.tasks,
			task
		});
		rows.sort((left, right) => better(left.task, right.task));
		for (const row of rows.slice(budget)) row.tasks.delete(row.task.task);
	};
	/**
	* The document one session receives.
	*
	* The session is required, not optional: answering "everything this process
	* knows" would hand any authenticated caller every other session's task names
	* and messages — the fence is the instance's login, not a session. A caller
	* that names no session gets an empty document, which is exactly what a
	* session with nothing to report gets.
	*
	* Every row is settled before it is published (see {@link settle}): a task
	* whose writer's job has ended is answered as ended, because the alternative
	* is a row that says `running` for the rest of the process's life.
	* @param now - current clock, epoch milliseconds.
	* @param sessionId - the session to answer for; absent answers for none.
	* @returns the session's tasks, ranked the way the panel reads them.
	*/
	const snapshot = (now = Date.now(), sessionId) => {
		const all = [];
		if (sessionId !== void 0 && sessionId.length > 0) for (const record of files.values()) for (const task of record.tasks.values()) {
			if (task.sessionId !== sessionId) continue;
			const row = settle(task, jobs);
			if (isTerminal(row.state) && now - row.updatedAt > config.retainMs) continue;
			all.push(row);
		}
		all.sort(better);
		return {
			v: 1,
			generatedAt: now,
			pollMs: config.pollMs,
			overlayUnreported: config.overlayUnreported,
			tasks: all.slice(0, config.maxTasks).map((task) => ({
				...task,
				recent: task.recent.slice(-5)
			}))
		};
	};
	return {
		remember,
		addRoot: (root) => {
			if (root.length > 0) baseRoots.add(root);
		},
		setRoots: (roots) => {
			configRoots.clear();
			for (const root of roots.slice(0, 32)) if (root.length > 0) configRoots.add(root);
			const live = /* @__PURE__ */ new Set([...baseRoots, ...configRoots]);
			for (const [dir, tracked] of [...dirs]) if (!remembered.has(dir) && !live.has(tracked.root)) forgetDir(dir);
		},
		reconfigure: (next) => {
			config = { ...next };
		},
		setJobSource: (source) => {
			jobs = source;
		},
		periodMs: () => config.scanMs,
		scan,
		snapshot,
		stats: () => {
			let tasks = 0;
			for (const record of files.values()) tasks += record.tasks.size;
			return {
				dirs: dirs.size,
				files: files.size,
				tasks
			};
		}
	};
}
//#endregion
//#region src/host/system-prompt.ts
/**
* The prompt section that makes this plugin work out of the box.
*
* Every shipped tool teaches its own convention through `ctx.systemPrompt`
* (`tool:pwsh`, `tool:jobs`, …). Without one, installing this plugin would still
* leave the panel empty forever: the *script* has to report progress, and the
* only thing that can tell the model to arrange that is the prompt. A user who
* has to edit their `AGENTS.md` before anything appears has not installed a
* feature, they have installed a chore.
*
* The section sits at the background-jobs tool's slot, because that is where the
* model already reads how long-running work is tracked, and it stays short: this
* is paid for in every session's context.
*
* @module dsh-task-progress/host/system-prompt
*/
/** Section name, as it appears in a prompt assembly. */
const PROMPT_SECTION_NAME = "task-progress";
/** The order slot this section shares with the background-jobs tool guidance. */
const PROMPT_ORDER_NAME = "TOOL_JOBS";
/** Fallback order, used only if a composition does not publish that slot name. */
const PROMPT_ORDER_FALLBACK = 1600;
/**
* The convention, in as few words as it can be stated.
*
* Four things are load-bearing here, and each was learned from a session where
* nothing appeared on the panel — or where too much did:
*
* - It is **imperative**. The first version said long tasks *can* report, which
*   reads as a capability note and was skipped; the model needs an instruction
*   attached to the decision, not a description of a feature.
* - It names **background jobs**. That is where long work actually goes, and the
*   first version never mentioned them.
* - It names the **consequence**. "The user gets an empty panel" is what makes
*   the instruction worth following rather than merely true.
* - It leads with the **wrapper**, because the cheapest recipe is the one the
*   model will take. A session that hand-wrote a producer spent six round trips
*   on setup — probing the tool's output, writing a script, fixing redirection
*   and encoding, syntax-checking — before any work started, and paid it again
*   for the next kind of command. `run` is one tool call, and the raw protocol is
*   still the escape hatch for what it cannot express.
*
* It stays short because every session pays for it, and it closes the one
* failure the model would otherwise cause: reading the file back, which is the
* human's view and not the model's.
* @returns the prompt text.
*/
function progressPromptText() {
	return "For any command you expect to run longer than about 30 seconds — including a background job — report live progress by wrapping it: `node \"$DSH_PROGRESS_CLI\" run --task <id> -- <command>` (it announces the task, follows the output, reads a percentage, and writes the ending from the exit code; the id must appear in that command line). If that cannot express the task, append one JSON event per update to `$DSH_PROGRESS_DIR/<task>.jsonl` (`{\"v\":1,\"task\":\"build\",\"state\":\"running\",\"pct\":40,\"msg\":\"linking\"}`; states running/done/failed/cancelled) or call `emit`/`done`/`fail`, naming the task after something recognisable in the command. A long command that reports nothing leaves the user staring at an empty progress panel. Never read the progress file back — it is the human's view.";
}
/**
* Register the convention.
* @param systemPrompt - the live system-prompt service.
* @returns the disposer that removes the section.
*/
function registerProgressPrompt(systemPrompt) {
	return systemPrompt.section({
		name: PROMPT_SECTION_NAME,
		order: systemPrompt.getSectionOrder("TOOL_JOBS") ?? PROMPT_ORDER_FALLBACK,
		text: progressPromptText()
	});
}
//#endregion
//#region src/host/index.ts
/**
* Host half of `dsh-task-progress`.
*
* Five seams, each with exactly one job:
*
* 1. {@link registerProgressSettings} registers the settings namespace whose
*    knobs the browser's configuration card edits, with this plugin row's own
*    `config` as the composition base layer.
* 2. {@link registerProgressEnv} hands every session shell call a progress
*    directory (`DSH_PROGRESS_DIR`) — the only thing a producer has to know.
* 3. {@link createTaskStore} folds whatever lands in those directories.
* 4. {@link registerStateRoute} serves the folded state to the Web UI behind the
*    composition's authentication fence.
* 5. {@link registerProgressReminder} tells the *model* about a background job
*    that has run past the threshold with nothing reported, at the step where it
*    can still act on that. It reads registry **snapshots** (`list()`), which DSH
*    documents as non-consuming.
*
* The plugin never reads a background job's **output**: `ctx.jobs.read()`
* consumes a single-consumer cursor that belongs to the model's `job_output`
* tool. Observing lifecycle snapshots is a different thing from reading output,
* and it is what makes this plugin able to say something without editing the
* user's `AGENTS.md`.
*
* @module dsh-task-progress/host
*/
/** Cordis function-plugin name. */
const name = "task-progress";
/**
* The routes, the trust fence, and the environment registry this plugin needs.
*
* `settings` and `systemPrompt` are deliberately absent: both are optional in a
* composition, so they are picked up through `ctx.inject` below. Requiring them
* here would take the whole plugin down — no route, no environment, no panels —
* in a deployment that simply has no settings document, or boots without the
* prompt assembly this plugin contributes a section to.
*/
const inject = [
	"webServer",
	"connection",
	"shellEnv"
];
/**
* Locate the bundled helper CLI next to the built plugin.
*
* `lib/index.js` is what runs, so `../bin/` is the package's own `bin/`
* directory. A source-tree run (tests) resolves to nothing, which is correct:
* there is no helper to advertise there.
* @returns the absolute path, or null when the CLI does not ship.
*/
function resolveCliPath() {
	try {
		const path = fileURLToPath(new URL("../bin/dsh-progress.mjs", import.meta.url));
		return existsSync(path) ? path : null;
	} catch {
		return null;
	}
}
/**
* Load the plugin.
* @param ctx - the host context carrying the route table, trust fence, and environment registry.
* @param rawConfig - this plugin row's configuration, of unknown shape; it becomes the settings base layer.
*/
function apply(ctx, rawConfig) {
	const config = readConfig(rawConfig);
	let liveConfig = config;
	const store = createTaskStore(config);
	store.addRoot(process.cwd());
	const cliPath = resolveCliPath();
	ctx.effect(() => registerProgressEnv(ctx.shellEnv, store, cliPath), "task-progress: progress environment");
	ctx.effect(() => registerStateRoute(ctx.webServer, ctx.connection, store), `task-progress: GET ${STATE_ROUTE}`);
	ctx.effect(() => {
		let active = true;
		let timer = null;
		const tick = () => {
			if (!active) return;
			try {
				store.scan();
			} catch {}
			if (!active) return;
			timer = setTimeout(tick, store.periodMs());
			timer.unref?.();
		};
		tick();
		return () => {
			active = false;
			if (timer !== null) clearTimeout(timer);
		};
	}, "task-progress: scan loop");
	ctx.inject(["settings"], (withSettings) => {
		const scope = registerProgressSettings(withSettings.settings, rawConfig);
		const applySettings = (next) => {
			liveConfig = next;
			store.reconfigure(next);
			store.setRoots(next.roots);
			store.scan();
		};
		applySettings(scope.get());
		withSettings.effect(() => scope.watch((next) => {
			applySettings(next);
		}), "task-progress: settings changes");
	});
	ctx.inject(["systemPrompt"], (withPrompt) => {
		withPrompt.effect(() => registerProgressPrompt(withPrompt.systemPrompt), "task-progress: prompt section");
	});
	ctx.inject(["jobs"], (withJobs) => {
		withJobs.effect(() => registerProgressReminder(withJobs, withJobs.jobs, store, () => liveConfig.remindAfterMs), "task-progress: unreported-job reminder");
	});
	ctx.inject(["jobs"], (withJobs) => {
		const source = { jobsFor: (sessionId) => withJobs.jobs.list(sessionId) };
		withJobs.effect(() => {
			store.setJobSource(source);
			return () => {
				store.setJobSource(null);
			};
		}, "task-progress: job settle source");
	});
}
//#endregion
export { CONFIG_DEFAULTS, DEFAULT_REMIND_AFTER_MS, PROGRESS_CLI_KEY, PROGRESS_DIR_KEY, PROMPT_ORDER_NAME, PROMPT_SECTION_NAME, SETTINGS_NAMESPACE, apply, createReminderMessage, createTaskStore, dueForReminder, inject, name, progressPromptText, progressSchema, readConfig, registerProgressEnv, registerProgressPrompt, registerProgressReminder, registerProgressSettings, registerStateRoute, reminderText, resolveProgressSettings, stateHandler };
