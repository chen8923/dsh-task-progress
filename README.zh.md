# dsh-task-progress

**DeepSeek Harness 长任务实时进度。** 脚本把结构化进度写进文件，Web 界面用**悬浮窗**和**右侧栏 tab**展示——不用问 agent，也不用等命令跑完。

[English](README.md)

```
┌──────────────────────────────────────┐
│ ⟳ 2 个任务进行中                      │   ← 只有真的有任务在跑时才出现的悬浮胶囊
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│ 长任务进度          2 进行中 · 1 已结束│
│ ██████████░░░░░░░░░░  52%  build     │   ← 点胶囊展开，或打开右栏
│ linking objects                      │     「任务进度」tab
│ 已用 12m04s · 5/9 files · 剩余约 11m  │
└──────────────────────────────────────┘
```

## 为什么需要它

DSH 的 `pwsh`/`bash` 工具不是流式的：前台命令的输出要等命令结束才出现，后台任务的输出锁在模型侧的 `job_output` 游标后面。会话头部的任务列表只有状态，一行输出都没有。所以一个跑十分钟的构建，对盯着界面的人来说是个黑盒。

本插件给长任务一条**专用的第二条通道**：任务自己往里写，人直接读。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile web add dsh-task-progress

# 从 git 仓库
dsh plugin --profile web add github:<owner>/dsh-task-progress

# 从本地源码构建
./tools/rebuild.ps1 -Profile web -Checkout <DSH checkout 路径>
```

DSH 在启动时挂载 profile bundle，所以之后**需要重启 DSH**。本插件依赖 Web profile（`webServer`、`connection`、`shellEnv` 与右侧栏）；缺少这些的组合里它会保持未加载，不产生任何影响。

## 用法

在 DSH 的 shell 调用里，插件已经把目录交到脚本手上：

```powershell
# PowerShell —— 每个事件追加一行
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
# Python（任何语言都行——它就是追加一个文件）
import json, os
path = os.path.join(os.environ["DSH_PROGRESS_DIR"], "build.jsonl")
with open(path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"v": 1, "task": "build", "pct": 42, "msg": "linking"}) + "\n")
```

也可以直接用随包提供的 CLI 处理转义：

```bash
node "$DSH_PROGRESS_CLI" emit --task build --pct 42 --msg "linking"
node "$DSH_PROGRESS_CLI" done --task build --msg "shipped"
node "$DSH_PROGRESS_CLI" list          # 打印当前目录里报告了什么
```

零配置试一把：

```powershell
pwsh ./examples/simulate.ps1 -Task demo -Steps 30 -DelayMs 500
```

然后打开右栏的 **任务进度** tab（或等悬浮胶囊出现后点开）。

### 让 agent 自动这么做

把这段加进工作区的 `AGENTS.md`，长命令就会自己报告进度：

```markdown
## 长任务进度
预计超过约 30 秒的命令，要在脚本内部把进度写进 `$DSH_PROGRESS_DIR/<task>.jsonl`
（每个事件一行 JSON，格式见 dsh-task-progress 的协议），或使用
`node "$env:DSH_PROGRESS_CLI" emit --task <id> --pct N --msg "..."`。
不要把进度文件读回来——它是给人看的。
```

## 设计

三层，各自可替换——目标是生产者和界面互不知情，也都不依赖 DSH 内部实现。

| 层 | 形态 | 为什么这样 |
| --- | --- | --- |
| **协议**（`docs/PROTOCOL.md`） | 追加式 JSONL，一任务一文件 | 任何语言都能写；没有 IPC、端口、鉴权，重启不丢。插件不装也照样能用——文件就是文件。 |
| **宿主半** | `ctx.shellEnv` 贡献者 + 目录轮询 + 一个 HTTP 路由 | 只用公开接缝（`webServer`、`connection`、`shellEnv`），**完全不碰**任务注册表。 |
| **浏览器半** | 一个轮询 store + 两个界面（`shell.overlay` 与右栏 tab） | 两个界面读同一份快照，增删界面永远不动数据通路。 |

**为什么不去读任务输出。** `ctx.jobs.read()` 消费的是属于模型 `job_output` 的**单消费者游标**；浏览器路径读一次，就会悄悄拿走模型再也看不到的字节（DSH 把这条钉成了有测试兜底的不变量）。所以这里的进度是**脚本主动报告**的东西——这正是它可以和任何东西并存的原因。

**为什么用轮询而不是推送。** 数据就是本地几 KB 的 JSON；轮询回路是唯一不会失步的设计：所有读者看到同一份 last-wins 文档，漏一拍只损失一个间隔，也没有重连逻辑可写错。间隔由宿主半的配置统一下发。

**零依赖。** 宿主半只 import Node 内置模块；浏览器半把自己的一切都打包进来，只把 `react` 当平台外部依赖。没有 CSS 工具链（样式是模块自己注入的字符串），也没有需要跟着升级的运行时依赖。

### 刻意不做的事

- **不做历史。** 进度是实时状态，不是日志；结束的任务会老化消失。
- **不做取消按钮。** 停任务是模型的 `job_kill`（人类主动中断涉及一个本插件无权决定的投递语义问题）。
- **不做远程生产者。** 一切都在会话本来就能写的本地 workspace 文件里。
- **不做会话查询。** 目录来自"被交到手上的那些 shell 调用"加配置的根目录——所以它不会复活会话，也不会去读浏览器给的路径。

## 开发

```bash
npm test              # 38 个测试，单进程（受限沙箱里也能跑）
npm run test:runner   # 同一套测试走 node --test
npm run build         # 需要 tsdown
```

源码结构：

```
src/protocol.ts        共享协议（纯逻辑，打进两个半区）
src/host/              配置、store、环境变量贡献者、HTTP 路由、入口
src/client/            轮询 store、格式化、React 组件、slot、样式
bin/dsh-progress.mjs   零依赖的生产者 CLI
docs/PROTOCOL.md       文件协议与全部配置项
test/                  协议、store、格式化、宿主接线四套测试
tools/                 测试入口与构建/打包/安装脚本
```

## 许可证

MIT
