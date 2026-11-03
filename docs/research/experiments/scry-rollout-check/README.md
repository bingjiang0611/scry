# scry-rollout-check

在本机临时目录里，对已安装的 Scry uploader 跑 20 个黑盒场景：故障、并发、积压、开关、崩溃、隐私、定时补传、hook 延迟、升级回滚、登录过期。另附 `record-check.mjs`，给真实 Provider 录制和真实上传出机器可判定的结论。两部分都可以整份交给 Agent 执行。

**不会碰真实环境**：每个场景都有独立的临时 `HOME`、`XDG_STATE_HOME`、`XDG_CONFIG_HOME` 和工作区；传输层换成本目录里的假实现，不联网；不调用 `register`、`scheduler-install`，不碰 launchd 和你真实的工作区。

## 准备：填协议映射（只需一次）

公开快照里，传输 CLI 的环境变量、工具名、身份字段都是别名。打开 `protocol.json`，对照私有 uploader 源码换成真实值：

| 字段 | 含义 | 在源码里找 |
| --- | --- | --- |
| `transportEnv` | uploader 读取传输 CLI 路径的环境变量 | `transport.ts` 的 `transportExecutable` |
| `toolName` | 上报用的 MCP 工具名 | `constants.ts` 的 `MCP_TOOL` |
| `argumentNames` / `recordsArgument` | 工具参数名（7 个，顺序不能变） | `transport.ts` 的 `ARGUMENT_ORDER` |
| `whoami.userIdField` / `nickField` | 身份查询返回的字段名 | `transport.ts` 的 `actorIdentity` |
| `response.*` | 上报响应的包装与条目状态名 | `uploader-worker.ts` 的 `validateReportResponse` |
| `capabilityTool` | 记录带 content 引用时、上报前先调用的能力查询工具名（0.2.8 起；更早的版本不调用，保持默认即可） | 私有源码里上报前的能力查询调用 |
| `contentProtocol` / `contentDigestPrefix` | 能力查询应答的 content 协议名；条目 `contentSha256` 的前缀（默认无前缀，十六进制） | 同上，以及上报响应校验 |

## 运行

需要 Node ≥ 20、git。

```sh
# uploader 是 PATH 上的命令
node run.mjs --uploader scry-upload

# 或者直接指向安装包里的 CLI 入口
node run.mjs --uploader "$(npm root -g)/<uploader 包名>/dist/cli.js"

# S19（带积压升级 + 回滚探测）需要再给一个旧版本，否则记为 SKIP
node run.mjs --uploader scry-upload --old-uploader /path/to/<同事手上最老的版本>/dist/cli.js

# 只跑部分场景；保留临时目录便于排查
node run.mjs --uploader scry-upload --only S02,S10 --keep
```

全部跑完约 8 分钟（Linux 容器实测）。结束时打印汇总，并在当前目录写 `rollout-report-<时间>.json`。退出码：有 `FAIL` / `ERROR` 为 1，否则为 0。

## 结果含义

- `PASS`：符合预期。
- `SKIP`：缺少运行条件（S19 没给 `--old-uploader`），不算通过。
- `KNOWN`：命中已登记的已知问题（目前只有 S15 的两个脱敏缺口），不阻塞，但要跟踪修复。
- `FAIL`：行为不符合预期，推广前必须查清。
- `ERROR`：场景自身没跑起来，通常是 `protocol.json` 没填对，或 uploader 路径不对。

## 场景

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| S01 | 正常上传 5 条 | 5/5 上传，无死信 |
| S02 | HTTP 503 整体故障 25 秒后恢复 | 故障期请求 ≤ 15 次；恢复后全部上传；0 死信 |
| S03 | 无法识别的整体故障（"服务繁忙"）40 秒后恢复 | 故障期 0 条死信；恢复后全部上传 |
| S04 | 一条坏记录（413） | 其余 9 条全部上传，不被卡住 |
| S05 | 一条坏记录（无状态码的业务错误） | 其余 9 条全部上传 |
| S06 | 传输超时后恢复 | 恢复后全部上传，0 死信（超时退避约 60 秒起，耗时较长） |
| S07 | 服务端已写入但响应丢失 | 以同一身份重发，按 duplicated 收下 |
| S08 | 响应格式不对（持续 60 秒） | 60 秒内请求 ≤ 12 次，没有每秒重试 |
| S09 | 20 次 hook 同时触发 | 存活的 worker 进程 ≤ 2 |
| S10 | 5 个仓库各 8 条同时上传 | 40/40 上传；同时在途的上传 ≤ 2 |
| S11 | 关闭 → 提交 → 开启 → 手动放行 | 关闭期间记录不上传；开启后新记录上传；只放行指定那一条 |
| S12 | 被拒绝 → 死信 → redrive | redrive 后重新上传成功 |
| S13 | 自定义 `dataDir`（路径含空格） | 正常上传，不在 `.scry/upload` 写任何东西 |
| S14 | 上传中途杀掉 worker | 下次唤醒后全部上传 |
| S15 | 传输层 stderr 带凭证 | 状态文件、`flush`、`doctor` 输出里都不出现凭证 |
| S16 | 上传中途删除工作区 | 工作区不被重新创建，worker 退出 |
| S17 | 2 个已 `register` 的仓库在故障期积压，worker 被杀，只靠定时补传入口 `_recover`（禁止 hook 拉起 worker） | 恢复后 4 分钟内 8/8 上传 |
| S18 | 连续 20 次 `notify`（hook 路径）的耗时 | p95 ≤ 1500 ms，hook 不阻塞会话 |
| S20 | 登录过期时提交 2 条，再重新登录 | 记录留在本地、不进死信；状态里能看出是登录问题；冷却期内额外唤醒不反复请求；重新登录后 `flush` 立即上传 |
| S19 | 旧版本在故障期积压后升级到新版本，再用旧版本读一次 | 升级前后待上传、挂起、死信计数不变（需要时自动提示 `migrate`）；新版本恢复后全部上传；旧版本读取不损坏队列 |

## 已验证能抓到的缺陷

在旧版本上跑过，以下场景确实会失败：

| 场景 | 旧版本 | 旧版本上的结果 |
| --- | --- | --- |
| S04 | 0.2.0 | 其余 9 条 0/9 上传（队头阻塞） |
| S09 | 0.2.0 | 20 次 hook 留下 20 个 worker |
| S03 | 0.2.4 | 整体故障期间有正常记录被送进死信 |
| S15 | 0.2.5 | Bearer token 原样出现在 `doctor` 输出里 |
| S20 | 0.2.0 | 登录过期只显示 `actor failed`，看不出是登录问题 |

在 0.2.7 上：19 个 `PASS`（S17 约 32 秒排空；S18 p50 224 ms、p95 283 ms，Linux 容器测得，Mac 上以实测为准；S19 在 0.2.0→0.2.7、0.2.5→0.2.7 上均通过，但还没有在已知有缺陷的版本上验证过能报错），S15 为 `KNOWN`（多个 Cookie 键值对时后面的值、引号里带空格的值没有被完整脱敏）。

## record-check.mjs：真实录制与真实上传的判定

`run.mjs` 用的是合成记录和假传输层。真实 Provider 跑出来的记录、真实服务端的回执，由 `record-check.mjs` 判定。它只读本地证据（records、回执、status），不上传、不改记录、不读凭证。Provider 由执行的 Agent 驱动，每轮提示词里带一个唯一标记（如 `[rc-codex-tool-1a2b]`），脚本靠标记把记录和轮次对上。

```sh
# 跑轮次之前记下高水位
node record-check.mjs snapshot --workspace "$WS" > snap.json

# 跑完一个 Provider 的三轮后判定录制
node record-check.mjs turns --workspace "$WS" --since snap.json --provider codex \
  --expect tool:rc-codex-tool-1a2b,text:rc-codex-text-1a2b,interrupt:rc-codex-stop-1a2b \
  --file rollout-1a2b.txt --scry "$(command -v scry)" > turns-codex.json

# 判定上传：outbox 排空、0 死信、每条都有 uploaded 回执、repo 是 host/org/repo
node record-check.mjs upload --workspace "$WS" --turns turns-codex.json --uploader "$UPLOADER" --timeout 180

# 压测或日常期间定时采样，结束后出结论
node record-check.mjs observe --workspaces "$WS1,$WS2,$WS3" --uploader "$UPLOADER" --interval 60 --count 60 --out obs.jsonl
node record-check.mjs report obs.jsonl
```

`turns` 检查：新增记录数与轮次数一致、recordId 不重复、Provider 正确；证据诚实（`unavailable` 不带空列表、缺失的用量不写成 exact 0、`unavailable` 有原因）；工具轮有工具调用且文件足迹里有指定文件；纯文本轮是 `available + []` 或 `unavailable`；停止的轮次不是 `completed` 且有 `partial` 段。`--scry` 给出时再跑一次 `scry turns verify`。

`upload` 和 `observe` 的 `--uploader` 要指向 `cli.js`（`$(npm root -g)/<uploader 包名>/dist/cli.js`）：`repo` 格式检查调用同目录 `transport.js` 里 uploader 自己的 `repositoryName`，进程统计只认这个路径下的 worker。

结论：`PASS` 通过；`WARN` 测试本身不够干净（模型在纯文本轮仍调了工具、停止信号到达前轮次已结束），换提示词重跑；`UNAVAILABLE` 该 Provider 不提供这项证据，如实记录，不算通过也不算失败；`FAIL` 推广前必须查清。退出码：有 `FAIL` 为 1。

## 局限

- `run.mjs` 的记录是合成的，和 Provider hook 走同一条 `notify` 路径，但不验证真实录制；真实录制用 `record-check.mjs turns`。
- 假传输层只模拟协议，不能证明真实服务端的去重、限流和请求体大小上限；`record-check.mjs upload` 以回执里的 `inserted` / `duplicated` 为准，不独立查询服务端。
- S17 直接调用定时补传入口 `_recover`，不经过 launchd；launchd 本身的加载与触发在测试清单的 Agent 步骤里单独验证。

## perf-bench.mjs：性能基线

给 recorder 的 hook 路径和 uploader 跑一份带环境信息的基线，用于以后在同一台机器上对比。默认不联网、不花钱、不碰源仓库。

**先按上面“准备”一节填好 `protocol.json`。** 公开快照里的 `transportEnv` 是别名，真实 uploader 不认它时会直接调用真实传输 CLI。`run.mjs` 和 `perf-bench.mjs` 开始时都会先跑一次 `doctor`，确认 uploader 真的调用了假传输层；确认不了就在提交任何记录之前退出，不会上传。

```sh
node perf-bench.mjs --source <你的仓库> --work <副本路径，必须在源仓库之外> \
  --scry "$(command -v scry)" --uploader "$(npm root -g)/<uploader 包名>/dist/cli.js" \
  --rounds 7 --out <结果目录>
```

- **副本**：逐项克隆源仓库（macOS 用 APFS 写时复制，Linux 用 reflink），不复制 `.scry`；删除副本 `scry.config.json` 里的 `commitHook`，把 `origin` 改到 `perf-bench.invalid`。克隆失败时直接报错，加 `--allow-full-copy` 才做完整复制。源仓库是 linked worktree 时拒绝运行（副本会共享原索引）。
- **recorder**：在副本里 `scry init`，用合成的 hook 事件经副本自己的 `.scry/provider-hook.sh` 跑完整轮次（默认按 Qoder 的事件格式，`--provider` 可改）。场景：干净工作树下 0 / 5 / 30 次工具调用；修改 20 个已跟踪文件并新增 50 个文件后 5 次工具调用。daemon 快路径和 CLI 回退（`SCRY_RECORDER_TRANSPORT=direct`）各跑一遍。量轮次开始、单个工具事件、轮次结束、每轮 hook 合计、结束到记录落盘，以及 daemon 的 RSS 和 CPU（含 30 秒空闲）、每条记录占用的磁盘。
- **uploader**：临时 HOME + 假传输层，载荷是 recorder 阶段生成的真实记录（循环使用，大小分布和你的仓库一致），记录引用的 `.scry/content` 正文一并克隆过去。场景：边提交边上传（streaming）100 条；先积压再一次唤醒排空（backlog）100 / 500 条；假服务端延迟 0 和 250 ms 两档。量 notify 耗时、排空时间、条/秒、请求数、能力查询次数、请求体大小、worker 峰值数和 RSS、上传目录每条占用。某个场景在 `--drain-timeout-min`（默认 15）内没排空时记为 `unavailable`，并注明是“仍在排空”（最后 30 秒积压在减少、没有新增死信，附最后 30 秒的速度）还是“卡住”；仍在排空时加大超时重跑即可。
- **hookwrap（uploader + Scry CLI 的组合）**：在同一份副本上先用 Scry 自己的 hook 跑，再像同事那样执行 `<uploader> init` 装上包装后的 hook，跑同样的轮次，报告包装前、包装后和增加的耗时，并单独计时 `wakeup` 启动器、核对这些轮次经假传输层传完。临时 HOME/XDG，先确认走的是假传输层；副本的 `.scry` 暂时挪开，`scry.config.json` 和 Provider 配置目录原地保留、结束时按原字节恢复。`--uploader-scry <cli>` 让 uploader 用指定的 recorder 装 hook（默认用它自带的）。同时给了 `--scry` 和 `--uploader` 时默认跑，`--skip-hookwrap` 跳过。
- **git 调用计数（L1）**：recorder 和 hookwrap 的每个场景，另跑一轮不计时的计数轮：`git` 前面放一个记录调用的垫片，daemon 在垫片下重启，后台上传进程关掉。报告轮次开始、全部工具事件、轮次结束各调用几次 git，以及按子命令的分布。计数是精确值，和机器负载无关。
- **记录内容摘要**：recorder 阶段最后跑一轮改动过文件（含前 3 个子仓库各一个文件）的轮次，把这条记录的 diff、文件足迹等归一化（副本路径、时间、ID 去掉）后求 SHA-256。优化前后摘要必须一致。
- **多仓库工作区**：报告记录子仓库数量（`nestedRepos`，树里嵌套的 git 仓库，不只是 submodule）；改动场景会改前 3 个子仓库各一个已跟踪文件。`scry.config.json` 和 Provider 配置目录从不被改动。
- **端到端（可选，花钱）**：`node perf-bench.mjs e2e --work <副本> --cmd '<Provider 命令，提示词位置写 {prompt}>' --runs 5`。同一提示词轮流在开启和关闭记录（`SCRY_RECORDER_ENABLED=0`）下各跑一次，记录耗时差值；模型响应波动远大于 hook 开销，只记录，不做门禁。先在副本里对这个 Provider 执行 `scry init`。

其他选项：`--phases recorder,hookwrap`（任选阶段，`--only` 等价于只选一个）；`--label <被测构建>`；`--workload-name <别名>`（结果里不写真实仓库名）；`--protocol <文件>`（真实协议映射放在仓库外，也可用环境变量 `SCRY_PERF_PROTOCOL`）。

输出 `baseline-<时间>.json` 和 `.md`，其中家目录一律写成 `~`。毫秒是本机在当时负载下的墙钟时间，报告里带每个阶段的负载；只和同一台机器的后续结果比较。测不到的项写 `unavailable` 和原因，不写 0。脚本持锁，同一时间只跑一份；运行时不要跑别的重任务。这是受控测量，不是日常使用下的结论，也不进 `scripts/performance-ratchet.json`。

### 合成基线：perf-compare.mjs

单次运行只说明那一次。把同一台机器上的两次或多次运行合成一份基线：

```sh
node perf-compare.mjs <baseline-A.json> <baseline-B.json> [更多...] [--threshold 20] [--out <目录>]
```

- **可以只含一个阶段**：`--only recorder` 和 `--only uploader` 分开跑出的文件可以一起传入，每个阶段只在包含它的文件之间比较（例如两份 recorder-only 加两份 uploader-only）。
- **整体失败的阶段会被排除**：某个文件里某阶段整体失败（例如 `uploader phase failed: ...`），它没有可比较的测量，只从这个阶段排除，并在输出的“排除的输入”里写明文件和原因；同一文件里成功的其他阶段照常参与。每个阶段至少要有两份完整文件，不够就标为“未比较”并写明原因；没有任何阶段可比较时拒绝（退出码 2）。单个指标测不到仍按下面的规则列入“测不到”。
- **环境不一致就拒绝**（退出码 2，并写明是哪个字段）：所有文件必须来自同一台机器（系统、内核、芯片、核数、内存、Node）；同一阶段内还要求版本和工作量一致——recorder：git、scry 版本、轮数、Provider 形状、源仓库规模；uploader：uploader 版本、轮数、载荷、传输层、正文来源。
- **怎么判定**：每个指标取各次运行的 p50，波动 =（最大 − 最小）/ 各次 p50 的中位数；波动 ≤ `--threshold`（默认 20%）的进基线，基线值取各次 p50 的中位数。其余列为“不稳定”；任何一次测不到的列为“测不到”，附每次的原因，不算 0。
- 输出 `BASELINE-<日期>.json` 和 `.md`，带环境、每次运行的负载和各次 p50 / p95。它只是同机对比的参考，不是门禁，不写入 `scripts/performance-ratchet.json`。

### 基线对候选：perf-ab.mjs 与 ab-session.mjs

`ab-session.mjs` 把一次 A/B 做完：基线和候选按 A B B A 交替运行（每次运行前负载须低于核数一半，等 3 次不达标就停），最后调用 `perf-ab.mjs` 出结论。用法见 `../scry-perf-climb/README.md`。

`perf-ab.mjs --base <文件...> --cand <文件...> [--phases ...] [--min-gain 10] [--ms-floor 5] [--allow allowed.json]`：

- 同一台机器、每个阶段同一工作量才比较，版本可以不同；不一致就拒绝（退出码 2）。
- 计数（git 调用、传输请求、能力查询等）是精确值：同一侧各次必须一致，候选任何增加都算变差。
- 耗时、资源、速度取各次 p50 的中位数。要同时满足才算变好或变差，否则记“无明确变化”：
  - 幅度至少为基线的 `--min-gain`%（默认 10）、`--ms-floor` 毫秒（仅耗时，默认 5）；给了 `--calibration <A/A 的 AB json>` 时，还要超过同一指标在 A/A 里变化的 2 倍；
  - 候选的每次运行都落在基线每次运行的同一侧；
  - 有原始样本时（新版 perf-bench 的耗时都有），两侧样本合并做 Mann-Whitney 检验，p < `--alpha`（默认 0.01）；没有样本时改为要求超过两侧各次运行的极差。
- 记录内容摘要必须相同，变了算变差。
- `--allow` 列出有意接受的变差（指标名或前缀 → 理由），仍会逐条列出。
- 输出 `AB-<时间>.json` / `.md`。退出码：0 无未豁免变差，1 有变差或计数不稳定，2 拒绝比较。
