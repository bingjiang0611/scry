# M0 后台完整 App 离线验收 · 2026-10-21

## 范围与身份

本轮验证生产 App → preload → trusted IPC → canonical `startAppRun` → Pi adapter → recorder/archive 的集成。模型端是固定本地假 CLI，不是实际模型，不替代[既有真实 Pi/Codex 验收](m0-real-acceptance.md)、前台人工操作或五 Provider 真实矩阵。

- 用户先允许独立前台 App，随后明确改为后台操作；最终使用隐藏完整 App，不是隔离 UI 的假 bridge。按钮与文本通过 CDP 输入；select 明确使用 DOM input/change，不冒充 OS 原生选择键盘验收。没有 `--no-sandbox`、关闭 context isolation 或焦点抢占。
- 独立 HOME/userData、唯一临时 workspace：`/private/tmp/scry-m0-foreground.B7732l/home/projects/OFFLINE M0 workspace`。没有复制真实账号凭据、调用真实模型、安装、推送或重启用户 App。`full_access` 只获准用于这个项目和固定离线脚本；不扩展到其他 profile。
- 固定脚本 `offline-pi.cjs`，profile `pi:c8a56ad72d112911`，四角色均显式选择 `offline-fixture/deterministic`。所审计六个新 App session 都绑定该 profile；脚本指纹未变。不把发现列表中的真实 Pi/Rotom 当成执行授权。
- 修复后产物：`dist/mac-arm64/Scry.app`，App **0.2.210** / 私有 CLI **0.2.49**，`app.asar` SHA-256 **`13017f8ce75bbb35cf53f11c1b0cfc16185c4df994b804192c2fd18036d12a16`**。没有升版本或安装；相同版本号不代表用户 App 已更新。
- 构建时 Git 基线 `6179d37` 加本次未提交修改；不能把基线当运行源码。`packaged-scope.json` 保留两处生产源码 SHA-256、完整 diff hash 与 asar hash；本节验证绑定该产物，不泛化成旧真实模型探针已覆盖新代码。

## 首轮发现与因果修复

原离线脚本的完成消息没有 `usage`。官方 Pi `AssistantMessage` 要求该字段，因此这是异常字段注入，不是 Pi 正常完成协议的示例；但收到 usage 前被中断是合法情形。`reasoning` 则是可选字段，缺失不能算零。

首轮六条 canonical records 却都有 `available + exact` 的零 token：Pi 累计器初始化/缺省相加为零，recorder 又把仅有 terminal/model metadata 的结果算作可用 usage。这是独立于历史启动超时的证据缺失缺陷。

- `usage-before-control.json` 冻结原六条记录的 ID、内容摘要和 SHA-256；不回填、不覆盖、不重新解释成 SDK 真正报告的零。这六条是错误行为对照，不能用作可信用量样本。旧 archive 也保留原始观察。
- Pi 只累计实际上报的字段；未报告维度保持缺失。必需 token 维度覆盖不全标 `usageComplete:false`；中断同样不声称覆盖完整。reasoning 缺少任一相关消息时不声称完整累计；上下文样本不把缺失 cache/input 补零。
- Recorder 只有测量值才提供 usage；终态、模型身份和普通 wall duration 不构成 usage。明确上报的零仍是有效观测。没有改 cost 估算政策、旧记录、调度预算或权限语义。
- 定向负对照在修复前 **4 failed / 2 passed**；补齐合法可选 reasoning、早停与顺序混合场景后，最终新增 **9 项**定向检查通过。明确零值保留为正对照，不以全改 unavailable 蒙混过关。

## 修复后完整 App 结果

所有批准均通过实际 App 控件；没有直接调用 workflow approve/start API 代替 UI。规划与执行分别批准，批准执行前分别观察到单个 planner prompt、零执行尝试。

| 场景 | 实际结果 | 可读证据（以下均在证据目录） |
| --- | --- | --- |
| 并行完成 `workflow-a5380c13d78966dcaa8b3ec8d0b1d04c3bf5d83cd0e450f0288a045dc126d1a2` | worker/reviewer 并行，summary 接收已提交输入；3 attempts，peak slots 2 → 0，全部 settled | `fixed-happy-before-approval.json`、`fixed-happy-record.json`、`fixed-happy-progress.json`、`fixed-happy-completed.png` |
| 输出后停止 `workflow-d1adef850d523c52f4e25ee2ebc385fb0ed56a3ef8bb4f059c13cca2349d40c5` | 先在实际活动会话看到流式文本，再点击停止；1 attempt，`stopped + settled:true`，slots 0，final report unavailable | `fixed-stop-output-observed.json`、`fixed-stop-record.json`、`fixed-stop-output.png`、`fixed-stop-settled.png` |
| 提交产物与引用 | 3 个 output 文件的文本 SHA-256 与内容地址一致；summary 原生 prompt 包含两个上游产物；最终返回匹配第三个产物 | `fixed-committed-outputs.json`、`rpc.jsonl`、`fixed-happy-record.json` |
| 身份对应 | 新 6 prompts、6 原生 sessions、6 App session rows、6 canonical records、6 archives 一一对应；native user entry ID/body 与 record/trace 对应 | `audit-fixed.json`、`native-sessions/`、`userData/trace-archive-turns-v1/` |
| usage | 新六条均 `unavailable`，没有 fabricated token 值；CLI 单 session 的 tokens/cost 为 `null`、knownTurns 0；SQLite 六行的五类 token 和 cost 都为 `NULL` | `fixed-stop-cli-summary.json`、`fixed-sqlite-usage.json`、只读 `sqlite-fixed-snapshot/` |
| canonical 结构/健康 | `turns verify` 退出 0；doctor 12 records、pending 0、store errors `[]`。其中 6 条仍是不可改写的修复前对照 | `fixed-cli-verify.json`、`fixed-cli-doctor.json` |
| 同包重启只观察 | 修复后同一 asar 关闭再打开；四个历史 workflow 状态恢复；12 prompts 不变，12 条记录 SHA-256 不变，无新 dispatch | `before-fixed-reopen.json`、`fixed-reopen-no-replay.json`、`fixed-reopen-history.png` |

CLI 的 model identity、turn role、task link 仍各有 **12 个 `legacy_unset`** advisory。结构通过不是身份元数据已完整，也不是旧六条错误 usage 变成真实测量。成本没有计费证据，不报告“零费用”。

## 当前代码检查

各项有交集，不累计成互不重叠的测试数。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Pi + recorder + billing/span + result timing | **28 文件 / 545 passed**，包含 Pi 六文件 181 项 | `affected.log` |
| Workflow 当前代码 | **9 文件 / 64 passed** | `workflow-final.log` |
| `npm run check:cli-release` | **32 文件 / 589 passed**；CLI 构建与 package smoke healthy | `cli-release.log` |
| `npm run typecheck` | Node/web 通过 | `typecheck-final.log` |
| `npm run pack:artifact` | App 构建、产物 allowlist/体积校验、隔离安全/恢复/远程宿主 smoke 通过；没有安装 | `pack-artifact.log` |
| 加锁 `performance:measure -- --scenario trace.delivery` | ratchet 通过，5 次均 2 messages / 165996 bytes；`highLoad:true`，不作耗时提升结论 | `performance/measure.json`、`performance.log` |
| 一轮 `npm test` | **未通过、未完成**：600 秒工具截止，没有完整 unit 汇总，未进入 shell；已见下列 7 个失败，不循环整套重跑 | `full-test.log` |

整仓首轮失败来自未修改文件：`src/main/source-control/service.test.ts` 3 项（15 秒）、`src/main/git-terminal-pair.test.ts` 3 项（其中两项 20 秒，另一项为 undefined/string 断言错误），`scripts/performance-baseline.test.ts` 1 项（固定本地子进程没有返回预期 stdout/exit）。保留原始失败；检查后这些文件及其 Git/launcher 实现无本次 diff。结束时 load **59.83 / 10 核**，这不是根因证明；没有称它们一定是既有失败或与本次无关，没有改 timeout、断言、workload 或门限。维护 Agent 后续应单独定位这组失败，再补完整门禁，不能把本节分项通过当整仓绿灯。

## 现场与清理

- App/交互/跨证据目录：`/tmp/scry-m0-foreground.B7732l/`；代码负对照与门禁目录：`/tmp/scry-pi-usage-evidence.iU1MRc/`。本地路径便于复盘，不是上传或远程留存承诺。
- 原隔离 App **39141**、修复后打包 App **48660**、重开 App **46485** 均按 executable、userData 参数和启动时间重验后关闭；关闭前全为终态、slots 0，不拿 PID 消失代替 settlement。所有登记离线 CLI 启动 PID 的最终 `ps` 检查均无存活。只关闭自有进程，没有对 `/Applications/Scry.app` 发停止或启动命令；最初用户 App PID 69434 最终已不存在，不据此宣称它持续存活或推断退出原因。
- `fixed-final-close.json` 保留关闭证明、SQLite 快照及旧现场 16 个 source hash 未变。假 CLI 的 52 次 start 只对部分路径写 exit 日志；缺 exit 日志不等于存活，因此另做精确 PID 检查。旧轮登记归属不明的其他 fixture 不在这个“无存活”范围内。
- SQLite 首次对复制 DB 的普通 readonly 打开报 14；App 关闭后已无 WAL，改用 canonical `file:...?mode=ro&immutable=1` 读取快照成功。没有重启 App、重跑任务或写回来源 DB 来掩盖审计命令失败。
- 旧真实 Codex 的 **2 unknown reservations / 1 pending managed turn** 原样保留。不能拿当前离线通过、scope 关闭或可结构验证的记录，作为它的 whole-turn 完成证明；仍需原 Provider 权威终态，不清空、不退款、不重发。
- 本轮收口范围是缺失 usage 修复及后台离线集成。完整整仓门禁仍开着；前台人工与五 Provider 真账号矩阵、历史间歇启动失败归因及旧 unknown 的恢复没有由本轮替代。
