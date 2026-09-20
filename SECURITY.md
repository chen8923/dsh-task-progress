# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

**<https://github.com/chen8923/dsh-task-progress/security/advisories/new>**
(repository **Security** tab → **Report a vulnerability**)

Please do not open a public issue for a suspected vulnerability first.

Include what you can: the plugin version, your DSH build, what you expected, what
actually happened, and the smallest reproduction you have. Expect an
acknowledgement within a few days. A valid report is fixed together with a
`CHANGELOG.md` entry, and you are credited unless you would rather not be.

## What this plugin touches

This is the whole footprint. A discrepancy between this table and the code is
itself a security report.

| Surface | Exactly what happens |
| --- | --- |
| **Files read** | `<root>/.dsh-progress/<session-id>/<task>.jsonl`, tail-only (default 256 KiB per file). `root` is a workspace directory the plugin was handed by a shell call, plus any absolute roots you configured in the settings card. Nothing else is opened. |
| **Files created** | `<workspace>/.dsh-progress/<session-id>/` (created on a session's first shell call). Editing the settings card writes that namespace's user layer through DSH's own settings service. No other path is written. |
| **Shell environment** | Every shell call gets `DSH_PROGRESS_DIR` and `DSH_PROGRESS_CLI` added. |
| **Network** | None. No outbound request, no telemetry, no update check, no child process. The browser half fetches one path on the same origin it was served from. |
| **HTTP surface** | One route: `GET`/`HEAD /plugins/task-progress/state`. It calls `ctx.connection.requestRejection` **before** reading anything, answers for exactly one `?session=` at a time, and puts no filesystem path on the wire. Other methods get `405`. |
| **Model context** | One static system-prompt section, placed beside DSH's background-job guidance. Nothing else is injected, and nothing it does at runtime changes the prompt. |
| **Tools** | None. The plugin adds no tool, so the tool catalogue — and the cached prefix built from it — is untouched. |
| **UI** | Three additive registrations: one `shell.overlay` entry, one right-sidebar tab, one settings card. Each adds its own key to a shared list slot; none replaces or claims another plugin's path, and each is skipped when the seam is absent. |
| **Memory** | Bounded by configuration: at most `maxTasks` tasks per document, `messagesPerTask` messages per task, `fileTailBytes` read per file, and a 64-directory LRU of known progress directories. |

## In scope

- Answering for a session other than the one named in the request, or returning
  any filesystem path.
- Answering an untrusted caller, or answering before the trust check runs.
- Reading a file outside the roots described above, including anything derived
  from a path a browser supplied.
- A crash, or memory/CPU growth driven by attacker-controlled progress files
  (a huge line, a torn byte, a non-UTF-8 tail, a symlinked directory).
- Anything in the shell-environment or settings contribution that escapes the
  namespace it declares.

## Out of scope

- **The platform's plugin privilege model.** A DSH plugin runs in the DSH process
  with that process's privileges, and DSH's file permission modes gate the *tool*
  calls the model asks for — not plugin code. That is DSH's design, documented by
  DSH; this plugin cannot narrow it for you, and a report that plugins are
  powerful in general belongs upstream.
- **A different plugin you installed.** Report it there.

## Already covered by the suite

`test/host.test.ts` pins the fence so it cannot regress silently:

- *the state route refuses an untrusted caller before reading anything*
- *the state route answers for one session and never for everything*
- *the state route answers only GET and HEAD*

`test/protocol.test.ts` pins the parser against hostile input: junk lines are
dropped rather than thrown on, a torn tail and a byte-order mark are tolerated,
percentages are clamped, and a message is bounded to one line and a fixed length.

The 0.1.0 release was audited before publishing: the endpoint was scoped to one
session, in-memory state was bounded, and the repository history was rewritten so
no local absolute path ships in a blob.

---

## 中文摘要

**漏洞上报**：走 GitHub 的私密上报 →
<https://github.com/chen8923/dsh-task-progress/security/advisories/new>
（仓库 **Security** 页 → **Report a vulnerability**），不要先开公开 issue。

**本插件触碰的全部范围**（与代码不符本身就是安全问题）：

- **只读**：被 shell 调用交到手上的 workspace 目录（加你配置的额外根目录）下的
  `.dsh-progress/<会话 id>/<任务>.jsonl`，且只读文件尾部（默认每个文件 256 KiB）。
- **只写**：首次 shell 调用时创建 `<workspace>/.dsh-progress/<会话 id>/`；改设置页时
  经 DSH 自己的设置服务写入该命名空间的用户层。
- **联网**：没有。不发任何外部请求，无遥测、无更新检查、不启动子进程。
- **HTTP**：只有一个路由 `GET`/`HEAD /plugins/task-progress/state`，**先**过
  `ctx.connection.requestRejection` 再读任何东西，一次只回答一个 `?session=`，
  响应里不含任何文件系统路径，其它方法返回 405。
- **模型上下文**：只加一段**静态**系统提示词（放在后台任务那段旁边）。
- **工具**：不加任何工具，工具目录与其缓存前缀都不受影响。
- **界面**：往共享列表槽里增加自己的键（悬浮层、右栏 tab、设置卡片各一），不抢别人的路径。

**不在范围内**：DSH 插件本身的权限模型（插件运行在 DSH 进程权限下，三档文件权限管的是
模型发起的工具调用，不是插件代码——这是 DSH 的设计，属于上游问题）；以及你装的**别的**插件的问题。
