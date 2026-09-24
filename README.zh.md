# dsh-task-progress

**DeepSeek Harness 长任务实时进度。** 脚本把结构化进度写进文件，Web 界面用**悬浮窗**和**右侧栏 tab**展示——不用问 agent，也不用等命令跑完。

**版本 0.2.0** · MIT · [English](README.md) · [更新日志](CHANGELOG.md)

![一个真实会话里的悬浮面板：任务名、进度条、消息、已用时间、单位计数与预计剩余](docs/overlay.png)

*一张真实会话的截图，不是示意图：悬浮面板里有一个正在上报的任务。*
*点它展开，或打开右侧栏的「任务进度」tab。*

## 为什么需要它

DSH 的 `pwsh`/`bash` 工具不是流式的：前台命令的输出要等命令结束才出现，后台任务的输出锁在模型侧的 `job_output` 游标后面。会话头部的任务列表只有状态，一行输出都没有。所以一个跑十分钟的构建，对盯着界面的人来说是个黑盒。

本插件给长任务一条**专用的第二条通道**：任务自己往里写，人直接读。

## 安装

```bash
# 从 npm —— 一条命令，装好并自动注册进 profile
dsh plugin --profile web add dsh-task-progress

# 从 git 仓库
dsh plugin --profile web add github:chen8923/dsh-task-progress

# 从本地源码构建
./tools/rebuild.ps1 -Profile web -Checkout <DSH checkout 路径>
```

DSH 在启动时挂载 profile bundle，所以之后**需要重启 DSH**。本插件依赖 Web profile（`webServer`、`connection`、`shellEnv` 与右侧栏）；缺少这些的组合里它会保持未加载，不产生任何影响。

仓库名和 npm 包名**完全一致**，所以 `dsh plugin add dsh-task-progress` 不会装成别人的包——这里不存在"发现用仓库名、安装用包名"的错位。

### 安装过程实际执行了什么

**什么都不执行。** 本包**没有声明 `install`、`postinstall` 或 `prepare` 脚本**
（`npm run build` 是开发命令，`prepublishOnly` 只在维护者发布时触发），所以安装它不会在你的机器上运行任何代码。
此后真正运行的只有 DSH 宿主进程里的 `lib/index.js` 和浏览器里的 `lib/client.js`——
两者都在包的 `files` 白名单内，仓库里其他文件不会被安装。

### 自己核对发布的字节

你不需要凭信任接受那个 tarball，也不应该需要。构建产物 `lib/` 是**入库**的，所以发布出去的包可以重新构建并逐字节比对：

```bash
npm pack dsh-task-progress              # 或者：curl -sL <tarball-url> -o p.tgz
tar -xzf dsh-task-progress-*.tgz
git clone https://github.com/chen8923/dsh-task-progress
cd dsh-task-progress && npm ci && npm run build
diff -r ../package/lib lib              # 无输出 = 发布的字节就是这份源码
```

`npm view dsh-task-progress dist.integrity` 是 registry 对该 tarball 记录的哈希，
所以"registry 哈希、tarball 内容、本地重建的源码树"这三者可以互相印证，**全程不需要信任维护者**。

## 兼容性

| | |
| --- | --- |
| **DSH** | 构建并实测于 `@deepseek-ai/dsh` 0.1.5-rc.2（commit `0e77055`），Web profile。 |
| **Node** | 插件本体要求 Node 20+（见 `engines`）；测试套件要求 Node 22.18+（它靠类型擦除直接跑 TypeScript 源码）。 |
| **用到的 DSH 接缝** | `webServer`、`connection`、`shellEnv`、`settings`、`systemPrompt`、`slots`、`sidebarRightTabs`、`locale`、`settingsScope`。**每一个都是可选的**：组合里缺哪个，就少哪一块界面，其余照常。 |
| **依赖** | 运行时零依赖。宿主半只 import Node 内置模块；浏览器半把自己的一切都打包进来，只把 `react` 当平台外部依赖。 |
| **冲突** | 不占用任何别人拥有的路径：往 `shell.overlay`、右侧栏、设置区各**增加**自己的一个条目（与官方插件同样的追加式注册），外加自己的路由、设置命名空间和提示词段，一律以 `task-progress` 命名。 |

## 触碰范围

装 DSH 插件**不是**沙箱内的行为——插件运行在 DSH 进程里，拥有该进程的权限。所以这里是完整的实际动作清单，让你**装之前**就知道，而不是装完再去读源码。这份表与 [`SECURITY.md`](SECURITY.md) 的承诺一致；**表与代码不符，本身就按安全问题处理**。

| 面 | 实际发生的事 |
| --- | --- |
| **读取** | `<root>/.dsh-progress/<会话 id>/<任务>.jsonl`，且只读文件尾部（默认每个文件 256 KiB）。`<root>` 是被 shell 调用交到它手上的 workspace 目录，加上你自己配置的绝对路径根。其它文件一概不打开。 |
| **创建** | `<workspace>/.dsh-progress/<会话 id>/`（该会话第一次 shell 调用时）。设置页的保存经 DSH 自己的设置服务写入该命名空间的用户层。 |
| **Shell 环境** | 每次 shell 调用会多出 `DSH_PROGRESS_DIR` 与 `DSH_PROGRESS_CLI` 两个变量。 |
| **联网** | 没有。不发任何外部请求，无遥测、无更新检查、不启动子进程。 |
| **HTTP** | 只有一个路由 `GET`/`HEAD /plugins/task-progress/state`，**先**过 DSH 自己的 `connection.requestRejection` 再读任何东西；一次只回答一个会话，响应里不含任何文件系统路径。 |
| **任务镜像** | 浏览器半画的是 DSH 自己的按会话 job 镜像——就是会话头部那份列表的同源数据：命令行、状态、已运行时长、结束细节。纯客户端读取，没有任何一项经过本插件的路由。 |
| **模型上下文** | 只加一段**静态**系统提示词（紧挨着 DSH 的后台任务说明）。另外，**每个后台任务最多一条**提醒，且仅当该任务已运行超过阈值（默认 30 秒，配置项 `remindAfterMs`；`0` 关闭）却无人上报时才发。 |
| **工具** | **一个都不加。** 工具目录原封不动——所以和多数插件不同，装它不会往缓存前缀里塞新的工具说明书。它的缓存代价是**一次性的短短一段**，加上上面那条罕见的提醒。 |
| **界面** | 悬浮层、右侧栏 tab、设置卡片各一个，都是往共享列表槽里追加自己的键。 |
| **内存** | 受配置约束：一次文档最多 `maxTasks` 个任务、每任务 `messagesPerTask` 条消息、每文件 `fileTailBytes` 字节，已知进度目录最多 64 个（LRU）。 |

漏洞请走[私密上报](SECURITY.md)，不要先开公开 issue。

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
预计超过约 30 秒的命令，**把它包起来**：

```
node "$env:DSH_PROGRESS_CLI" run --task <id> -- <你的命令>
```

它自己宣布任务、跟着命令的输出走、能读出百分比就报（行里出现 `12%` 或 `12/88` 都算），并按退出码写终态——不用写脚本，不用管重定向与编码，而且 task id 天然就在命令行里，这正是"这一行"与"那个 job"能对上号的原因。它表达不了的情况仍然可以手工上报：把进度写进 `$DSH_PROGRESS_DIR/<task>.jsonl`
（每个事件一行 JSON，格式见 dsh-task-progress 的协议），或使用
`node "$env:DSH_PROGRESS_CLI" emit --task <id> --pct N --msg "..."`。
不要把进度文件读回来——它是给人看的。
```

### 面板空白时

面板画**两类**行。

脚本**主动上报**的任务带着百分比、计数和消息出现。而**没人上报的后台任务照样会出现**：DSH 本来就为它自己的任务列表推送一份按会话隔离的 job 镜像，镜像里带着命令行、已运行时长和结束方式，所以插件把这些行画出来，而不是显示一片空白。它不会做的是**编造细节**：没有脚本上报就没有百分比，这一点由那一组下面的说明文字讲清楚，而不是画一根并不存在的进度条。

你**没在看的会话**里的任务仍然不可见——这里每个界面都以"当前视图的会话"为范围。

### 脚本被杀掉时

任务的终态一向由脚本自己写——这在脚本被杀的那一刻就成了问题：`job_kill` 会终止整棵进程树，在 Windows 上就是 `taskkill`，而它**不会执行任何用户代码**。`finally` 不会跑，任何处理器都不会跑，那一行终态不是"还没到"，而是**永远不会到**。这是实测的，不是推测：一个带 `finally`（会往文件追加一行）的后台 `pwsh` 任务被 `job_kill` 之后，被杀之后一个字节都没写。

所以终态不再依赖脚本跑到那里。宿主半去问 DSH 的 job 注册表——它的记录比进程活得久，并且写着结束方式——把一个**仍然写着 `running`、但它的写入方 job 已经结束**的任务按结束发布：`killed` 读作已取消、`failed` 读作失败、正常退出读作已完成。行下面会写明理由（*进程已被终止，未上报终态*），所以**推断永远不会被冒充成上报**，而文件本身保持生产者写下的原样。

有三件事决定这条推断能否落地，写脚本时值得知道：

- **让 task id 出现在命令行里**。行与 job 的配对用的是和"未上报的 job 行"同一套标签启发式：命令行里的 `--task sync-catalog` 认得出来，而命令行里从没出现过的 `job1` 认不出来。
- **一个 task id 只留一个写入者**，或者一个阶段一个 id。三个 job 往同一个文件里追加，不是一个"有三个写入者的任务"，而是一个"其中两个写不了终态的任务"。
- **终态该写还是要写**。`try/finally` 仍然覆盖异常、Ctrl+C 和正常路径，而且终态里带着真正的结果与消息。它是**机器直接死掉**时唯一的兜底，所以值得有——只是它不再是唯一能让一行结束的东西。

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
| 未上报多久提醒模型（毫秒） | `30000` | 后台任务静默多久后，模型收到一次提醒。这一项花的是**模型的上下文**，所以放在面板上让你能调小；`0` 表示从不提醒。 |
| 未上报任务也弹悬浮胶囊 | 关 | 脚本没有上报进度的后台任务，是否允许悬浮面板**主动弹出来**。默认关——它仍然列在右侧栏 tab 里。 |

保存会把用户层写进 `$DSH_HOME/settings.yaml`；按「重置」（或清空某个字段后保存）会移除覆盖，值依次回落到插件行的 `config`、再到 schema 默认值。改动**实时生效**：新的扫描间隔会在下一拍重新定时，状态文档里的 `pollMs` 与 `overlayUnreported` 也会跟着变成浏览器该用的值。

`dirName` **刻意不在面板里**——它已经写进了每一个路径，所以只作为插件行的组合层设置。

## 设计

三层，各自可替换——目标是生产者和界面互不知情，也都不依赖 DSH 内部实现。

| 层 | 形态 | 为什么这样 |
| --- | --- | --- |
| **协议**（`docs/PROTOCOL.md`） | 追加式 JSONL，一任务一文件 | 任何语言都能写；没有 IPC、端口、鉴权，重启不丢。插件不装也照样能用——文件就是文件。 |
| **宿主半** | `ctx.shellEnv` 贡献者 + 目录轮询 + 一个 HTTP 路由 + 一段系统提示词 + 一个 agent 步进监听 | 只用公开接缝（`webServer`、`connection`、`shellEnv`、`settings`、`systemPrompt`、`jobs`），并且把任务注册表当**非消费性快照**读——**绝不**调 `read()`（它持有的是输出游标）。 |
| **浏览器半** | 一个轮询 store、两个面板（`shell.overlay` 与右栏 tab），加一张设置卡片 | 两个面板读同一份快照，卡片读自己的命名空间 scope——增删任何一块都不动数据通路。 |

**为什么不去读任务输出。** `ctx.jobs.read()` 消费的是属于模型 `job_output` 的**单消费者游标**；浏览器路径读一次，就会悄悄拿走模型再也看不到的字节（DSH 把这条钉成了有测试兜底的不变量）。所以这里的进度是**脚本主动报告**的东西——这正是它可以和任何东西并存的原因。

**快照不是输出。** 同一个注册表还提供 `list()`，它的快照只携带**生命周期事实**——id、kind、命令行标签、时间戳、以及结束方式。观察这些与消费输出游标是两件不同的事，而它让本插件能做到本来做不到的两点：为一个没人上报的任务画出一行；以及在模型**还来得及行动**的那一步，告诉它有一个长任务正在无人可见地跑着。同一个游标被两个消费者读是 bug，而一个快照被两个观察者看不是。

**为什么用轮询而不是推送。** 数据就是本地几 KB 的 JSON；轮询回路是唯一不会失步的设计：所有读者看到同一份 last-wins 文档，漏一拍只损失一个间隔，也没有重连逻辑可写错。间隔由宿主半的配置统一下发。

**零依赖。** 宿主半只 import Node 内置模块；浏览器半把自己的一切都打包进来，只把 `react` 当平台外部依赖。这条原则一直延伸到设置 schema：`ctx.settings.register` 要的是 schemastery schema，而本插件自己提供了一个最小兼容节点——可调用（用于解析）、`toJSON()` 输出 schemastery 的**引用图**格式、并可被设置脱敏器结构遍历——而不是去依赖一个 profile 里根本解析不到的包。它自己的浏览器卡片还传了 `decode`，因此完全不需要反水合任何 schema 信封。

### 刻意不做的事

- **不做历史。** 进度是实时状态，不是日志；结束的任务会老化消失。
- **不做取消按钮。** 停任务是模型的 `job_kill`（人类主动中断涉及一个本插件无权决定的投递语义问题）。顺带一提，`job_kill` 会连进程树一起杀，被杀脚本写不出终态——那一行由宿主半从 job 记录里结算，见「脚本被杀掉时」。
- **不做远程生产者。** 一切都在会话本来就能写的本地 workspace 文件里。
- **不做会话查询。** 目录来自"被交到手上的那些 shell 调用"加配置的根目录——所以它不会复活会话，也不会去读浏览器给的路径。
- **不做跨会话读取。** 状态端点一次只回答一个会话，且响应里不放任何文件系统路径。DSH 的 Web 登录是**整个实例**级别的围栏、不是会话级的，所以一个"把进程知道的全部吐出来"的端点，等于把其它所有会话的任务名和消息交给任意已登录调用者。

## 开发

```bash
npm test              # 187 个测试，单进程（受限沙箱里也能跑）
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
test/                  十七套测试：协议、job 结算、store、格式化、宿主接线、设置、
                       设置表单、提示词段、会话钩子、客户端 store、CLI、包装器、
                       构建产物、设置卡片外观、隐私、发版一致性
tools/                 测试入口与构建/打包/安装脚本
```

**构建工具链是钉住的，并且已经让 Dependabot 别碰它。** `tsdown` 与 `typescript` 固定为精确版本，因为 bundler 一升级，提交在仓库里的 `lib/` 字节就会变 —— 而 `lib/` 正是发给用户、也是 git 安装所取的那份构建产物。升级与重建必须落在同一个提交里，机器人只能完成前半步，所以 `.github/dependabot.yml` 把这两个依赖整个忽略掉。**这也包括它们的安全更新 PR**（官方文档写明：该选项同样改变安全更新 PR 的创建方式）。留下的信号是 Security 页上的 Dependabot **告警**，它就是动手的触发点：升版本 → `npm run build` → 确认 `test/bundle.test.ts` 仍通过 → 把重建的 `lib/` 放进同一个提交。其余部分（workflow 里的 actions、lockfile）照旧收自动 PR —— 自动化该用在这些地方。

**`screenshots.json` 是市场元数据，不是构建输入。** 插件目录与 dsh-market 的详情页会展示它指名的界面截图，约定是**由仓库自己声明**而不是写进列表：1–8 条相对本文件的路径，且不得跳出插件目录。它对运行时没有任何影响，指向的图片就是 `docs/` 本就在发的那一张。

### 发布

```bash
npm test                                              # 168 项检查，单进程
git push && git tag v0.2.0 && git push origin v0.2.0   # 由 CI 发布，并带 provenance
npm publish                                           # 手工兜底：先构建再发布
```

`test/release.test.ts` 会在这些情况失败：`package.json` 的版本没有同时出现在两个 README 与
CHANGELOG 里；文档里让用户跑的某个示例没被打进 `files`；或者仓库链接与安装说明指向不同项目
——所以"版本/链接出现的四个地方"不可能各自漂移。

打 tag 后由 `.github/workflows/publish.yml` 发布（需先在 npm 上配置 trusted publisher：
仓库 `chen8923/dsh-task-progress`、workflow `publish.yml`）。这条路径**不存任何 token**，
并会给 tarball 附上签名 provenance，把它钉到具体 commit。手工 `npm publish` 在 npm 允许
2FA-bypass token 直接发布之前仍然可用——官方计划 2027 年 1 月取消——但它永远无法带 provenance。

## 许可证

MIT
