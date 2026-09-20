window.__ModuleLoader__.load({
	id: "dsh-task-progress",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/** The read-only state endpoint the Host half serves and the browser half polls. */
		const STATE_ROUTE = "/plugins/task-progress/state";
		/**
		* The settings namespace this plugin registers on the Host and keys its browser
		* card on. Spelled once, here, because both halves must agree on it and the two
		* halves must not import each other (the browser bundle may not pull Node code).
		*/
		const SETTINGS_NAMESPACE = "task-progress";
		/**
		* The state URL for one session.
		*
		* The session is a required part of the request rather than a filter applied
		* after the fact: the endpoint answers for exactly the session asked about, so a
		* caller cannot read a sibling session's task names by asking for everything.
		* Omitting it is a valid request that returns no tasks at all.
		* @param sessionId - the session whose tasks to read.
		* @returns the relative URL to fetch.
		*/
		function stateUrl(sessionId) {
			return `${STATE_ROUTE}?session=${encodeURIComponent(sessionId)}`;
		}
		/** Normalize an unknown value to a known state, or null when it is not one. */
		function normalizeState(value) {
			return value === "running" || value === "done" || value === "failed" || value === "cancelled" ? value : null;
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
		* Parse a state document received over the wire. The browser half treats any
		* unusable result as "no data yet" rather than as an error: the endpoint is
		* same-origin and authenticated, so a bad body means a version mismatch or a
		* proxy, and the next poll is the remedy.
		* @param text - raw response body.
		* @returns the state, or null when it cannot be trusted.
		*/
		function parseState(text) {
			let raw;
			try {
				raw = JSON.parse(text);
			} catch {
				return null;
			}
			if (typeof raw !== "object" || raw === null) return null;
			const record = raw;
			const tasks = record["tasks"];
			if (!Array.isArray(tasks)) return null;
			const pollMs = nonNegative(record["pollMs"]);
			return {
				v: typeof record["v"] === "number" ? record["v"] : 1,
				generatedAt: nonNegative(record["generatedAt"]) ?? Date.now(),
				pollMs: pollMs === null ? 2e3 : Math.min(1e4, Math.max(500, pollMs)),
				tasks: tasks.map(parseTask).filter((task) => task !== null)
			};
		}
		/** Parse one task row, dropping anything structurally wrong. */
		function parseTask(raw) {
			if (typeof raw !== "object" || raw === null) return null;
			const record = raw;
			const state = normalizeState(record["state"]);
			const task = record["task"];
			if (state === null || typeof task !== "string" || task.length === 0) return null;
			const recent = Array.isArray(record["recent"]) ? record["recent"].filter((line) => typeof line === "string").slice(-5) : [];
			return {
				sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
				task,
				state,
				pct: clampPct(record["pct"]),
				msg: normalizeMessage(record["msg"]),
				done: nonNegative(record["done"]),
				total: nonNegative(record["total"]),
				unit: typeof record["unit"] === "string" ? record["unit"] : "",
				startedAt: nonNegative(record["startedAt"]) ?? 0,
				updatedAt: nonNegative(record["updatedAt"]) ?? 0,
				recent
			};
		}
		/**
		* Compact duration in at most two units — the scale a long task actually lives at.
		* @param ms - duration in milliseconds; negatives clamp to zero.
		* @returns e.g. `12s`, `3m04s`, `1h02m`.
		*/
		function formatDuration(ms) {
			const total = Math.max(0, Math.floor(ms / 1e3));
			const seconds = total % 60;
			const minutes = Math.floor(total / 60) % 60;
			const hours = Math.floor(total / 3600);
			if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
			if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
			return `${seconds}s`;
		}
		/** Wall-clock `HH:MM:SS` for the panel's "updated" line. */
		function formatClock(epochMs) {
			const date = new Date(epochMs);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}
		/**
		* The `done/total unit` figure, when the producer reported both.
		* @param task - the task to read.
		* @returns the figure, or null when the producer never reported units.
		*/
		function unitText(task) {
			if (task.done === null || task.total === null || task.total <= 0) return null;
			const unit = task.unit.length > 0 ? task.unit : "";
			return `${task.done}/${task.total}${unit.length > 0 ? ` ${unit}` : ""}`;
		}
		/**
		* Rough remaining time from the percentage and the elapsed clock.
		*
		* Deliberately crude: a progress file reports whatever a script can cheaply
		* know, so a linear estimate is the honest reading, and it is suppressed while
		* there is too little movement to mean anything.
		* @param task - the task to project.
		* @param now - current clock, epoch milliseconds.
		* @returns the estimate in milliseconds, or null when it cannot be made.
		*/
		function estimateRemainingMs(task, now) {
			if (task.state !== "running") return null;
			const pct = task.pct;
			if (pct === null || pct < 5 || pct >= 100) return null;
			const elapsed = now - task.startedAt;
			if (elapsed < 5e3) return null;
			return Math.round(elapsed / pct * (100 - pct));
		}
		/**
		* True when a running task has gone quiet for long enough to be worth saying so.
		* @param task - the task to check.
		* @param now - current clock, epoch milliseconds.
		* @param quietMs - the threshold, milliseconds.
		*/
		function isStalled(task, now, quietMs = 6e4) {
			return task.state === "running" && now - task.updatedAt > quietMs;
		}
		/**
		* The tasks one surface should show.
		*
		* Both surfaces share this so they can never disagree about what "visible"
		* means: the session filter is the same, and only the terminal-task window
		* differs (`active` keeps a brief tail so a finish is visible, `all` keeps
		* everything the Host half still retains).
		*
		* @param state - the latest state document, or null before the first poll.
		* @param sessionId - the session to scope to; undefined means every session.
		* @param now - current clock, epoch milliseconds.
		* @param mode - `active` for the compact overlay, `all` for the sidebar tab.
		* @returns the visible tasks, in the order the Host half ranked them.
		*/
		function selectTasks(state, sessionId, now, mode) {
			if (state === null) return [];
			const scoped = sessionId === void 0 || sessionId.length === 0 ? state.tasks : state.tasks.filter((task) => task.sessionId === sessionId);
			if (mode === "all") return [...scoped];
			return scoped.filter((task) => task.state === "running" || now - task.updatedAt < 1e4);
		}
		/** Count running tasks in a selection. */
		function countRunning(tasks) {
			return tasks.reduce((total, task) => total + (task.state === "running" ? 1 : 0), 0);
		}
		/**
		* The task a collapsed overlay should summarise: the running one that moved
		* most recently, falling back to the newest row of any state.
		* @param tasks - the visible selection.
		* @returns the task, or null when the selection is empty.
		*/
		function headlineTask(tasks) {
			const running = tasks.filter((task) => task.state === "running");
			const pool = running.length > 0 ? running : tasks;
			let best = null;
			for (const task of pool) if (best === null || task.updatedAt > best.updatedAt) best = task;
			return best;
		}
		/**
		* Percentage text, kept stable in width so a row does not jitter as it moves.
		* @param pct - the percentage, or null.
		* @returns e.g. `42%`, or `—` when the producer reported none.
		*/
		function formatPct(pct) {
			return pct === null ? "—" : `${Math.round(pct)}%`;
		}
		//#endregion
		//#region src/client/session-hook.ts
		/**
		* Read the session in view.
		* @param hook - the slot's selector hook, when it provides one.
		* @returns the session id, or undefined when the surface has no session in view.
		*/
		function useCurrentSession(hook) {
			const current = hook !== void 0 ? hook((state) => state.current) : void 0;
			return typeof current === "string" && current.length > 0 ? current : void 0;
		}
		/**
		* Count the live jobs in one session's mirror slice.
		* @param jobs - the session's job rows, or undefined when it has none.
		* @returns how many are running or stopping.
		*/
		function countRunningJobs(jobs) {
			if (jobs === void 0) return 0;
			return jobs.reduce((total, job) => total + (job.status === "running" || job.status === "stopping" ? 1 : 0), 0);
		}
		/**
		* Count the session's running background jobs.
		*
		* This is the browser-side job **mirror** — a snapshot DSH pushes for display —
		* not the job registry's output cursor. Reading it is free and steals nothing:
		* the plugin still never reads a job's output, which belongs to the model's
		* `job_output` tool alone. The count exists to explain an empty panel: a job
		* that runs without reporting progress is invisible here by design, and saying
		* so is better than looking broken.
		*
		* @param hook - the slot's selector hook, when it provides one.
		* @param sessionId - the session to count; undefined counts nothing.
		* @returns how many of that session's jobs are live.
		*/
		function useRunningJobCount(hook, sessionId) {
			return hook !== void 0 ? hook((state) => countRunningJobs(sessionId === void 0 ? void 0 : state.jobsBySession?.[sessionId])) : 0;
		}
		//#endregion
		//#region src/client/TaskList.tsx
		/** Locale key per lifecycle state. */
		const STATE_KEY = {
			running: "state.running",
			done: "state.done",
			failed: "state.failed",
			cancelled: "state.cancelled"
		};
		/**
		* The bar. An unreported percentage animates instead of inventing a number.
		* @param props - the task to draw.
		* @returns the bar element.
		*/
		function ProgressBar({ task }) {
			const indeterminate = task.pct === null && task.state === "running";
			const width = task.pct === null ? task.state === "running" ? 100 : 0 : task.pct;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dtp-track",
				role: "progressbar",
				"aria-valuemin": 0,
				"aria-valuemax": 100,
				"aria-valuenow": task.pct ?? void 0,
				"aria-label": `${task.task} ${formatPct(task.pct)}`,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dtp-fill",
					"data-state": task.state,
					"data-indeterminate": indeterminate ? "" : void 0,
					style: { width: `${width}%` }
				})
			});
		}
		/**
		* One row: name, state, bar, latest message, and the derived figures.
		* @param props - the task, translator, clock, and whether to name the session.
		* @returns the row element.
		*/
		function TaskRow({ task, t, now, showSession = false }) {
			const units = unitText(task);
			const remaining = estimateRemainingMs(task, now);
			const quiet = isStalled(task, now);
			const elapsed = task.state === "running" ? now - task.startedAt : task.updatedAt - task.startedAt;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "dtp-row",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dtp-rowHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dtp-name",
								title: task.task,
								children: task.task
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dtp-state",
								"data-state": task.state,
								children: t(STATE_KEY[task.state])
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dtp-pct",
								children: formatPct(task.pct)
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProgressBar, { task }),
					task.msg.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dtp-msg",
						title: task.msg,
						children: task.msg
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dtp-meta",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("meta.elapsed", { time: formatDuration(Math.max(0, elapsed)) }) }),
							units !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("meta.units", {
								done: task.done ?? 0,
								total: task.total ?? 0,
								unit: task.unit
							}) }) : null,
							remaining !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("meta.eta", { time: formatDuration(remaining) }) }) : null,
							quiet ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								"data-warn": "",
								children: t("meta.stalled", { time: formatDuration(now - task.updatedAt) })
							}) : null,
							showSession && task.sessionId.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("meta.session", { id: task.sessionId.slice(0, 8) }) }) : null
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/api.ts
		/**
		* The one request this plugin makes: read one session's state document.
		*
		* Same-origin and cookie-authenticated, exactly like the shell's own plugin
		* endpoints — the Host half fences the route with the composition's connection
		* trust, and the session travels as a query parameter so the answer is scoped to
		* what the caller is actually showing.
		*
		* @module dsh-task-progress/client/api
		*/
		/**
		* Read one session's current state.
		* @param sessionId - the session to read; the endpoint answers for exactly this one.
		* @param signal - caller lifetime; aborting it cancels the request.
		* @returns the parsed state, or null when the read did not produce a usable
		*   document (offline, rejected, mid-restart). Callers keep their last value.
		*/
		async function fetchState(sessionId, signal) {
			try {
				const response = await fetch(stateUrl(sessionId), {
					method: "GET",
					credentials: "same-origin",
					cache: "no-store",
					headers: { accept: "application/json" },
					signal
				});
				if (!response.ok) return null;
				return parseState(await response.text());
			} catch {
				return null;
			}
		}
		//#endregion
		//#region src/client/store.ts
		/** Polling defaults, chosen to be invisible on a local endpoint. */
		const DEFAULT_INTERVAL_MS = 2e3;
		const DEFAULT_IDLE_INTERVAL_MS = 8e3;
		/** How long a readerless session's snapshot is kept, so re-mounting is instant. */
		const DEFAULT_SESSION_TTL_MS = 6e4;
		/**
		* Create a progress store.
		* @param options - polling knobs and an injectable reader.
		* @returns the store; nothing happens until `start()`.
		*/
		function createProgressStore(options = {}) {
			const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
			const idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
			const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
			const read = options.read ?? fetchState;
			const sessions = /* @__PURE__ */ new Map();
			let timer = null;
			let controller = null;
			let active = false;
			const entryOf = (sessionId) => {
				let entry = sessions.get(sessionId);
				if (entry === void 0) {
					entry = {
						snapshot: null,
						listeners: /* @__PURE__ */ new Set(),
						lastUsedAt: Date.now()
					};
					sessions.set(sessionId, entry);
				}
				return entry;
			};
			/** Sessions somebody is currently reading. Only these are polled. */
			const liveSessions = () => [...sessions].filter(([, entry]) => entry.listeners.size > 0).map(([sessionId]) => sessionId);
			const announce = (entry) => {
				for (const listener of [...entry.listeners]) try {
					listener();
				} catch {}
			};
			/** Idle unless something is running and the page is actually being looked at. */
			const delay = () => {
				if (typeof document !== "undefined" && document.visibilityState === "hidden") return idleIntervalMs;
				for (const sessionId of liveSessions()) {
					const snapshot = sessions.get(sessionId)?.snapshot;
					if (snapshot?.tasks.some((task) => task.state === "running") === true) return snapshot.pollMs ?? intervalMs;
				}
				return idleIntervalMs;
			};
			/** Drop snapshots nothing has read for a while, so a long page does not grow. */
			const forgetIdleSessions = (now) => {
				for (const [sessionId, entry] of [...sessions]) if (entry.listeners.size === 0 && now - entry.lastUsedAt > sessionTtlMs) sessions.delete(sessionId);
			};
			const schedule = () => {
				if (!active) return;
				timer = setTimeout(() => {
					tick();
				}, delay());
			};
			const tick = async () => {
				if (!active) return;
				timer = null;
				const targets = liveSessions();
				if (targets.length > 0) {
					controller = new AbortController();
					try {
						await Promise.all(targets.map(async (sessionId) => {
							const next = await read(sessionId, controller?.signal ?? new AbortController().signal);
							if (!active || next === null) return;
							const entry = sessions.get(sessionId);
							if (entry === void 0) return;
							entry.snapshot = next;
							announce(entry);
						}));
					} finally {
						controller = null;
					}
				}
				forgetIdleSessions(Date.now());
				schedule();
			};
			return {
				start: () => {
					if (active) return () => {};
					active = true;
					tick();
					return () => {
						active = false;
						if (timer !== null) clearTimeout(timer);
						timer = null;
						controller?.abort();
						controller = null;
						sessions.clear();
					};
				},
				subscribe: (sessionId, listener) => {
					const entry = entryOf(sessionId);
					entry.listeners.add(listener);
					entry.lastUsedAt = Date.now();
					if (entry.snapshot === null && active && timer !== null) {
						clearTimeout(timer);
						tick();
					}
					return () => {
						entry.listeners.delete(listener);
						entry.lastUsedAt = Date.now();
					};
				},
				getSnapshot: (sessionId) => sessions.get(sessionId)?.snapshot ?? null,
				refresh: () => {
					if (!active) return;
					if (timer !== null) clearTimeout(timer);
					tick();
				}
			};
		}
		/** The page's single store: one poll loop however many sessions are in view. */
		const progressStore = createProgressStore();
		//#endregion
		//#region src/client/useProgress.ts
		/**
		* React bindings for the page's progress store.
		*
		* `useSyncExternalStore` is exactly the contract the store already offers —
		* a stable snapshot between changes and a subscribe function — so no context,
		* no provider, and no re-render plumbing is needed for a face-wide surface and
		* a sidebar tab to read the same value.
		*
		* @module dsh-task-progress/client/useProgress
		*/
		/**
		* Subscribe to one session's progress document.
		*
		* The subscription is per session because the Host half answers per session: a
		* surface only ever holds the data of the session it is showing.
		* @param sessionId - the session to read; undefined reads nothing and renders none.
		* @param store - the store to read; defaults to the page's single store.
		* @returns the latest document, or null before the first successful poll.
		*/
		function useProgress(sessionId, store = progressStore) {
			const subscribe = (0, react.useCallback)((listener) => sessionId === void 0 ? () => {} : store.subscribe(sessionId, listener), [store, sessionId]);
			const getSnapshot = (0, react.useCallback)(() => sessionId === void 0 ? null : store.getSnapshot(sessionId), [store, sessionId]);
			return (0, react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
		}
		/**
		* A clock that ticks only while it is being watched.
		*
		* Every live figure (elapsed, remaining, "quiet for") is derived from this, so
		* one interval updates a whole panel instead of one per row — and an idle panel
		* on a hidden tab costs nothing.
		*
		* @param intervalMs - tick period, milliseconds.
		* @param enabled - false stops the timer entirely (nothing on screen is moving).
		* @returns the current clock, epoch milliseconds.
		*/
		function useNow(intervalMs, enabled) {
			const [now, setNow] = (0, react.useState)(() => Date.now());
			(0, react.useEffect)(() => {
				if (!enabled) return;
				setNow(Date.now());
				const timer = setInterval(() => setNow(Date.now()), intervalMs);
				return () => clearInterval(timer);
			}, [intervalMs, enabled]);
			return now;
		}
		//#endregion
		//#region src/client/ProgressBody.tsx
		/**
		* What a producer must do, shown only while there is nothing to show.
		* @param props - the translator.
		* @returns the empty state.
		*/
		function EmptyState({ t, unreportedJobs }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dtp-empty",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dtp-emptyTitle",
						children: t("tab.emptyTitle")
					}),
					unreportedJobs > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dtp-emptyRunning",
						children: t("tab.emptyRunning", { count: unreportedJobs })
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("tab.emptyBody") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						className: "dtp-code",
						children: `node "$env:DSH_PROGRESS_CLI" emit --task build --pct 10 --msg "linking"

'{"v":1,"task":"build","state":"running","pct":42,"msg":"linking"}' |
  Add-Content -Encoding utf8 (Join-Path $env:DSH_PROGRESS_DIR build.jsonl)`
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dtp-note",
						children: t("tab.emptyNote")
					})
				]
			});
		}
		/**
		* The right-sidebar tab body.
		* @param props - the translator, this tab's session, and the session selector hook.
		* @returns the list, or the empty state that documents the contract.
		*/
		function ProgressBody({ t, sessionId, useSessions }) {
			const state = useProgress(sessionId);
			const unreportedJobs = useRunningJobCount(useSessions, sessionId);
			const now = useNow(1e3, (state?.tasks.length ?? 0) > 0);
			const tasks = selectTasks(state, sessionId, now, "all");
			if (tasks.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EmptyState, {
				t,
				unreportedJobs
			});
			const running = countRunning(tasks);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dtp-body",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: "dtp-bodyHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dtp-bodyTitle",
							children: t("tab.heading")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dtp-bodyCounts",
							children: t("tab.counts", {
								running,
								finished: tasks.length - running
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dtp-list",
						children: tasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskRow, {
							task,
							t,
							now
						}, `${task.sessionId}:${task.task}`))
					}),
					state !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("footer", {
						className: "dtp-bodyFoot",
						children: t("tab.updated", { time: formatClock(state.generatedAt) })
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/ProgressOverlay.tsx
		/**
		* The floating surface: a compact pill that expands into the task list.
		*
		* Registered into `shell.overlay`, the frame-wide layer above every column. That
		* layer is click-through by design, so this entry opts back into pointer events
		* on exactly its own two boxes — the rest of the frame stays usable while the
		* pill is on screen.
		*
		* It renders nothing at all when there is nothing to report: an idle session
		* must not grow a floating widget.
		*
		* @module dsh-task-progress/client/ProgressOverlay
		*/
		/**
		* The floating progress overlay.
		* @param props - the translator and the session selector hook.
		* @returns the pill (or expanded card), or null when nothing is running.
		*/
		function ProgressOverlay({ t, useSessions }) {
			const current = useCurrentSession(useSessions);
			const state = useProgress(current);
			const [open, setOpen] = (0, react.useState)(false);
			const now = useNow(1e3, (state?.tasks.length ?? 0) > 0);
			const tasks = selectTasks(state, current, now, "active");
			if (tasks.length === 0) return null;
			const running = countRunning(tasks);
			const headline = headlineTask(tasks);
			const label = running === 1 ? t("overlay.activeOne") : t("overlay.active", { count: running });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dtp-overlay",
				children: open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: "dtp-card",
					"aria-label": t("tab.heading"),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: "dtp-cardHead",
						children: [
							running > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dtp-spinner",
								"aria-hidden": "true"
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dtp-cardTitle",
								children: t("tab.heading")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dtp-cardCount",
								children: t("tab.counts", {
									running,
									finished: tasks.length - running
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dtp-cardClose",
								"aria-label": t("overlay.collapse"),
								onClick: () => setOpen(false),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
									width: "12",
									height: "12",
									viewBox: "0 0 12 12",
									"aria-hidden": "true",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
										d: "M2 3h8M2 6h8M2 9h8",
										stroke: "currentColor",
										strokeWidth: "1.4",
										strokeLinecap: "round"
									})
								})
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dtp-list",
						children: tasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskRow, {
							task,
							t,
							now,
							showSession: current === void 0
						}, `${task.sessionId}:${task.task}`))
					})]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dtp-pill",
					"aria-expanded": false,
					"aria-label": t("overlay.expand"),
					onClick: () => setOpen(true),
					children: [
						running > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dtp-spinner",
							"aria-hidden": "true"
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dtp-pillText",
							children: label
						}),
						headline !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dtp-pillTask",
							children: [headline.task, headline.pct !== null ? ` ${Math.round(headline.pct)}%` : ""]
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
							width: "10",
							height: "10",
							viewBox: "0 0 12 12",
							"aria-hidden": "true",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
								d: "M3 8l3-4 3 4",
								fill: "none",
								stroke: "currentColor",
								strokeWidth: "1.4",
								strokeLinecap: "round"
							})
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/SettingsCard.tsx
		/**
		* The settings card: this plugin's knobs, inside DSH's plugin configuration.
		*
		* Registered into the keyed `settings.plugin.item` slot under the settings
		* namespace this plugin owns, which is the documented way a plugin distributed
		* outside DSH's own repository reaches the settings page. The card renders its
		* own controls — the section dispatches namespaces and stacks what comes back,
		* it does not render forms for anyone.
		*
		* Its disclosure behaviour deliberately mirrors the cards DSH ships, because a
		* row that looks like its neighbours but does not behave like them is worse than
		* one that looks different: the whole header is the toggle, it starts collapsed,
		* staged edits survive collapsing (so the header carries the unsaved marker),
		* and a successful save closes it again.
		*
		* @module dsh-task-progress/client/SettingsCard
		*/
		/**
		* The fields this card edits, in reading order: how often the Host half looks,
		* how often the browser asks, and how much is kept.
		*
		* `dirName` is deliberately absent: it is composition-level (it is part of every
		* path already written) and stays a plugin-row setting.
		*/
		const FIELDS = [
			{
				field: "scanMs",
				kind: "number"
			},
			{
				field: "pollMs",
				kind: "number"
			},
			{
				field: "retainMs",
				kind: "number"
			},
			{
				field: "historyLimit",
				kind: "number"
			},
			{
				field: "maxTasks",
				kind: "number"
			},
			{
				field: "maxFileBytes",
				kind: "number"
			},
			{
				field: "roots",
				kind: "list"
			}
		];
		/** The glyph the header toggles with; inline so no icon package is needed. */
		function Chevron({ open }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				className: open ? "dtp-setChevron dtp-setChevronOpen" : "dtp-setChevron",
				width: "14",
				height: "14",
				viewBox: "0 0 16 16",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M4 6.5l4 4 4-4",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.6",
					strokeLinecap: "round"
				})
			});
		}
		/**
		* Render one field's row.
		* @param props - the card props plus this field's state and spec.
		* @returns the row.
		*/
		function Field({ t, spec, text, overridden, invalid, disabled, onEdit, onReset }) {
			const id = `dtp-setting-${spec.field}`;
			const hint = t(`settings.${spec.field}.hint`);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dtp-setField",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dtp-setLabelRow",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "dtp-setLabel",
								htmlFor: id,
								children: t(`settings.${spec.field}`)
							}),
							overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dtp-setOverride",
								children: t("settings.overridden")
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dtp-setReset",
								disabled: disabled || !overridden,
								onClick: onReset,
								children: t("settings.reset")
							})
						]
					}),
					spec.kind === "number" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id,
						className: "dtp-setInput",
						type: "text",
						inputMode: "numeric",
						spellCheck: false,
						value: text,
						disabled,
						"aria-invalid": invalid || void 0,
						onChange: (event) => {
							onEdit(event.target.value);
						}
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						id,
						className: "dtp-setInput dtp-setTextarea",
						rows: 3,
						spellCheck: false,
						value: text,
						disabled,
						"aria-invalid": invalid || void 0,
						onChange: (event) => {
							onEdit(event.target.value);
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: invalid ? "dtp-setHint dtp-setHintBad" : "dtp-setHint",
						children: invalid ? t("settings.invalid") : hint
					})
				]
			});
		}
		/**
		* The plugin's settings card.
		* @param props - the translator, the form snapshot source, and its actions.
		* @returns the card, or null while the namespace is not served here.
		*/
		function SettingsCard(props) {
			const { t } = props;
			const state = (0, react.useSyncExternalStore)(props.subscribe, props.getSnapshot, props.getSnapshot);
			const [open, setOpen] = (0, react.useState)(false);
			const saveStarted = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (state.saving) {
					saveStarted.current = true;
					return;
				}
				if (!saveStarted.current) return;
				saveStarted.current = false;
				if (!state.dirty && !state.failed) setOpen(false);
			}, [
				state.dirty,
				state.failed,
				state.saving
			]);
			if (!state.available) return null;
			const title = t("settings.title");
			const disabled = !state.writable;
			const blocked = !state.dirty || state.invalid || state.saving;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: open ? "dtp-set dtp-setOpen" : "dtp-set",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dtp-setHeader",
					"aria-expanded": open,
					"aria-label": `${t(open ? "settings.collapse" : "settings.expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dtp-setHeadText",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dtp-setTitle",
								children: title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dtp-setDescription",
								children: t("settings.description")
							})]
						}),
						state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dtp-setPending",
							children: t("settings.unsaved")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chevron, { open })
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dtp-setBody",
					children: [
						disabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dtp-setNotice",
							role: "status",
							children: t("settings.readonly")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dtp-setFields",
							children: FIELDS.map((spec) => {
								const field = state.fields[spec.field];
								return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									t,
									spec,
									text: field?.text ?? "",
									overridden: field?.overridden ?? false,
									invalid: field?.invalid ?? false,
									disabled,
									onEdit: (text) => {
										props.edit(spec.field, text);
									},
									onReset: () => {
										props.resetField(spec.field);
									}
								}, spec.field);
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dtp-setFoot",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dtp-setFootText",
									children: [state.failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dtp-setNoticeBad",
										role: "status",
										children: t("settings.failed")
									}) : null, state.invalid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dtp-setNotice",
										children: t("settings.blocked")
									}) : null]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dtp-setDiscard",
									disabled: !state.dirty || state.saving,
									onClick: props.discard,
									children: t("settings.discard")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dtp-setSave",
									disabled: disabled || blocked,
									onClick: props.save,
									children: t(state.saving ? "settings.saving" : "settings.save")
								})
							]
						})
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/definition.tsx
		/** This tab kind, and the key its body registers under. */
		const TAB_KIND = "task-progress";
		/** Three rising bars: "work in progress", drawn inline so no icon package is needed. */
		function ProgressGlyph({ size = 16, className }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				className,
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "2",
						y: "9.5",
						width: "3",
						height: "4.5",
						rx: "1",
						fill: "currentColor"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "6.5",
						y: "6",
						width: "3",
						height: "8",
						rx: "1",
						fill: "currentColor",
						opacity: "0.75"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "11",
						y: "2.5",
						width: "3",
						height: "11.5",
						rx: "1",
						fill: "currentColor",
						opacity: "0.5"
					})
				]
			});
		}
		/**
		* Build this plugin's tab definition.
		* @param t - namespace-bound translate, read fresh on every label call.
		* @returns the definition to register.
		*/
		function taskProgressDefinition(t) {
			return {
				id: TAB_KIND,
				kind: TAB_KIND,
				title: () => t("tab.title"),
				guide: [{
					order: 60,
					title: () => t("guide.title"),
					description: () => t("guide.description"),
					icon: ProgressGlyph
				}]
			};
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Dictionaries for this plugin's own locale namespace.
		*
		* The namespace is private to the package: no dependence on another package's
		* keys and no patched first-party locale file. Lookup falls back to the shared
		* `common` vocabulary and finally to the key itself, so a missing translation
		* degrades to a visible key rather than a crash.
		*/
		/** The plugin's locale namespace. */
		const NS = "taskProgress";
		/** Chinese dictionary. */
		const zh = {
			"overlay.label": "任务进度",
			"overlay.active": "{count} 个任务进行中",
			"overlay.activeOne": "1 个任务进行中",
			"overlay.expand": "展开任务进度",
			"overlay.collapse": "收起任务进度",
			"overlay.empty": "没有进行中的任务",
			"tab.title": "任务进度",
			"guide.title": "任务进度",
			"guide.description": "脚本自报的长任务进度",
			"tab.heading": "长任务进度",
			"tab.emptyTitle": "还没有任务在报告进度",
			"tab.emptyRunning": "{count} 个后台任务正在运行，但它们还没有报告进度。",
			"tab.emptyBody": "把结构化进度追加到 $DSH_PROGRESS_DIR/<task>.jsonl，这个面板就会出现。",
			"tab.emptyNote": "该目录按会话隔离，DSH_PROGRESS_DIR 只在模型执行的 shell 调用里可用。",
			"tab.counts": "{running} 进行中 · {finished} 已结束",
			"tab.updated": "更新于 {time}",
			"state.running": "进行中",
			"state.done": "已完成",
			"state.failed": "失败",
			"state.cancelled": "已取消",
			"meta.units": "{done}/{total} {unit}",
			"meta.elapsed": "已用 {time}",
			"meta.eta": "剩余约 {time}",
			"meta.stalled": "已 {time} 无更新",
			"meta.session": "会话 {id}",
			"meta.source": "来自 {task}",
			"recent.title": "最近消息",
			"settings.title": "任务进度设置",
			"settings.description": "长任务的扫描、上报与保留策略。留空并保存即可恢复默认值。",
			"settings.scanMs": "扫描间隔（毫秒）",
			"settings.scanMs.hint": "宿主重新读取进度文件的频率。",
			"settings.pollMs": "上报间隔（毫秒）",
			"settings.pollMs.hint": "浏览器界面查询进度的频率。",
			"settings.retainMs": "完成后保留（毫秒）",
			"settings.retainMs.hint": "任务结束后仍在列表里停留的时间。",
			"settings.historyLimit": "每任务消息上限",
			"settings.historyLimit.hint": "展开面板里保留的最近消息条数。",
			"settings.maxTasks": "任务数上限",
			"settings.maxTasks.hint": "一次状态文档最多返回多少个任务。",
			"settings.maxFileBytes": "单文件读取上限（字节）",
			"settings.maxFileBytes.hint": "每个进度文件从尾部读取多少字节。",
			"settings.roots": "额外根目录",
			"settings.roots.hint": "每行一个绝对路径；这些目录下的 .dsh-progress 也会被扫描。",
			"settings.overridden": "已覆盖",
			"settings.unsaved": "未保存",
			"settings.expand": "展开设置",
			"settings.collapse": "收起设置",
			"settings.reset": "重置",
			"settings.save": "保存",
			"settings.saving": "保存中…",
			"settings.discard": "放弃",
			"settings.invalid": "请输入有效的值。",
			"settings.blocked": "有字段无效，无法保存。",
			"settings.failed": "保存未生效，请重试。",
			"settings.readonly": "当前连接不接受写入。"
		};
		/** English dictionary; every key above must exist here (it is the fallback). */
		const en = {
			"overlay.label": "Task progress",
			"overlay.active": "{count} tasks running",
			"overlay.activeOne": "1 task running",
			"overlay.expand": "Expand task progress",
			"overlay.collapse": "Collapse task progress",
			"overlay.empty": "No running tasks",
			"tab.title": "Task progress",
			"guide.title": "Task progress",
			"guide.description": "Long tasks that report their own progress",
			"tab.heading": "Long-task progress",
			"tab.emptyTitle": "No task is reporting yet",
			"tab.emptyRunning": "{count} background job(s) are running but report no progress yet.",
			"tab.emptyBody": "Append structured progress to $DSH_PROGRESS_DIR/<task>.jsonl and it shows up here.",
			"tab.emptyNote": "That directory is per session; DSH_PROGRESS_DIR exists only inside model shell calls.",
			"tab.counts": "{running} running · {finished} finished",
			"tab.updated": "updated {time}",
			"state.running": "Running",
			"state.done": "Done",
			"state.failed": "Failed",
			"state.cancelled": "Cancelled",
			"meta.units": "{done}/{total} {unit}",
			"meta.elapsed": "{time} elapsed",
			"meta.eta": "~{time} left",
			"meta.stalled": "no update for {time}",
			"meta.session": "session {id}",
			"meta.source": "from {task}",
			"recent.title": "Recent messages",
			"settings.title": "Task progress settings",
			"settings.description": "How long-task progress is scanned, polled, and retained. Clear a field and save to restore its default.",
			"settings.scanMs": "Scan interval (ms)",
			"settings.scanMs.hint": "How often the Host re-reads changed progress files.",
			"settings.pollMs": "Poll interval (ms)",
			"settings.pollMs.hint": "How often the browser asks for progress.",
			"settings.retainMs": "Keep finished for (ms)",
			"settings.retainMs.hint": "How long a finished task stays listed.",
			"settings.historyLimit": "Messages per task",
			"settings.historyLimit.hint": "Recent messages kept per task.",
			"settings.maxTasks": "Max tasks",
			"settings.maxTasks.hint": "Cap on tasks in one state document.",
			"settings.maxFileBytes": "File tail bytes",
			"settings.maxFileBytes.hint": "Bytes read from the tail of one progress file.",
			"settings.roots": "Extra roots",
			"settings.roots.hint": "One absolute path per line; .dsh-progress under them is scanned too.",
			"settings.overridden": "Overridden",
			"settings.unsaved": "Unsaved",
			"settings.expand": "Expand settings",
			"settings.collapse": "Collapse settings",
			"settings.reset": "Reset",
			"settings.save": "Save",
			"settings.saving": "Saving…",
			"settings.discard": "Discard",
			"settings.invalid": "Enter a valid value.",
			"settings.blocked": "A field is invalid, so nothing can be saved.",
			"settings.failed": "The save did not land; try again.",
			"settings.readonly": "This connection does not accept writes."
		};
		//#endregion
		//#region src/client/settings-form.ts
		/**
		* Accept one section as the settings transport delivered it.
		*
		* A bound scope needs a decoder. Without one it rehydrates the descriptor's
		* serialized schema with schemastery to validate the value — a wire dependency
		* on a library this plugin deliberately does not ship, and one whose failure
		* mode is silent: an envelope the client cannot rehydrate vouches for no
		* section at all, so the scope never leaves `loading` and the card renders
		* nothing. The Host already resolved the section through the namespace's own
		* schema, so the honest decoder takes it as it stands.
		*
		* @param section - the section from the settings mirror, of unknown shape.
		* @returns the section as a plain object, or undefined when it is not one.
		*/
		function decodeSettingsSection(section) {
			return typeof section === "object" && section !== null && !Array.isArray(section) ? section : void 0;
		}
		/** A whole-number field. An empty draft clears it; anything unparseable blocks the save. */
		function numberField(field) {
			return {
				field,
				format: (value) => typeof value === "number" ? String(value) : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					const parsed = Number(trimmed);
					return Number.isFinite(parsed) ? {
						kind: "set",
						value: parsed
					} : void 0;
				}
			};
		}
		/**
		* A string list edited as one line per entry.
		* An empty box clears the field, so emptying it and saving is the same gesture
		* as resetting it.
		* @param field - field name inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function listField(field) {
			return {
				field,
				format: (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join("\n") : "",
				parse: (text) => {
					const entries = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
					return entries.length === 0 ? { kind: "clear" } : {
						kind: "set",
						value: entries
					};
				}
			};
		}
		/**
		* Create the form over one settings namespace.
		* @param scope - the bound client scope for this plugin's namespace.
		* @param specs - the fields this card edits.
		* @returns the form and its actions.
		*/
		function createSettingsForm(scope, specs) {
			const byField = new Map(specs.map((spec) => [spec.field, spec]));
			const staged = /* @__PURE__ */ new Map();
			const listeners = /* @__PURE__ */ new Set();
			let saving = false;
			let failed = false;
			let cached = null;
			const snapshot = () => scope.getSnapshot();
			const sectionValue = (field) => snapshot().value?.[field];
			const baseValue = (field) => snapshot().base?.[field];
			const userLayer = () => snapshot().user;
			const stored = (field) => {
				const user = userLayer();
				return user !== void 0 && Object.hasOwn(user, field);
			};
			const spec = (field) => {
				const found = byField.get(field);
				if (found === void 0) throw new Error(`settings card has no field ${field}`);
				return found;
			};
			/** Every write a save would perform, in staging order. */
			const plan = () => {
				const planned = [];
				for (const [field, edit] of staged) {
					if (edit.clear) {
						if (stored(field)) planned.push({ run: () => clear(field) });
						continue;
					}
					if (edit.text === spec(field).format(sectionValue(field))) continue;
					const write = spec(field).parse(edit.text);
					if (write === void 0) planned.push({ run: void 0 });
					else if (write.kind === "clear") planned.push({ run: () => clear(field) });
					else planned.push({ run: () => store(field, write.value) });
				}
				return planned;
			};
			const clear = async (field) => {
				await scope.unset(field);
				return !stored(field);
			};
			const store = async (field, value) => {
				await scope.set(field, value);
				return userLayer()?.[field] === value;
			};
			const project = () => {
				const view = snapshot();
				const planned = plan();
				const fields = {};
				for (const { field } of specs) {
					const edit = staged.get(field);
					if (edit === void 0) {
						fields[field] = {
							text: spec(field).format(sectionValue(field)),
							overridden: stored(field),
							invalid: false
						};
						continue;
					}
					const write = edit.clear ? { kind: "clear" } : spec(field).parse(edit.text);
					fields[field] = {
						text: edit.text,
						overridden: write?.kind === "set",
						invalid: write === void 0
					};
				}
				return {
					available: view.status === "ready",
					writable: view.writable,
					dirty: planned.length > 0,
					invalid: planned.some((entry) => entry.run === void 0),
					saving,
					failed,
					fields
				};
			};
			const publish = () => {
				cached = null;
				for (const listener of [...listeners]) try {
					listener();
				} catch {}
			};
			scope.subscribe(publish);
			const stage = (field, edit) => {
				staged.set(field, edit);
				failed = false;
				publish();
			};
			return {
				getSnapshot: () => cached ??= project(),
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				edit: (field, text) => {
					stage(field, {
						text,
						clear: false
					});
				},
				resetField: (field) => {
					stage(field, {
						text: spec(field).format(baseValue(field)),
						clear: true
					});
				},
				discard: () => {
					if (staged.size === 0 && !failed) return;
					staged.clear();
					failed = false;
					publish();
				},
				save: () => {
					const planned = plan();
					const writes = planned.flatMap((entry) => entry.run === void 0 ? [] : [entry.run]);
					if (planned.length === 0 || saving || writes.length !== planned.length) return;
					saving = true;
					failed = false;
					publish();
					(async () => {
						let landed = true;
						for (const write of writes) try {
							landed = await write() && landed;
						} catch {
							landed = false;
						}
						if (landed) staged.clear();
						saving = false;
						failed = !landed;
						publish();
					})();
				}
			};
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* The plugin's stylesheet, injected once as a `<style>` element.
		*
		* A standalone client bundle has no CSS-module toolchain behind it and the
		* loader transports no stylesheets, so the module body injects its own `<style>`
		* (which the module system then claims for this plugin id). Every selector is
		* `dtp-` prefixed, and the only shared surface used is the theme's `--dsw-*`
		* custom properties — the same intentional seam the shipped client plugins use,
		* which is what makes this panel follow light/dark themes for free.
		*/
		/** Marks the injected sheet so the module loader can attribute it to this plugin. */
		const STYLE_ID = "dsh-task-progress";
		const CSS = `
.dtp-overlay {
  position: fixed;
  right: 20px;
  bottom: 96px;
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
}

.dtp-pill,
.dtp-card {
  pointer-events: auto;
}

.dtp-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 360px;
  padding: 6px 12px;
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.3));
  border-radius: 999px;
  background: var(--dsw-specific-input-major, rgba(28, 28, 32, 0.92));
  box-shadow: var(--dsw-shadow-lv3, 0 6px 20px rgba(0, 0, 0, 0.28));
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  backdrop-filter: blur(8px);
}

.dtp-pill:hover {
  border-color: var(--dsw-alias-state-business-primary, #4f8cff);
}

.dtp-pillText {
  flex: none;
  font-variant-numeric: tabular-nums;
}

.dtp-pillTask {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dtp-card {
  display: flex;
  flex-direction: column;
  width: 360px;
  max-width: min(360px, calc(100vw - 48px));
  max-height: min(52vh, 520px);
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.3));
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, rgba(22, 22, 26, 0.96));
  box-shadow: var(--dsw-shadow-lv3, 0 10px 30px rgba(0, 0, 0, 0.35));
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-size: 12px;
  backdrop-filter: blur(10px);
}

.dtp-cardHead,
.dtp-bodyHead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.2));
}

.dtp-cardTitle,
.dtp-bodyTitle {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #e8e8ea);
}

.dtp-cardCount,
.dtp-bodyCounts {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-variant-numeric: tabular-nums;
}

.dtp-cardClose {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font: inherit;
  cursor: pointer;
}

.dtp-cardClose:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16));
  color: var(--dsw-alias-label-primary, #e8e8ea);
}

.dtp-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  list-style: none;
}

.dtp-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.dtp-rowHead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.dtp-name {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dtp-state {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16));
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  font-size: 11px;
  line-height: 16px;
}

.dtp-state[data-state='done'] { color: var(--dsw-alias-state-success-primary, #2ea043); }
.dtp-state[data-state='failed'] { color: var(--dsw-alias-state-error-primary, #e5534b); }
.dtp-state[data-state='cancelled'] { color: var(--dsw-alias-state-warn-primary, #d29922); }

.dtp-pct {
  flex: none;
  margin-left: auto;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  font-variant-numeric: tabular-nums;
}

.dtp-track {
  position: relative;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.2));
}

.dtp-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary, #4f8cff);
  transition: width 240ms ease-out;
}

.dtp-fill[data-state='done'] { background: var(--dsw-alias-state-success-primary, #2ea043); }
.dtp-fill[data-state='failed'] { background: var(--dsw-alias-state-error-primary, #e5534b); }
.dtp-fill[data-state='cancelled'] { background: var(--dsw-alias-state-warn-primary, #d29922); }

/* No percentage reported: motion says "working" without inventing a number. */
.dtp-fill[data-indeterminate] {
  width: 35% !important;
  animation: dtp-slide 1.4s ease-in-out infinite;
}

@keyframes dtp-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(320%); }
}

.dtp-msg {
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dtp-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.dtp-meta > span + span::before {
  margin-right: 10px;
  content: '·';
}

.dtp-meta [data-warn] { color: var(--dsw-alias-state-warn-primary, #d29922); }

.dtp-spinner {
  flex: none;
  width: 12px;
  height: 12px;
  border: 2px solid var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.3));
  border-top-color: var(--dsw-alias-state-business-primary, #4f8cff);
  border-radius: 50%;
  animation: dtp-spin 0.9s linear infinite;
}

@keyframes dtp-spin {
  to { transform: rotate(360deg); }
}

.dtp-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-size: 12px;
}

.dtp-body .dtp-list {
  flex: 1;
  min-height: 0;
}

.dtp-bodyFoot {
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.2));
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 11px;
}

.dtp-empty {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 14px;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
}

.dtp-emptyTitle {
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-weight: 600;
}

.dtp-emptyRunning { color: var(--dsw-alias-state-warn-primary, #d29922); }

.dtp-code {
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.2));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.08));
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 16px;
  white-space: pre;
}

.dtp-note {
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 11px;
  line-height: 16px;
}

/* ---- settings card, inside DSH's plugin configuration section ---- */

.dtp-set {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin: 0;
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(128, 128, 128, 0.25));
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, 0.06));
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font-size: 13px;
}

/* The header is the disclosure toggle, exactly as the shipped cards are: the
   whole row is the button, so the gesture is the same everywhere. */
.dtp-setHeader {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.dtp-setHeader:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.08)); }

.dtp-setHeadText {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dtp-setChevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  transition: transform 160ms ease;
}

.dtp-setChevronOpen { transform: rotate(180deg); }

.dtp-setBody {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px 14px 14px;
}

.dtp-setTitle { font-weight: 600; }

.dtp-setDescription {
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 12px;
  line-height: 18px;
}

.dtp-setFields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dtp-setField {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.dtp-setLabelRow {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dtp-setLabel { color: var(--dsw-alias-label-secondary, #a9a9b2); }

/* The unsaved marker the collapsed header carries, and the per-field override
   badge — the same shape, two different facts. */
.dtp-setPending,
.dtp-setOverride {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16));
  font-size: 11px;
  line-height: 16px;
}

.dtp-setPending { color: var(--dsw-alias-label-secondary, #a9a9b2); }
.dtp-setOverride { color: var(--dsw-alias-state-business-primary, #4f8cff); }

.dtp-setReset {
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.dtp-setReset:disabled { opacity: 0.4; cursor: default; }
.dtp-setReset:not(:disabled):hover { color: var(--dsw-alias-label-primary, #e8e8ea); }

.dtp-setInput {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  border-radius: 8px;
  background: var(--dsw-specific-input-major, rgba(128, 128, 128, 0.08));
  color: var(--dsw-alias-label-primary, #e8e8ea);
  font: inherit;
  font-size: 13px;
}

.dtp-setInput:focus {
  border-color: var(--dsw-alias-state-business-primary, #4f8cff);
  outline: none;
}

.dtp-setInput[aria-invalid] { border-color: var(--dsw-alias-state-error-primary, #e5534b); }

.dtp-setTextarea {
  min-height: 62px;
  resize: vertical;
  font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}

.dtp-setHint {
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 11px;
  line-height: 16px;
}

.dtp-setHintBad { color: var(--dsw-alias-state-error-primary, #e5534b); }

.dtp-setFoot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dtp-setFootText {
  display: flex;
  gap: 8px;
  margin-right: auto;
}

.dtp-setSave {
  padding: 5px 14px;
  border: 0;
  border-radius: 8px;
  background: var(--dsw-alias-state-business-primary, #4f8cff);
  color: #ffffff;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.dtp-setSave:disabled { opacity: 0.45; cursor: default; }

.dtp-setDiscard {
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  border-radius: 8px;
  background: none;
  color: var(--dsw-alias-label-secondary, #a9a9b2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.dtp-setDiscard:disabled { opacity: 0.4; cursor: default; }
.dtp-setDiscard:not(:disabled):hover { color: var(--dsw-alias-label-primary, #e8e8ea); }

.dtp-setNotice {
  color: var(--dsw-alias-label-tertiary, #8b8b95);
  font-size: 12px;
}

.dtp-setNoticeBad { color: var(--dsw-alias-state-error-primary, #e5534b); }

@media (prefers-reduced-motion: reduce) {
  .dtp-fill { transition: none; }
  .dtp-setChevron { transition: none; }
  .dtp-fill[data-indeterminate],
  .dtp-spinner { animation: none; }
}
`;
		/**
		* Inject the stylesheet once per document.
		*
		* Called from the module body so the injection happens inside the bundle
		* factory's closure, which is where the loader looks for the styles it claims.
		*/
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return;
			const style = document.createElement("style");
			style.setAttribute("data-plugin-css", STYLE_ID);
			style.textContent = CSS;
			document.head.append(style);
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* Browser half of `dsh-task-progress`.
		*
		* Three surfaces over one store, so none of them knows the others exist:
		*
		* - a **floating overlay** in `shell.overlay` (the frame-wide, click-through
		*   layer) that appears only while tasks are running,
		* - a **right-sidebar tab** that lists the session's tasks, finished ones
		*   included, and
		* - a **settings card** in `settings.plugin.item`, keyed by the settings
		*   namespace this plugin registers on the Host.
		*
		* The first two read the same polled document through `progressStore`; the card
		* reads its own namespace scope through `settingsScope`, which the settings
		* transport binds on this plugin's fiber. Adding or removing a surface never
		* touches the data path.
		*
		* @module dsh-task-progress/client
		*/
		injectStyles();
		/** This overlay entry's id inside the frame-wide layer. */
		const OVERLAY_ID = "task-progress";
		/** Required services: slots, copy, and the right sidebar's tab registry. */
		const inject = [
			"slots",
			"locale",
			"sidebarRightTabs"
		];
		/** The fields the settings card edits, in card order. */
		const SETTINGS_FIELDS = [
			numberField("scanMs"),
			numberField("pollMs"),
			numberField("retainMs"),
			numberField("historyLimit"),
			numberField("maxTasks"),
			numberField("maxFileBytes"),
			listField("roots")
		];
		/**
		* Client plugin body: dictionaries, the poll loop, the overlay, the tab, and the settings card.
		* @param ctx - client root context carrying the slot, locale, tab, and settings registries.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh: { ...zh },
				en: { ...en }
			}), "task-progress: dictionaries");
			ctx.effect(() => progressStore.start(), "task-progress: state polling");
			ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: OVERLAY_ID,
				order: 60,
				label: () => t("overlay.label")
			}, (props) => (0, react.createElement)(ProgressOverlay, {
				...props,
				t
			}))), "task-progress: floating overlay");
			ctx.effect(() => ctx.sidebarRightTabs.register(taskProgressDefinition(t)), "task-progress: tab type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_KIND,
				locale: NS
			}, ProgressBody)), "task-progress: tab body");
			ctx.inject(["settingsScope"], (withSettings) => {
				const form = createSettingsForm(withSettings.settingsScope.bind({
					namespace: SETTINGS_NAMESPACE,
					decode: decodeSettingsSection
				}), SETTINGS_FIELDS);
				withSettings.effect(() => withSettings.slots.inject("settings.plugin.item", () => withSettings.slots.register({
					name: "settings.plugin.item",
					key: SETTINGS_NAMESPACE,
					locale: NS,
					inject: () => form
				}, SettingsCard)), "task-progress: settings card");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map