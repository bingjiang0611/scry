# 2026-10-26：独立集成第二轮

## 结论与边界

已提交的 recorder 重试修复与性能分支组合后，本轮全量 unit、完整 UI 命令链、类型检查、CLI 构建和性能门禁通过。独立集成提交为 `bda0c854`。**没有合入原开发分支、push、打包或安装。**

这是新组合版本的验证，不是抹去[上一轮失败](20261026-integration-check.md)：两项 UI 首次失败的根因仍未知。本轮加入失败证据，不宣称修好了 UI 偶发问题，也不据一次通过承诺后续 CI 稳定。

## 输入、恢复与源码身份

- 前轮冻结开发基线 `d837ed22` 只有通知重试的新测试，对应实现尚未提交；12项失败与未集成基线完全一致。
- 本轮开始时原工作区已干净，开发 HEAD 为 `e1b120cc`，包含 `2524cf11` 测试与 `7631f532` 实现。只使用已提交内容，没有读取或复制其他任务的 WIP 作为实现。
- 原本机 `/private/tmp/scry-performance-climb-20261025.yjlnNW` 已不存在。Git 分支及 mac2 的源树、原始日志仍在。新本机目录改为 `~/.local/state/scry-performance-resume-20261026.3YkqtM/`，重建 `source` 和 `integration` worktree；保留 mac2 旧失败合并现场。
- 测试输入：`e1b120cc` + 性能分支 `9d2d04c0` + 三文件诊断补丁。两机 index tree 均为 `8d0a951b8c9973511991a78a4cf4d9235056225a`。
- 诊断单独提交 `39b1488c`。测试期间开发分支又增加纯文档 `c7388c38`。最终独立合并父提交为 `c7388c38` 与 `39b1488c`；合并 tree `6ce4389c41eb9e434a26d2ac87bf56e74cd631e7`。
- 对测试 tree 与合并 tree 做完整路径差异断言：只有 `docs/handoff/collection-reliability-2026-10-24/` 下 STATUS、USER-VERIFY、reports/E 三个文档。生产代码、测试、配置和依赖锁完全相同。
- mac2 在核对原 index tree、无未暂存改动后 checkout 已提交的 `bda0c854`，无强制覆盖；三个诊断文件 SHA 均再次匹配。远端仅有有意保留的 `node_modules` 符号链接未跟踪。

首次 bundle 创建只传对象名，Git 报 `Refusing to create empty bundle`；改用明确分支引用后成功。失败发生在传输/应用之前，不涉及重复执行测试或未知写入。

## 本轮改动：保留失败证据，不降低标准

`39b1488c` 只修改三个测试文件：

- `scripts/native-ui-pointer.mjs`：超时错误附带最后的 readiness 原因、目标/实际命中元素、焦点、inert 和几何信息。快照只在失败时读 DOM；每帧只记录现有检查得到的原因。不给页面附加监听器，不增加等待或自动重试。
- `scripts/native-ui-pointer.test.mjs`：新增“有限动画持续到原期限”和“目标不存在”两项测试，证明超时仍拒绝并保留可读证据。用 fake timers，不引入真实 sleep。
- `scripts/overlays-ui-checks.mjs`：原 `activeElement === trigger` 比较不变；失败时附带实际焦点、预期触发器、inert、当前 surface 数量。没有放宽任何业务断言。

仍使用原 native pointer 命中检查、两帧稳定检查、有限动画检查及原期限。诊断未采集页面正文、用户会话、截图或凭据。本轮没有修改 App/CLI 生产代码、性能 collector、基线或门禁。

## 实际验证

mac2：Apple M1 8核，darwin-arm64，Node24.18.0，Electron42.10.1。依赖锁 SHA 和 Node/Electron SQLite ABI 见[机器证据](20261026-integration-r2-evidence.json)。共用本任务自己的依赖目录；unit 前换 Node137 binding，结束后恢复 Electron146，没有触碰宿主其他项目。

| 检查 | 本轮结果 | 命令/证据 |
|---|---|---|
| recorder + 新诊断定向 | 3文件39通过；通知重试16项全部通过 | `npm run test:unit -- scripts/native-ui-pointer.test.mjs scripts/desktop-remote-ui-smoke.test.ts src/core/turn-recorder/commit-delivery.test.ts` |
| 全量unit | 359文件，4089通过、4原有 opt-in skip、0失败 | `npm run test:unit -- --maxWorkers=2 --no-file-parallelism --reporter=json --outputFile=.../unit.json` |
| 类型 | 通过 | `npm run typecheck` |
| CLI产物 | 通过 | `npm run build:cli` |
| 全量UI | 一次完整原27命令链 exit0；不是分段拼接 | `npm run test:renderer:ui` |
| 性能 | 门禁通过，74项观测/77项登记 | `npm run performance:measure -- --compare e1b120cc --out .../full-compare` |
| 最终差异 | 正常20KB完整暂存文件门禁、diff检查通过 | 无豁免或强制提交 |

全量unit保持文件串行；`maxWorkers=2`只是上限，没有改仓库 Vitest/CI 配置。4项真实探针默认关闭，未新增 skip。全量UI包含 Credits、四个独立 DesktopRemote 场景、真实临时 Git 的 production App、会话所有权及统一会话真实 IPC、Pi 历史恢复。Provider 由临时 fixture 控制，无真实付费调用。

本轮 UI 没有发生前轮的焦点/命中失败。新诊断由两项 unit 故障场景验证；没有把一次正向 UI 通过当成“真实现场失败快照已采到”。之前的失败日志原样保留。

### 时钟记录不等于 App 提速

| 锁范围 | wall ms | 负载前→后/8核 | 用途 |
|---|---:|---|---|
| unit + type + CLI build | 759549 | 3.80→11.22，highLoad=true | 断言有效，耗时不作性能结论 |
| 原完整UI命令链 | 382028 | 7.27→2.88，highLoad=false | 仅检查总耗时，不是交互/启动基准 |
| 全量工作计数比较 | 86528 | 2.30→3.59，highLoad=false | 本轮只解释L1，不算新的L2实验 |

## 性能收益在新组合中保留

同机、相同冻结 collector 比较已提交开发代码 `e1b120cc` 与测试 tree `8d0a951b`，每项5次。工具显示两边均为 `e1b120cc-dirty`，因为 baseline 也注入冻结的测量文件；这不表示两边生产源码相同。权威身份是上述提交、补丁及完整 tree。

| 固定负载指标 | 开发基线→组合 |
|---|---:|
| 无消费者统计：SQL | 130→0 |
| 已有内容复用：SHA256调用 | 64→32 |
| 双权威新内容：目录metadata调用 | 167→85 |
| 双权威新内容：sync调用 | 116→88 |
| 远程末尾更新：投影旧前缀读取 | 100020→0 |
| 同一更新的数组复制读取 | 100000→100000（未隐藏） |

减少的工作仍是取消无消费者查询、避免重复SHA、合并已批准的同事件公共祖先同步、复用已有变更来源信息；没有移到后台或计时窗口外。冷/双写 workload 的旧 `sync=unchanged` 字段沿用历史签名，不代表同步次数没变；批准范围与实际持久化边界见[双权威实验](20261026-content-copies.md)。

唯一正向计数差是 cold 内容 `stat` 36→44，属于早先“先stat以避免失败mkdir”的已披露取舍，不是本轮新回归。其 metadata 总量80→52、sync56→56。

历史台账仍有3个 candidate worse：readdir20 vs18、archive IPC10558 vs10536、cold stat44 vs36。当前同源码对照前两项均未增加；本轮不抬基线、删指标或升门禁。3个 CPU instruction candidate 在普通 collector 中缺失，未启用该 profile；不是0。文件 payload bytes 基线1397920→组合1397912，带文件戳波动，不归因于优化。

## 产物、未验证与交付状态

构建 App 版本仍0.2.221，build `76b16fc2f2e4628d738ba63c13bb89e31ed5483a6e09a9f2020ca6b63de156e7`。这是本轮隔离验证产物，未打包、未安装。没有重启用户正在使用的App，没有新增L3。Node20/22、Linux、真实Provider和发布gate本轮未执行。

本机证据目录：`~/.local/state/scry-performance-resume-20261026.3YkqtM/results/`，当前日志在 `remote/`，旧失败完整拷贝在 `previous-integration/`。mac2仍保留 `scry-performance-climb-mac2.cO3N5W/logs/integration-r2/` 和旧 `logs/integration/`。记录包含原始unit/UI日志、退出码、性能两侧观测、比较、ratchet、源码及build SHA。末次 scoped cwd扫描没有本任务目录下的存活进程；不据此声称所有逃逸后代均已证明关闭。临时 fixture、依赖和工作树保留用于复盘。

- 已提交诊断与独立集成。没有修改原 `reliability/collection` 分支或工作区；不把独立 merge 当作正式合入。
- 旧两项 UI 偶发问题仍由agent负责：若正常验收再次失败，先读取本次新增快照定位，不调超时或重跑到绿。
- **下一步需要用户决定**：是否把已验证独立分支快进合入原开发分支。安装和push不包含在该动作内，需要明确授权。
