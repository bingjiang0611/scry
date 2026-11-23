# W18 · 一次做完：S3 收尾 → P4-4 → P4-5a（含 P5 剩余）→ P4-5b → P4-6

执行方：维护者本机的单个执行方（下称「执行方」），在 macOS 上做。核验方额度有限，本任务由执行方**自己实现、自己评审、自己验证**，按阶段推送；核验方之后在分支上复核。协作规则照 [README](../README.md) 全部适用（分支、身份、提交、证据目录、报告格式、测量互斥）。

起点：`claude/scry-performance-optimization-46ngcf` 的 `84ef9881`（S3 及其修复已合入，冒烟回归未跑完）。

## 0. 工作方式

- **严格按阶段顺序做**：S3 收尾 → P4-4 → P4-5a → P4-5b → P4-6。前一阶段的「阶段门」全部通过，才开始下一阶段。
- **每个阶段的流程**：
  1. 先读设计依据。
  2. 写失败测试，再实现，小步提交。
  3. 每个可验证单元推送一次。
  4. 阶段末做一次**独立评审**：如果你能开子 agent，开一个只读评审 agent。只给它代码范围和设计文档，不给你的结论，让它找正确性回退、安全与授权漏洞、性能门限是否被放宽。不能开子 agent 时，自己按这三类逐条过一遍。
  5. 修掉评审发现的阻塞项。
  6. 跑阶段门。
  7. 更新报告并推送。
- **报告**：`reports/W18.md`，第一行写 `状态：进行中（阶段 X）`。每个阶段一节，写结论、提交、验收逐项、评审发现与处理、未验证项。文件快到 20 KB 时，新建 `W18-2.md` 续写。
- **可续跑**：额度或会话中断后，重新执行同一个目标。先读 `reports/W18*.md` 和 `git log`，从记录的阶段与步骤继续，不重复已完成的部分。
- **需要维护者动手的地方**：iPhone 安装、点击、系统对话框、`/Applications` 安装。做到这一步时停下来叫维护者，说清楚要做什么、看什么；拿到结果后继续。维护者不在时，先做不依赖这一步的部分，并在报告里记录。
- **不开 PR，不合并 main**。全部完成后告诉维护者，由核验方复核后开 PR。

## 1. 不可违反的约束

- 不放宽任何性能门限、预算、棘轮文件，不跳过、禁用或弱化测试与冒烟断言来换取通过。测试的前提确实只对旧路径成立时，可以改测试，但要在提交说明里写清理由，并保留对产品行为的断言。
- 测试只用临时 HOME、userData 和测试标签。不碰日常的 `com.scry.daemon`、真实 `~/.scry` 和真实 userData。不改 `~/.gemini`、`~/.codex`、`~/.qoder`。
- 不用 `pkill`/`killall`。结束进程前先核对命令行，按 PID 结束。Electron 不加 `--no-sandbox`。
- 单文件小于 20,000 字节（`node scripts/check-staged-file-size.mjs`）。代码、注释、文档里不写模型名称、账号邮箱或 ID。
- `src/cli` 只在设计明确要求时才改，每个阶段都要 `npm run check:cli-runtime`。协议版本只在 P4-5b 升到 v3。
- 静态检查 `node scripts/main-import-boundary.mjs --strict` 始终为 0 违规：main 不导入编排模块。
- 设计有歧义时选更保守的做法，写进报告「与设计的出入」。真正需要维护者决定的，附推荐写进报告，然后继续做不依赖它的部分。

## 2. 阶段一：S3 收尾

依据：[P3-s3-plan](../../P3-s3-plan.md)（尤其 §7.6）、`reports/` 下的 S3 记录，以及 `84ef9881` 之前各提交的说明。

1. **冒烟回归（macOS 原生跑，打包与开发两种布局都跑）**：
   - 以下 5 个子模式在 Linux 上修过，但最后一轮没跑完，必须逐个确认：
     - `--dev-unified-conversation-only`
     - `--dev-unified-conversation-only --workspace-start`
     - `--dev-side-chat-only`
     - `--dev-side-chat-large-history-only`
     - `--dev-structure-only`
   - 再把 `scripts/electron-security-smoke.mjs` 的全部子模式跑一遍。
   - CI 第 3 分片对应的 `test:renderer:ui:3`（含 `test:side-chat:ui:prebuilt`、`test:workspace:ui:prebuilt`、`test:conversation:ipc:prebuilt`）必须在本机通过。
   - `--dev-question-only`、`--dev-file-history-only`、`desktop-remote-host-smoke`、`daemon-mode-smoke`：之前在 Linux 上没法跑，这次在 macOS 上跑。
2. **基准测试采样**：`performance-soak` 和 `session-concurrency-bench` 现在只采 App 主进程，运行工作已经在 daemon 里。
   - 改为同时采 daemon 进程（PID 从 daemon 状态文件或 supervisor 取得）。
   - 做不到时，脚本输出和文档都要明确写「未采 daemon」，不编造数字。
   - `concurrent-performance` 在 daemon 模式下要真跑通一次。
3. **原生性能门**：`session-open-bench` 现在两边都只测 daemon（`measurementVersion` 8）。按 S1 流程（同一构建、计时锁、负载/核心数 ≤ 0.5）在本机跑一轮原生门，记录结果，门限不变。
4. 修掉以上发现的问题，更新 `P3-s3-plan.md`，标注 S3 完成状态。

**阶段门**：
- `npm run typecheck`
- 全量 vitest：只允许既有的环境性失败，并逐条列出。
- `--strict` 导入检查
- `check:cli-runtime`
- 上面全部冒烟逐项列出结果
- 原生门结果

## 3. 阶段二：P4-4（会话目录与详情 projection，renderer 读 projection）

依据（按设计实现，不重新设计）：
- [P4-orchestration-plan](../../P4-orchestration-plan.md) §9 表中 P4-4 一行，以及「旧会话（决定 E）」段落
- [P4-orchestration-data](../../P4-orchestration-data.md) §3、§4
- [P4-orchestration-core](../../P4-orchestration-core.md)
- [P4-orchestration-decisions](../../P4-orchestration-decisions.md) §11 决定 E、§14 决定 H
- [P4-orchestration-protocol](../../P4-orchestration-protocol.md) §5、§6

范围：
- 会话目录与详情 projection。
- 把 `app-sessions.json` 的会话元数据增量导入为 `session.imported`，证据引用文件哈希，**不导入** turn 正文。旧会话详情快照带 `legacyBefore: true`，宿主在同一回答里附上旧只读路径的首页，客户端不合并；旧会话里新发生的 turn 用 `ordinal_origin: since_import`。
- `catalog.scan` 触发。
- transcript 区间引用：文件删除后为 `unavailable(source_removed)`。
- 首屏快照。
- renderer 的侧栏与详情改读 projection。
- 删除会话：正文文件删除、预览擦除、projection 行消失，并发出墓碑；`scry.db` 不可用时返回 `unavailable`。
- **W16 遗留 S4**：终态缺失 trace 时，归档回退不再读取整个会话历史，改为按 run 读取；补上实时与归档重叠时的去重测试。
- **遗留 #40**：从 App 的 turn diff 和会话基线里排除 `.scry` 数据目录，先写失败测试。

**阶段门**：
- 计划 §10「测试」表里与本阶段相关的行，全部为 CI 级测试并通过：projection 重放逐字段相同（含 `rev_seq`）、性质测试、schema 迁移、证据可追溯、删除会话、off↔on、两本账。
- 阶段一的全部检查。
- 冒烟：`--dev`、会话归属、侧聊、统一会话、结构。
- macOS 真机：中文系统语言 + 中文工作区路径下，侧栏与详情正确；旧会话显示正确；首屏没有变慢（session-open 原生门）。

## 4. 阶段三：P4-5a（`subscribe` 作为 v2 能力）+ P5 剩余

依据：protocol §5（5.1–5.7，含决定 F）、§6；plan 中 P4-5a 一行；[P5-host-security](../../P5-host-security.md)、[P5-host-cli](../../P5-host-cli.md) 中关于通知的部分。

范围：
- Desktop、iOS、执行目标转发都改用 `subscribe`。
- keyset 分页，逐行授权（每个请求都重新授权）。
- 执行目标转发只在 Mac2 声明能力时开放 `subscribe`。
- 不认识的可选字段，客户端解码器一律忽略。
- **P5 剩余：iOS 显示执行端管理通知**。按 protocol §5.3，把通知作为易失提示 `hostNotice` 下发；在 iOS 上展示命令行批准等执行端管理通知。iOS 代码在本机用 Xcode 编译并跑测试。
- 老客户端（不认识这项能力的）行为不变，继续走旧 op。

**阶段门**：
- 计划 §10 测试表中的「乱序与重置」「授权」「多 Agent 预留」「控制实验」全部通过。
- iOS 单测与编译通过。
- 冒烟全套通过。
- **真机（叫维护者）**：
  - 装了 v2 的 iPhone 用上新能力，实时更新、分页、断线重连都正常。
  - 执行端通知能在 iPhone 上显示。
  - 跨机器的执行目标转发正常：维护者的 mac2/mac3 已配好时一并验证，没配好就记为未验证。
  - SIGKILL 运行中的 daemon 后，App 重启能接回运行。

## 5. 阶段四：P4-5b（升 v3，删除旧 op 和开关）

前置：P4-5a 真机通过，S3 已完成。依据：protocol §5.4、§5.7；plan 中 P4-5b 一行，以及「开关与 off↔on」段落。

范围：
- 协议升到 v3。只删旧 op，涉及宿主、Desktop、iOS、转发白名单四处。
- 删除 `SCRY_ORCHESTRATION` 开关和 off/shadow 路径。W16 遗留 S2（on→off 后 App 要重启）随开关删除而消失，在报告里注明。
- 删除轮询：`LIVE_RUNS_TICK_MS`、renderer 的远程读循环、iOS 800 ms 回退。加静态检查，保证这些不再出现。
- v2 手机连 v3 宿主时，要有明确的升级提示。

**阶段门**：
- 「轮询已删除」：空闲 60 s 内 RPC 次数为个位数，静态检查通过。
- 全部 CI 级测试和冒烟通过。
- **真机（叫维护者）**：
  - v3 的 iPhone 全流程正常。
  - 旧版 iPhone 连上来能看到升级提示。
- 打包产物检查：`better-sqlite3` 已解包，打包冒烟通过。

## 6. 阶段五：P4-6（清理）

依据：plan 中 P4-6 一行，以及「`AppEventFeed` 归属」那一行。

范围：
- 删除 H1 文件与镜像（含决定 H 的预留 seq 逻辑）。
- 删除 `CommandReceipts`。
- 删除 `AppEventFeed` 的持久类。**P5 的 `hostNotice` 不删。**
- 删除 `result` 标记里的数字。
- 改正 `run-output-log.ts:7-9` 的注释。
- 删除已经不可达的代码和测试。导入检查与矩阵测试更新后仍然为 0 违规。

**阶段门**：
- 全量检查。
- 冒烟全套。
- 一轮原生性能门。
- 「fail closed」「幂等与回执」「派发与重启」三类测试仍然通过。

## 7. 收尾

1. 按 plan §10「测试」表逐行写出「通过 / 失败 / 未验证（原因）」。真机行写清做了什么、看到了什么。
2. 在 `P4-orchestration-plan.md` 和 `P5-host-security.md` 里标注完成状态。`STATUS-BATCH4.md` 加一行。
3. 报告第一行改为 `状态：待核验`，推送。最后把下面三样告诉维护者：
   - 最终 SHA；
   - 未验证项；
   - 需要维护者决定的事项。
