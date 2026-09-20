# dsh-task-progress

**DeepSeek Harness 长任务实时进度。** 脚本把结构化进度写进文件，Web 界面用**悬浮窗**和**右侧栏 tab**展示——不用问 agent，也不用等命令跑完。

**版本 0.1.0** · MIT · [English](README.md) · [更新日志](CHANGELOG.md)

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

### 开箱即用

装完插件，**智能体自己就知道**这个约定：宿主半会往系统提示词里加一小段（就放在后台任务那一段旁边），所以模型对长命令会自行安排进度上报。不需要任何配置，也不用改 `AGENTS.md`——"必须先改自己的指令才能生效"的东西，不叫装得上的功能。

如果你想要更强的约束，或者你的组合里没有这条提示词接缝，同样的说明也可以写在工作区 `AGENTS.md`：

```markdown
## 长任务进度
预计超过约 30 秒的命令，要在脚本内部把进度写进 `$DSH_PROGRESS_DIR/<task>.jsonl`
（每个事件一行 JSON，格式见 dsh-task-progress 的协议），或使用
`node "$env:DSH_PROGRESS_CLI" emit --task <id> --pct N --msg "..."`。
不要把进度文件读回来——它是给人看的。
```

### 面板空白时

面板只显示脚本报告的内容，从不读取运行中任务的输出。所以"没上报的脚本跑的后台任务"在这里本就不可见，已经在跑的任务也无法追溯——但右栏 tab 会**说出来**而不是显得坏掉：有任务在跑却没有任何上报时，它的空状态会写明有几个。

## 设置页

插件注册了一个 settings 命名空间，所以它的开关就在所有插件共用的位置：**设置 → 插件 → 插件配置 → 任务进度设置**。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| 扫描间隔（毫秒） | `1000` | 宿主重新读取进度文件的频率。 |
| 上报间隔（毫秒） | `2000` | 浏览器查询进度的频率。 |
| 完成后保留（毫秒） | `1800000` | 任务结束后仍在列表里停留的时间。 |
| 每任务消息上限 | `30` | 每个任务保留的最近消息条数。 |
| 任务数上限 | `200` | 一次状态文档最多返回多少任务。 |
| 单文件读取上限（字节） | `262144` | 每个进度文件从尾部读取的字节数。 |
| 额外根目录 | – | 这些绝对路径下的 `.dsh-progress` 也会被扫描。 |

保存会把用户层写进 `$DSH_HOME/settings.yaml`；按「重置」（或清空某个字段后保存）会移除覆盖，值依次回落到插件行的 `config`、再到 schema 默认值。改动**实时生效**：新的扫描间隔会在下一拍重新定时，状态文档里的 `pollMs` 也会跟着变成浏览器该用的值。

`dirName` **刻意不在面板里**——它已经写进了每一个路径，所以只作为插件行的组合层设置。

## 设计

三层，各自可替换——目标是生产者和界面互不知情，也都不依赖 DSH 内部实现。

| 层 | 形态 | 为什么这样 |
| --- | --- | --- |
| **协议**（`docs/PROTOCOL.md`） | 追加式 JSONL，一任务一文件 | 任何语言都能写；没有 IPC、端口、鉴权，重启不丢。插件不装也照样能用——文件就是文件。 |
| **宿主半** | `ctx.shellEnv` 贡献者 + 目录轮询 + 一个 HTTP 路由 + 一段系统提示词 | 只用公开接缝（`webServer`、`connection`、`shellEnv`、`settings`、`systemPrompt`），**完全不碰**任务注册表。 |
| **浏览器半** | 一个轮询 store、两个面板（`shell.overlay` 与右栏 tab），加一张设置卡片 | 两个面板读同一份快照，卡片读自己的命名空间 scope——增删任何一块都不动数据通路。 |

**为什么不去读任务输出。** `ctx.jobs.read()` 消费的是属于模型 `job_output` 的**单消费者游标**；浏览器路径读一次，就会悄悄拿走模型再也看不到的字节（DSH 把这条钉成了有测试兜底的不变量）。所以这里的进度是**脚本主动报告**的东西——这正是它可以和任何东西并存的原因。

**为什么用轮询而不是推送。** 数据就是本地几 KB 的 JSON；轮询回路是唯一不会失步的设计：所有读者看到同一份 last-wins 文档，漏一拍只损失一个间隔，也没有重连逻辑可写错。间隔由宿主半的配置统一下发。

**零依赖。** 宿主半只 import Node 内置模块；浏览器半把自己的一切都打包进来，只把 `react` 当平台外部依赖。这条原则一直延伸到设置 schema：`ctx.settings.register` 要的是 schemastery schema，而本插件自己提供了一个最小兼容节点——可调用（用于解析）、`toJSON()` 输出 schemastery 的**引用图**格式、并可被设置脱敏器结构遍历——而不是去依赖一个 profile 里根本解析不到的包。它自己的浏览器卡片还传了 `decode`，因此完全不需要反水合任何 schema 信封。

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
src/host/              设置命名空间、store、环境变量贡献者、HTTP 路由、入口
src/client/            轮询 store、格式化、设置表单、React 组件、slot、样式
bin/dsh-progress.mjs   零依赖的生产者 CLI
docs/PROTOCOL.md       文件协议与全部配置项
test/                  协议、store、格式化、宿主接线、设置五套测试
tools/                 测试入口与构建/打包/安装脚本
```

## 许可证

MIT
