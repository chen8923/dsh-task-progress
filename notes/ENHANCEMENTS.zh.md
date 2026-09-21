# 能力提升方案（含开发流程）

> 文中的 `<repo>`、`<DSH checkout>`、`<工作区>`、`$DSH_HOME` 是占位符：本文件随仓库公开，
> 因此不写入本机绝对路径。

- 撰写：2026-09-21
- 针对版本：**0.1.0**（源码树 HEAD `0c2071f`，2026-09-20 19:34）
- 触发事件：一个跑了约 15 分钟的后台任务（K 线补齐）在界面上**完全没有进度**
- **处置结论：插件没有坏。** 它是"纯被动读取"——任务不主动上报，面板就是空的（设计如此）。
  本次事件真正暴露的是**上报门槛太高、以及"没上报"这件事不够显眼**。

---

## 0. 三十秒速览

| # | 短板（今天实测到的） | 提升方向 | 成本 | 优先级 |
|---|---|---|---|---|
| 1 | 智能体忘了上报 → 完全不可见 | **把约定写进工作区 `AGENTS.md`**（零代码） | 极低 | **P0** |
| 2 | 上报要手写 JSON 或 spawn 一个 node 进程 | **生产端 SDK**（单文件 Python，含上下文管理器） | 低 | **P1** |
| 3 | 没上报时悬浮胶囊直接 `return null`，看起来像坏了 | **胶囊兜底**："N 个任务在跑但未上报" | 低 | **P2** |
| 4 | 任务卡住时界面仍显示旧的 pct，分不清"慢"还是"死" | **心跳超时标记**（`at` 超过阈值 → 灰显"疑似无响应"） | 中 | **P3** |
| 5 | 脚本异常退出后，界面永远停在最后一条 `running` | **SDK 自动 `failed`**（随 P1 一起解决） | 低 | **P1** |
| 6 | 需上报才能看到任何东西 | 包装器 `dsh-progress run -- <cmd>` | 中高 | P4 |

> 不建议做的：跨会话汇总视图。`docs/PROTOCOL.md:83-88` 已论证这是**安全边界**
> （"一个回答'本进程所知一切'的端点，会把每个会话的任务名和消息交给任何持有登录态的人"）。
> 同理，**不要去读任务输出**——`ctx.jobs.read()` 是单消费者游标（见 §1.2）。

---

## 1. 现状

### 1.1 已有能力（0.1.0 其实相当完整）

| 层 | 内容 | 位置 |
|---|---|---|
| **协议** | 追加式 JSONL，一任务一文件；`last-wins`；字段 `v/task/state/pct/msg/done/total/unit/at` | `docs/PROTOCOL.md`、`src/protocol.ts` |
| **宿主半** | 注入 `DSH_PROGRESS_DIR`/`DSH_PROGRESS_CLI`；目录轮询 store；只读路由 `GET /plugins/task-progress/state?session=<id>`；注入一段系统提示词 | `src/host/{shell-env,store,routes,system-prompt,settings,config}.ts` |
| **浏览器半** | 悬浮胶囊（`shell.overlay`）+ 右栏「任务进度」tab + 设置卡片；轮询 store | `src/client/*` |
| **CLI** | `emit / done / fail / cancel / path / list / clear`，零依赖 | `bin/dsh-progress.mjs` |
| **测试** | 13 个测试文件（协议/store/格式化/宿主接线/设置/CLI/打包/发布） | `test/*.test.ts` |

已实现的细节，改造前值得知道：

- 延迟约 **1–3 秒**（宿主 `scanMs=1000` + 浏览器 `pollMs=2000`）。
- 完成任务保留 **30 分钟**后老化。
- 只读文件**尾部 256 KiB**；`size`/`mtime` 未变则不重读。
- 容忍空行、横幅、半行、首行 BOM。
- **`done` 之后再追加 `running` 会开启新一轮**（时钟与百分比清零，历史消息保留）。
- 设置页 7 个开关项：`scanMs / pollMs / retainMs / historyLimit / maxTasks / maxFileBytes / roots`，**保存即热生效**。

### 1.2 ⚠️ 作者刻意不做的（改之前先读这段）

`README.zh.md:133-138` 明确列了四条边界，其中两条**技术上是硬约束**：

1. **不做历史** —— "进度是实时状态，不是日志"。
2. **不做取消按钮** —— 停任务是模型的 `job_kill`。
3. **不做远程生产者** —— 一切都在本地 workspace 文件里。
4. **不做会话查询** —— 目录只来自"被交到手上的 shell 调用"+ 配置的 `roots`。

还有一条**绝不能碰的不变量**（`README.zh.md:127`）：

> `ctx.jobs.read()` 消费的是属于模型 `job_output` 的**单消费者游标**；
> 浏览器路径读一次，就会悄悄拿走模型再也看不到的字节。**DSH 把这条钉成了有测试兜底的不变量。**

所以"自动采集后台任务进度"这条路是**封死的**——这不是偷懒，是设计。

---

## 2. 今天暴露的短板（全部有实测证据）

### 2.1 会话从 07:42 到 08:29 的进度目录**完全是空的**

```
07:42:50  会话目录被创建（该会话第一次 shell 调用）
08:29:01  才出现第一行 —— 是我手动补的一次 emit
           中间 46 分钟：0 字节
```

宿主半、路由、浏览器半、CLI、提示词接缝**全部正常**（逐条实测）：
路由返回 `200`、GUI 正在轮询同一路由、`node "$DSH_PROGRESS_CLI" list` 有输出、
**而且那段"要求上报"的系统提示词原文就在模型自己的提示里**。

→ **模型被告知了，但没照做。** 这是 §3 P0/P1 要解决的。

### 2.2 悬浮胶囊"看起来像坏了"

- 无上报任务时，胶囊直接 `return null`（`src/client/ProgressOverlay.tsx`，运行时对应 `lib/client.js:632-633`）。
- 唯一的兜底是**右栏 tab 的空状态文案**：「{count} 个后台任务正在运行，但它们还没有报告进度。」
  （`src/client/locales.ts`，运行时 `lib/client.js:534-546`、`:1061`）

**问题**：用户默认看的是胶囊（它在别的时候一直在），胶囊消失 = "没有任务"。
**真相是"有任务，只是没人上报"** —— 两者在界面上无法区分。

### 2.3 卡死无法识别

今天那个任务从 `08:24` 到 `08:40` 缓存只数一动不动（腾讯接口累积限流）。
界面显示的是 `43% running` —— **和"正常但慢"长得一模一样**。

协议里有 `at`（生产者时钟，缺省用文件 mtime），宿主也读得到，但**目前没有任何超时判据**。

### 2.4 异常退出无终态

脚本被 `job_kill`、OOM、异常崩掉时，文件里最后一条仍是 `running`。
协议本身支持 `failed`/`cancelled`，但**没有任何机制替脚本补这一条** —— 全靠脚本自觉 `try/except`。
今天那个 K 线任务就属于此列（被 kill 时不会写终态）。

---

## 3. 提升方向

### P0 · 零代码：把约定写进工作区 `AGENTS.md`

**为什么**：插件已经注入系统提示（`src/host/system-prompt.ts`），但模型仍然漏了。
工作区级指令在指令链里更靠前、更具体，能显著降低漏报率。
`README.zh.md:85-93` 已经给了现成模板。

**做法**：在**跑长任务的工作区**（例如 `<工作区>\AGENTS.md`）加：

```markdown
## 长任务进度
预计超过约 30 秒的命令，必须在脚本内部把进度写进 `$DSH_PROGRESS_DIR/<task>.jsonl`
（每个事件一行 JSON，格式见 dsh-task-progress 的协议），或使用
`node "$env:DSH_PROGRESS_CLI" emit --task <id> --pct N --msg "..."`。
脚本收尾时必须写终态（`done`/`failed`），异常也要写。
不要把进度文件读回来——它是给人看的。
```

**成本**：改动一个 markdown 文件。
**风险**：无。**这是今天就能拿到收益的一项。**

### P1 · 生产端 SDK：让上报变成一行

**痛点**：现在两条路都不够省——手写 JSON 要自己记 schema；调 CLI 每个事件 spawn 一个 node 进程（约 50–100ms），且 Python 脚本里还要处理路径与转义。

**方案**：提供一个**单文件、零依赖**的上报器（Python 先行，PowerShell 可选）。
关键不只是"少写几个字符"，而是**把终态和异常兜住**：

```python
# dsh_progress.py —— 放在脚本旁边即可，零依赖
import json, os, time

class Progress:
    """DSH 长任务进度上报。用法：
        with Progress("kline-backfill", total=430, unit="只") as p:
            for i, code in enumerate(codes, 1):
                ...
                p.update(done=i, msg=f"已补 {i}/{len(codes)}")
        # 正常退出 → 自动 done；抛异常 → 自动 failed（这就是现在缺的能力）
    """
    def __init__(self, task, total=None, unit=None, directory=None):
        self.task, self.total, self.unit = task, total, unit
        self.dir = directory or os.environ.get("DSH_PROGRESS_DIR")
        self.path = os.path.join(self.dir, task + ".jsonl") if self.dir else None
        if self.path:
            os.makedirs(self.dir, exist_ok=True)

    def _write(self, **fields):
        if not self.path:
            return                      # 不在 DSH 环境里 → 静默降级，绝不影响主流程
        ev = {"v": 1, "task": self.task, "at": int(time.time() * 1000)}
        for k in ("state", "pct", "msg", "done", "total", "unit"):
            v = fields.get(k)
            if v is not None:
                ev[k] = v
        if self.total is not None and ev.get("total") is None:
            ev["total"] = self.total
        if self.unit is not None and ev.get("unit") is None:
            ev["unit"] = self.unit
        try:
            with open(self.path, "a", encoding="utf-8", newline="\n") as fh:
                fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
        except Exception:
            pass                        # 上报失败绝不能中断任务

    def update(self, msg=None, pct=None, done=None, state="running"):
        self._write(state=state, msg=msg, pct=pct, done=done)

    def done(self, msg="完成"):
        self._write(state="done", msg=msg)

    def fail(self, msg="失败"):
        self._write(state="failed", msg=msg)

    def __enter__(self):
        self.update(msg="已启动")
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.done()
        else:
            self.fail(f"异常：{exc_type.__name__}: {exc}")
        return False                    # 不吞异常
```

**要点**：
- **每次 `open(..., "a")` 即落盘**（不要在循环里长期持有句柄）。
- 给 `done`/`total` 即可，`pct` 由读取端自动推导；显式 `pct` 会覆盖推导值。
- **别太频繁**：每 10–30 秒或每 N 条一次就够（界面 1–3 秒才刷新一次，刷太密只是浪费 I/O）。
- `msg` >200 字符会被截断，`unit` >24 字符会被截断。

**成本**：低（约 60 行，零依赖）。
**风险**：无——上报失败全部静默降级。

### P2 · 悬浮胶囊兜底：让"没上报"可见

**痛点**：见 §2.2。**胶囊消失** 与 **有任务但未上报** 在界面上无法区分，
用户的第一反应是"插件坏了"（今天就发生了）。

**方案**：悬浮胶囊在"没有已上报任务"时**不再 `return null`**，而是检查浏览器侧已有的任务镜像
（`state.jobsBySession` —— 客户端**本来就在读它，只用来数个数**，不消费任何输出，合法）：

| 条件 | 胶囊显示 |
|---|---|
| 有已上报任务 | 现状不变（`⟳ 2 个任务进行中`） |
| 无已上报任务，但本会话有后台 job 在跑 | **`⚠ N 个任务未上报进度`**（弱化样式，点击展开右栏 tab） |
| 都没有 | 仍然 `return null`（保持"没任务就不占地方"） |

**改动点**：
- `src/client/ProgressOverlay.tsx` —— 渲染条件与文案。
- `src/client/locales.ts` —— 新增词条（中英）。
- 可复用右栏 tab 空状态已有的同一份 job 计数逻辑，抽成共享 selector。

**成本**：低（纯客户端渲染分支，不碰数据通路）。
**收益**：把"静默失败"变成"可见的状态"——**这正是今天最需要的那一改**。
**注意**：不要为此去读 job 输出（§1.2 的不变量）。

### P3 · 心跳超时：区分"慢"和"死"

**痛点**：见 §2.3。

**方案**：契约不变，**只在读取端加判据**。
宿主 `fold()` 已经算得出 `at`（缺省用文件 mtime），因此在任务记录上附一个派生字段即可：

- 新增配置项 `staleMs`（默认建议 `120000` = 2 分钟，`0` 表示关闭）。
- `state === "running"` 且 `now - at > staleMs` → 记录 `stale: true`。
- 客户端：胶囊与列表把该任务**灰显**并显示「已 N 分钟无更新，可能已卡住」。
- **不改变任何协议字段**，纯读取端派生 → 生产端零感知，旧文件也能受益。

**改动点**：`src/host/{config,store}.ts`（派生字段 + 配置项）、
`src/client/{ProgressBody,TaskList}.tsx` 与 `format.ts`（渲染与时长格式化）、
`src/host/settings.ts` + `src/client/settings-form.ts`（新开关）。

**成本**：中（跨宿主半与浏览器半，要补测试）。
**收益**：高——省掉"这个任务是卡了还是就这样"的反复确认。

### P4 · 包装器：`dsh-progress run -- <cmd>`

**目标**：连"改脚本"都不需要——`node "$DSH_PROGRESS_CLI" run --task build -- python heavy.py`。

**能力**：
- 自动先写一条 `pct=0, msg="已启动"`，退出时按退出码写 `done`/`failed`。
- 可选 `--total-from <文件>` / `--grep '^Step (\d+)/(\d+)'` 之类，从子进程 stdout **自己读**来推 pct。
- 透传 stdout/stderr 与退出码（**这是关键：包装器读的是自己子进程的管道，不是 `ctx.jobs.read()`，不违反不变量**）。

**成本**：中高（子进程管理、信号/中断处理、Windows 控制台细节）。
**风险**：如果做得含糊，会让人误以为"什么任务都能自动有进度"——**文档必须写清它只对用它的命令生效**。

### P5 · ETA 与展示（锦上添花）

现状已显示"剩余约 11m"（线性外推）。
可改为**滑动窗口速率**（近 N 次事件的速度），对"先快后慢"的任务（今天的限流场景）更诚实；
速率不可信时**宁可不显示**，也不要给一个错的数。

改动点：`src/protocol.ts`（或 store 的派生层）+ `src/client/format.ts`。成本低。

---

## 4. 开发环境（已经就绪，无需搭建）

| 项 | 值 |
|---|---|
| **源码树** | `<repo>` |
| 远端 | `https://github.com/chen8923/dsh-task-progress.git` |
| HEAD | `0c2071f`（2026-09-20 19:34，工作区干净） |
| 构建产物 | `lib/index.js`（宿主半）、`lib/client.js`（浏览器半）—— **由 `src/` 编译而来，不要手改** |
| 打包产物 | `dsh-task-progress-0.1.0.tgz` |
| **工程 profile** | `$DSH_HOME/profiles/web`（正式） |
| **开发 profile** | `$DSH_HOME/profiles/progress-dev`（`patchReload: "live"`，**专用脚手架**） |
| DSH checkout | **`<DSH checkout>`**（`@deepseek-ai/dsh-root` 0.1.5-rc.2） |

**⚠️ 两个前置条件**（已实测）：

- `tsdown` **不在 PATH** → 必须 `-Checkout` 指到 checkout（那里有 `node_modules/.bin/tsdown.cmd`）。
- `dsh` **不在 PATH** → `rebuild.ps1` 会自动改用 `node <checkout>\apps\cli\lib\bin.js`。

所以**标准命令**是：

```powershell
cd <repo>
pwsh -File tools\rebuild.ps1 -Profile progress-dev -Checkout <DSH checkout>
```

**为什么必须 rebuild 而不能拷文件**：profile 引用的是 **tarball**（`file:.../dsh-task-progress-0.1.0.tgz`），
所以每次源码改动都要走 **bundle → pack → re-add**（`tools/rebuild.ps1:5-8` 写明了这一点）。

---

## 5. 标准开发循环

```powershell
cd <repo>

# 1) 改 src/**（改客户端部分时，优先在 progress-dev 里验）

# 2) 跑测试：38 个用例，单进程，受限沙箱里也能跑
npm test

# 3) 构建 + 打包 + 装进开发 profile
pwsh -File tools\rebuild.ps1 -Profile progress-dev -Checkout <DSH checkout>
#    只想要 tgz、不装：  加 -PackOnly

# 4) 重启 DSH（宿主半只在启动时挂载 profile bundle）
#    progress-dev 的 patchReload: "live" 只对 profile patch 生效；
#    插件 bundle 本身变化仍需重启。

# 5) 验完再装进正式 profile
pwsh -File tools\rebuild.ps1 -Profile web -Checkout <DSH checkout>
```

**客户端部分的 HMR**：DSH 的 client-plugin HMR 接收端是活跃的，但**只有在同一个 checkout 里
同时跑着 `pnpm run dev:web`（重建客户端 bundle）时**，客户端改动才会免刷新生效。
否则改客户端也要走上面的 rebuild + 重启。

---

## 6. 验证方法（三层，逐层确认）

**① 文件层** —— 确认写得对：

```powershell
node "$env:DSH_PROGRESS_CLI" list            # 当前会话目录里报告了什么
node "$env:DSH_PROGRESS_CLI" path --task X   # 这个任务会写到哪个文件
```

**② 路由层** —— 确认宿主半读到了（**必须带正确 session id**）：

```powershell
curl.exe -s "http://127.0.0.1:18080/plugins/task-progress/state?session=$env:DSH_SESSION_ID"
# 期望：{"v":1,...,"tasks":[{...}]}；session 不带或不对 → tasks:[]（这是设计，不是 bug）
```

**③ 界面层** —— 悬浮胶囊 / 右栏「任务进度」tab。
注意 **GUI 一次只显示当前视图那个会话**：看错会话 = 什么都没有。

**自测脚本**：仓库自带 `examples/simulate.ps1`：

```powershell
pwsh ./examples/simulate.ps1 -Task demo -Steps 30 -DelayMs 500
```

---

## 7. 风险与注意事项

| 风险 | 说明与对策 |
|---|---|
| 改错文件 | **只改 `src/`**。`lib/*.js` 是构建产物，下次 `tsdown` 会覆盖。 |
| 忘了 rebuild 就测 | profile 指向 tgz → **不 rebuild 就永远是旧代码**，这是最容易浪费半小时的坑。 |
| 拿正式 profile 当试验田 | 先在 `progress-dev` 验；`web` 是用户日常在用的。 |
| 重启 DSH 的代价 | 重启会中断当前会话视图；改宿主半时**攒够改动一次重启**，别来回重启。 |
| 触碰安全边界 | 不要加"返回所有会话任务"的端点（`PROTOCOL.md:83-88`）；不要读 job 输出（§1.2）。 |
| 版本号漂移 | `test/release.test.ts` 会校验 CHANGELOG / package.json / 两个 README 的版本一致 —— 发布前要一起改。 |
| 中文路径 | `<工作区>` 含中文，实测无问题；但写文件务必 **UTF-8 无 BOM**，别用 PowerShell 5.1 的 `>>`（会写 UTF-16）。 |

---

## 8. 贡献回上游

```powershell
cd <repo>
git checkout -b feat/stale-heartbeat        # 一个方向一个分支
npm test                                    # 必须绿
# 补测试：test/host.test.ts、test/client-store.test.ts、test/format.test.ts 是最相关的三个
git commit -m "feat(host,client): flag tasks whose producer stopped reporting"
git push -u origin feat/stale-heartbeat
# 然后开 PR；CI 在 .github/workflows/ci.yml
```

**如果只打算给自己用**：`-Profile web` 装完即可，不必严格遵守上游的提交规范；
但**仍然建议走分支 + 测试**，因为宿主半出错会让整个 Web UI 的进度面板失效。

---

## 9. 建议的落地顺序

1. **今天**：P0（写 `AGENTS.md`）—— 零成本，直接解决"忘了上报"。
2. **接下来**：P1（Python SDK）—— 把上报从"要记得"变成"顺手"。
3. **顺手做**：P2（胶囊兜底）—— 一处渲染分支，把静默失败变可见。
4. **有余力**：P3（心跳超时）→ P5（ETA）→ P4（包装器）。

> 判断依据：**P2 的收益/成本比最高**（今天的困惑 100% 来自"看不见但确实在跑"），
> 而 P0+P1 解决的是**根因**（上报这件事本身太容易被漏掉）。
