# Scry CLI 团队推广技术方案（v2）

本方案只讨论独立 CLI `@ali/scry-turn-recorder`（当前 `0.2.31`），不涉及 Scry 桌面 App 的 UI。
参考对象为内部遥测采集器 AITrace（借鉴其交付与运维工程实践，拒绝其全局隐式采集模型；实测细节见 §15 内部附录）。

> v2 修订说明：v1 把 `commitHook` 描述成「CLI 独立模式已可用的接缝」，这是错的（见 §5.0 与 §14 修订表）。v2 把「CLI 侧激活 + 指纹授权」列为核心决策的必要条件，并修正 12 处与代码不符的表述。

## 0. 已定决策

**CLI 不引入任何数据上报出网能力。** 团队汇总只通过 `commitHook` 进程边界完成，Uploader 作为**独立包**发布、独立版本、独立评审。

因此：

- Recorder Core（`src/core/turn-recorder/`）不引入任何远端 HTTP 客户端。
- CLI 不新增 `sync` 命令、不新增 endpoint/token 配置。
- 精确表述：**CLI 不做任何数据上报出网**；仅保留已存在的、显式 opt-in 的版本检查出网（`npm view`，需 `SCRY_AUTO_UPDATE=1` + TTY + 非 CI，`src/cli/update.ts:107-160`）。

### 决策的两个必要条件（v2 新增，不可降级为可选增强）

1. **CLI 侧 fail-closed 指纹授权门**：`commitHook` 是「以本机用户权限执行仓库控制的可执行文件」的授权点。今天只有 Scry App 有这个门（`src/main/commit-hook-trust.ts:312`）。CLI 独立模式必须自建，否则本方案的安全论证不成立（详见 §5.0、B1）。
2. **CLI 侧只读投影命令**：由被评审的 CLI 代码负责脱敏投影，Uploader 默认只消费投影结果、不需要 `.scry/records` 读权限（详见 §7 W7a）。

若这两条不做，则应改为明确写死「团队汇总仅支持 Scry App 宿主，CLI 独立模式不提供」，并重新评估推广价值。**不允许含糊。**

代价必须说清：Uploader 独立后，团队接入是两步（CLI + Uploader + 一次授权），推广摩擦高于一体化 `sync`；这是刻意选择的取舍，理由见 §13。

## 1. 目标与非目标

### 目标

1. 其他团队能在 10 分钟内在自己的 Git 仓库接入，并能自证「真的采到了」。
2. 出问题可自助诊断、可修复、可干净卸载。
3. 需要团队汇总时，有 fail-closed 授权门 + 稳定合同 + 官方 Uploader 参考实现。
4. 环境可复现：CLI 版本、Node 版本、Provider 版本、record schema、commitHook protocol 可对齐。

### 非目标

1. 不做用户级全局 transcript 扫描（AITrace 的做法）。
2. 不做常驻中央进程与跨项目明文大库。
3. CLI 不做任何数据上报出网。
4. 不追求 Provider 数量对标 AITrace。

### 必须保留的既有边界

- 缺 `scry.config.json` 时 fail closed（`config.ts:137,154`，reason `missing_config`）。
- `.scry/` 目录 `0700`，record 原子写 `0600`（`io.ts:14-28`）。
- 一轮一个 append-only JSON，全局 sequence 严格递增且 `verifyStore` 要求无洞（`store.ts:110-127,355-372`）。
- `unavailable` / `partial` / `disabled` 不得伪装成 `0` 或空数组。

## 2. 现状差距（推广视角）

| 差距 | 现状 | 影响 |
|---|---|---|
| **commitHook 无 CLI 激活路径** | 仅 App 写运行期 env（`main/commit-hook-trust.ts:312`）；README 明确「CLI/daemon 不会自动信任 workspace 配置」（README.md:65） | 团队汇总在独立模式下**根本跑不起来** |
| 安装依赖用户环境 | Node ≥ 20，`os: [darwin, linux]` | Windows 团队阻塞；nvm/PATH 问题多 |
| 成功判定不直观 | `doctor` + `turns list` 人工判断 | 用户误以为 `init` 成功即采集成功 |
| Codex 需手动 `/hooks` 信任 | CLI 无法代替，也无法观测 | 静默无记录 |
| 配置漂移无检测 | hook 识别靠 command 字符串**全等**（`workspace-init.ts:176`） | 命令形状一变就重复追加 hook |
| 无历史导入 | 只记录接入后的轮次 | 试用当天数据稀疏 |
| records 无保留策略 | 全仓库无 prune/retention；`listRecords`/`verifyStore`/drain 均全量扫描（`store.ts:69,337,355`） | 长跑仓库磁盘与 hook 延迟同时增长；手删记录会触发 `sequence gap` |
| 支持成本高 | 无标准诊断包 | 跨团队排障靠人肉 |

## 3. 借鉴 AITrace 的能力清单

| AITrace 能力 | 借鉴结论 | 落到 Scry CLI |
|---|---|---|
| bundled runtime + manifest / SBOM / hash | **降级为仅借鉴 manifest**（见 §9 W10） | 发布物附 manifest；不做第三条分发通道 |
| 逐 Provider 状态展示 | 借鉴并细化 | `scry status` 多阶段矩阵（P0） |
| Hook 幂等注册、保留原有 hook | 借鉴，需新增识别层 | `integrations diff / uninstall`（P0） |
| transcript offset cursor / 去重 / backfill | 借鉴，改为显式触发 | `scry import --dry-run`（P1，需先定记录归属） |
| outbox + retry + oversized 终止 | 借鉴到 **Uploader**，不进 CLI | 独立包（P1） |
| 指纹授权后执行冻结副本 | **借鉴（关键）** | `scry commit-hook trust`（P0 前置） |
| 逐数据类型开关 | 借鉴并强化语义 | `capture` preset + `policyVersion`（P1） |
| 全局自动采集与默认上报 | **不借鉴** | workspace opt-in、CLI 无上报出网 |
| 跨项目中央明文大库 | **不借鉴** | workspace 分区 + `0600` |
| 「目录排除」只作用于部分链路 | **不借鉴** | 若做 exclude，必须全链路生效并可验证 |

## 4. 目标架构

```text
scry CLI
  → 命令层 (src/cli)
  → Recorder Core (src/core/turn-recorder)   ← 无远端网络
      ├─ Provider hook / Pi lifecycle 扩展
      ├─ workspace daemon over unix socket
      │    .scry/recorder-v1.sock
      │    路径 >100B 时回落 $TMPDIR/scry-<uid>-<hash>.sock
      │    可被 SCRY_RECORDER_SOCKET 覆盖   (daemon.ts:124-137)
      └─ <workspace>/.scry/records/*.json    ← canonical
  → commitHook 边界（需 CLI 侧指纹授权后才激活）
      → @ali/scry-uploader (独立包)
          ← 默认只消费 `scry turns project` 的投影输出
          → 团队服务
```

## 5. commitHook 合同

### 5.0 现状定性（v2 修正）

- `config.ts:63-78` 只**校验** `commitHook.entry/files`（相对路径、entry 必须在 files 清单内、不得逃逸 workspace），**不会**把它变成运行期入口。
- `store.ts:154` 只认环境变量 `SCRY_RECORDER_COMMIT_HOOK`（绝对路径 + 可执行位）。
- 全仓库唯一写入方是 App 的 `src/main/commit-hook-trust.ts:312`（指纹批准后执行冻结副本）。
- `.scry/provider-hook.sh`（`workspace-init.ts:129-146`）不导出该变量。

**结论：CLI 独立模式当前无激活路径。** 用户理论上可在 shell profile 里手工 export，但那既不可推广，也绕过了「仓库控制的 executable 必须 canonicalize + fingerprint + 执行前重验、fail closed」的约束。

### 5.1 v1 协议（stdin 通知，冻结）

```json
{
  "schemaVersion": 1,
  "event": "record-committed",
  "workspace": "/abs/workspace/root",
  "provider": "codex",
  "sessionId": "…",
  "recordId": "…",
  "sequence": 42
}
```

调用与判负（`store.ts:141-212`）：

- `spawn(hook, [], { stdio: ['pipe','ignore','ignore'] })`，env 按白名单裁剪（`store.ts:31-46`，含 `HOME`/`PATH`/`XDG_*`/`SCRY_*`）。
- 超时 10s（`store.ts:29`）→ SIGTERM → 1s 后 SIGKILL。
- **判成功仅当 exit 0**；stdin 写失败、超时、spawn error 一律判未 ACK。
- ACK 后原子写 `.scry/notifications/commit-hook-state.json`（`schemaVersion`/`hookFingerprint`/`ackedThrough`）；失败即停止本轮、保留未 ACK 的剩余记录，不跳号。
- 并发：`.scry/locks/commit-notification.lock`，`waitMs` 默认 2s（`io.ts:163`）。

### 5.2 交付语义：at-least-once（v2 新增，必须进合同）

重复投递有三条真实来源：

1. `redeliverLatestCommitNotification`（`store.ts:270-305`，被 `main/commit-hook-startup.ts:42` 调用）重投最新一条且**不推进** `ackedThrough`。
2. `SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT` 变化 → `ackedThrough` 归零 → 全量重放（`store.ts:236-240`）。
3. hook 已 exit 0 但 `writeJsonAtomic(statePath)`（`store.ts:251`）前崩溃 → 该条必然重投。

实测确认（P0-0 验证）：篡改 entry 后重新授权，`ackedThrough` 归零并把 1–4 全部重放，实际投递行数为 2 + 4 = 6。**这不是 bug，是必须写进合同的语义。**

**合同措辞**：交付语义为 at-least-once；去重键为 `(workspace, recordId)`；`sequence` 只保证同 workspace 内单调，**不**保证「恰好投递一次」。Uploader 必须按 `recordId` 唯一约束 + 幂等 upsert。

### 5.3 drain 预算 — ✅ 已实现

现状风险链：`recorder.ts:2113` 在**每个** hook 事件后同步 `await drainCommitNotifications` → `store.ts:241` 对全部 pending **串行**调用，每条上限 10s → 单次 drain 最坏 `pending × 10s`，无上限。而 daemon 客户端超时仅 1s / 4s（`scry.ts:127`），超时后走「直接处理」回退分支再触发第二次 drain，撞 `commit-notification.lock`（2s）→ 锁超时、日志报错、计数抖动；Provider 侧 hook timeout 只有 10 / 15s（`workspace-init.ts:180`），慢 Uploader 会把用户 Agent 的 Stop hook 拖到被 Provider 杀掉。

已落实：

- `HOOK_DRAIN_MAX_RECORDS = 8`、`HOOK_DRAIN_BUDGET_MS = 1500`（`store.ts`），仅 hook 事件路径（`recorder.ts`）传入；`recorder recover` 与 `recorder notify-drain` 保持无界。
- 预算只在两条记录**之间**检查，所以 `COMMIT_HOOK_TIMEOUT_MS`（10s）仍是单条熔断上限，不是批预算；时间预算下仍保证至少投递一条，避免永不前进。
- `DrainResult` 新增 `truncated`（进程内证据，`notify-drain` 输出携带）；hook 失败**不**标记为截断，便于区分停滞原因。
- 不为截断另存持久状态：`status` 的 `notifyBacklog` 已如实给出积压条数，失败原因写 `recorder.log`。消融实验删掉了原先的 `drain-status.json`（每个 hook 事件多一次读、且与 backlog 语义重叠）。
- Uploader 的 exit 0 目标延迟 ≤ 200ms（合同要求，不由 CLI 强制）。

实测（`SCRY_RECORDER_TRANSPORT=direct` 隔离单次 drain，10 条积压）：一个 hook 事件只投递 8 条，`ackedThrough: 8`、`notifyBacklog: 2`、`lastDrainTruncated: true`；下一事件接着投递；`notify-drain` 清空剩余并把 `lastDrainTruncated` 回落。

实测发现并已确认为预期：daemon 冷启动时的 recovery 会做一次**无界** drain。它不在 hook 同步路径上（`waitForReady: false`），不影响 Provider hook 超时，但会让“一个轮次看上去投递了全部积压”；诊断时应以 `direct` 传输隔离。

### 5.4 信任边界（诚实表述）

通知本身不含 record 正文，但 entry 可按 `workspace + recordId` 读取全部 `.scry/records`（prompt、回复、工具输出、文件路径、patch 都在里面）。

> commitHook 是「以本机用户权限执行外部程序并授予其读取全部本地记录的能力」的授权点，不是脱敏机制。

缓解顺序（强 → 弱）：`turns project` 只读投影（Uploader 无需读 records）> CLI 指纹授权门 > 代码评审约定。**不能只靠最后一条。**

## 6. 命令面

```bash
# P0（前置）
scry commit-hook trust [--yes] [--show]     # 指纹授权 + 激活；fail closed
scry commit-hook status [--json]

# P0
scry status [--json]
scry verify-capture [--timeout 120]
scry integrations diff
scry integrations uninstall [--yes]
scry recorder notify-drain [--json]
# doctor：重构为稳定 JSON schema，保留现有退出码 0/2/3/4/5

# P1
scry turns project <recordId> --policy team-metadata@1   # 只读投影，无网络
scry integrations repair [--yes]
scry import <provider> --since 7d [--dry-run]
scry capture show | explain <field>
scry support-bundle create [--out <path>]
scry records archive --before <date>                     # 保留策略

# P2
Windows 支持 / 兼容矩阵
```

## 7. 工作项

### P0-0（前置）`scry commit-hook trust` — ✅ 已实现

实现位置：`src/core/turn-recorder/commit-hook-grant.ts`（授权与激活）、`src/cli/scry.ts`（`commit-hook status|trust|revoke`）、`src/core/turn-recorder/recorder.ts`（drain 前解析激活，非 trusted 一律 fail closed 并写 `recorder.log`）、`src/core/turn-recorder/store.ts`（`commitNotificationStatus`）。

实测（临时仓库，`SCRY_GRANT_DIR` 隔离）：未授权时完成一轮 → entry **未执行**、record 保留、`status` 退出 3 且 `notifyBacklog: null`；`trust --yes` 后新一轮 → 积压的第 1 条与新的第 2 条一起投递、`ackedThrough: 2`；篡改 entry 后 → `fingerprint-mismatch`、退出 4、新轮次不投递、篡改脚本从未运行、日志留下原因；重新 `trust --yes` → 恢复投递。


- 计算 `entry` + `files` 全清单的内容 hash（可含 inode/size），生成 `fingerprint`。
- 授权记录落**仓库外**可信位置（如 `~/.scry/grants/<workspace-hash>.json`，`0600`），内容为 canonical workspace 路径 + entry 绝对路径 + fingerprint + 批准时间。
- `provider-hook.sh` / daemon 启动时读取授权记录并 export `SCRY_RECORDER_COMMIT_HOOK` / `..._FINGERPRINT`；**执行前重新校验指纹**，不匹配一律 fail closed。
- `status` 对应状态：`not-configured` / `configured_but_not_activated` / `trusted` / `blocked:fingerprint-mismatch`。
- 不做这项，P0 与「团队推广」目标无关。

### W1 `scry status` — ✅ 已实现

实现：`src/cli/status.ts`（报告组装）、`src/core/turn-recorder/provider-activity.ts`（`HookSeen` 证据，`{ sync: false }` + 全程 fail open）、`src/cli/workspace-init.ts`（`detectWorkspaceProviders` / `providerHookInstalled` 按 `SCRY_HANDLER_ID` 识别）。退出码：0 至少一个 Provider 在 capturing，2 recorder 未启用或无任何已配置 Provider，3 已配置但无事件/无 record。

实测输出形状（新仓库，仅 `init --providers claude`）：claude `configured: workspace` / `state: configured-no-events`，其他 `not-configured`，全部 `trusted: unknown`；采到一轮后 claude 转 `capturing` 且 `recordSeen.sequence: 1`。

新增 `src/cli/status.ts`，逐 Provider 输出，任一阶段不可知必须显式 `unknown`：

```text
Provider  Detected  Configured  Trusted  HookSeen  RecordSeen  Health
claude    yes       yes         unknown  2m ago    2m ago      ok
codex     yes       yes         unknown  never     never       blocked:hook-not-trusted
qoder     no        no          unknown  -         -           not-detected
opencode  no        no          unknown  -         -           not-detected
pi        yes       global      unknown  1m ago    1m ago      ok
```

- **`Trusted` 一律 `unknown` + `omissionReason`**：CLI 侧唯一 trust 信号是常量 `codexTrustRequired`（`workspace-init.ts:395`），填 `n/a` 等于宣称「该 Provider 不需要信任」，属于伪造证据。
- **Pi 单列为 `global`**：目标是 `~/.pi/agent/extensions/scry-recorder.ts` + `settings.json`（`pi-integration.ts:37`），且 `init --providers pi` 被显式拒绝（`workspace-init.ts:70-73`）。
- `HookSeen` 数据源：新增 `.scry/state/provider-activity.json`，**必须 `writeJsonAtomic(..., { sync: false })`**（默认 `sync: true` 会 fsync 文件 + 父目录，`io.ts:20-28`；热路径写入均已显式关闭，如 `recorder.ts:2073`）；或直接从 records / `runtime/<provider>/` 派生，仅为「hook 到了但没出 record」新增最小状态。
- commitHook 段字段命名必须与 recorder health 区分：`openTurnsPending`（`RecorderHealth.pendingCount`，未收敛 open turn，`store.ts:16`）vs `notifyBacklog`（未 ACK 记录数）。
- **禁止把「未激活」显示为「无积压」**：未激活时 drain 返回 `{0,0}`（`store.ts:229`），必须显示 `configured_but_not_activated`，不能显示 `notifyBacklog: 0`。

### W2 `scry verify-capture` — ✅ 已实现

实现：`src/cli/verify-capture.ts`。原因码（每个都对应一个真实可达状态，均有用例）：

| 原因码 | 含义 | 退出码 |
|---|---|---|
| `ok` | 等待期间提交了**新** record | 0 |
| `missing_config` | 无 `scry.config.json` 或非法配置 | 2 |
| `disabled` | sentinel / env / `enabled:false` | 2 |
| `pending_open_turn` | hook 已到达，轮次还在进行或待恢复 | 3 |
| `events_without_record` | 等待期间有事件，无 in-flight 也无新 record | 3 |
| `no_hook_event` | 等待期间无事件（detail 区分“从未到达过”与“以前到过”） | 3 |

与 v2 计划的差异及理由：

- **删掉 `daemon_unavailable`**：daemon 未运行不是采集失败——冷启动会先直接落盘再拉起后台进程。把它当失败会误导接入方。daemon 状态降为 evidence 字段。
- **新增 `events_without_record`**：真实可达（事件被 ignore / dropped / orphan），不能塞进 `pending_open_turn` 假装成“马上就好”。
- **区分两个 pending 信号**：`RecorderHealth.pendingCount`（`runtime-state.ts:77`）只统计 managed / closing / quarantined 的**待恢复**轮次，不包含正在进行的轮次。因此 evidence 同时给 `openTurnInFlight`（复用 `recorderHasOpenTurn`）与 `openTurnsPending`，两者不可互相代替。
- **只承认新 record**：以启动时的 `snapshotMaxSequence` 为基线，历史记录不能冒充本次证据。
- **结果为 `ok` 也要逐段报证据状态**：`record.evidence` 输出 `status/quality`，避免绿色掩盖 `unavailable`。

实测四种路径（packaged CLI，`direct` 传输）：未采过 → `no_hook_event`；只发 `UserPromptSubmit` → `pending_open_turn` 且 `openTurnInFlight: true` / `openTurnsPending: 0`；等待中补上 `Stop` → `ok`、`waitedMs 2033`、`record seq 1`，且 `assistant`/`tools`/`usage` 等诚实报 `unavailable`；事件在等待前发生 → `no_hook_event` 且 detail 写明“previously seen from claude”。

删除 v1 的 `record_without_terminal_status`：committed record 的 `status` 是封闭 union 且被 `isAgentTurnRecord` 强校验（`turn-record.ts:196`），该状态不存在。

### W3 `integrations diff` / `uninstall` — ✅ 已实现（`repair` 仍在 P1）

实现：`src/cli/workspace-init.ts` 的 `integrationsDiff` / `integrationsUninstall`（与 init 共用路径、`HANDLER_ID`、`writeAtomic`）+ `src/cli/scry.ts` 分发。`diff` 退出 3 表示检出漂移（重复或部分事件缺失）；`uninstall` 不带 `--yes` 退出 3 且零副作用。重写 Provider 配置时**保留原文件权限**（`stat` 后回写），不强制 0600。

实测：在 `.claude/settings.local.json` 的 `Stop` 里手写一条 `echo my-own-hook`，`uninstall --yes` 后该条**原样保留**，只含我们条目的 group 被删、空事件 key 被移除；`provider-hook.sh` / `cli-path` / `node-bin-dir` 删除；records、`scry.config.json`、`.git/info/exclude` 保留并逐条给出理由；坡 JSON 与非托管 OpenCode 插件进 `skipped` 而不被修改。卸载后 `status` 退 2、`verify-capture` 退 3。

原计划要点：

- **必须新增按 handler id 的识别层**。`HANDLER_ID` 只作为字符串出现在 `hookCommand()` 生成的命令里（`workspace-init.ts:147-150`），Claude/Codex/Qoder 的 JSON 无 marker 块，判「已安装」用 command **全等**（`workspace-init.ts:176-186`）。命令形状一变（换 flag、换 `PROJECT_DIR` 变量、上 Windows）就会追加第二条 hook；`scripts/cli-package-smoke.mjs:63-66` 正是用出现次数断言幂等。
- 识别规则：命中 `SCRY_HANDLER_ID=turn-recorder-v1` 即视为托管条目；group 内混有用户 hook 时只删 scry 条目，group 空了才删 group。
- `uninstall` 覆盖面必须完整：Provider hook 条目、OpenCode 插件（含 marker，`workspace-init.ts:349`）、`.scry/provider-hook.sh`、`.scry/cli-path`、`.scry/node-bin-dir`、`.git/info/exclude` 条目（`workspace-init.ts:335-341`）、Pi **全局** extension 的处理说明；并打印保留了什么（records 保留）。
- `diff` 零副作用。

### W4 `doctor` 稳定 schema — ✅ 已实现

- 输出新增 `schemaVersion: 1`、`status: healthy|degraded|corrupt|unavailable`、`checks[] {id, status, detail, remediation?}`；check id 固定为 `recorder.enabled` / `store.integrity` / `turns.pending` / `recorder.lastError`，已有用例断言顺序。
- **退出码作为冻结合同保留**：0 healthy、2 disabled、3 missing/invalid config、4 store corrupt、5 degraded，每个都有回归用例。
- `--json` 仍是已注册但无意义的 flag（输出本来就是 JSON），未新增行为。

### W5 `notify-drain`

显式触发 drain，输出 `delivered` / `notifyBacklog` / `truncatedByBudget` / `lastError`。Uploader 联调必需。

### （已删除）`init --preset team`

v1 的 team preset 等价于默认值：`toolOutput` 默认已是 `summary`、`diff` 默认 `true`、`patchExcludeBasenames` 默认 `[]`（`config.ts:96-103`，`workspace-init.ts:118-127`），且 `toolOutput` 只有 `none|summary` 两档。**空动作，从 P0 删除。**

团队场景真正需要的是**更少**采集（`prompt:false` / `assistant:false`，正文不落盘），配合 §7 W7a 的投影；等 preset 有真实语义再做（P1，见 W8）。

### P1

**W7a `scry turns project` — ✅ 已实现（P1 首位，已完成）**

- 只读、无网络。输入 `recordId` + `--policy <id>`，输出 metadata-only 白名单 JSON。
- 让 Uploader 默认只消费投影，不需要 `.scry/records` 读权限——把「脱敏」放进被评审的 CLI 代码，而不是每个团队的脚本里。
- 解决 v1 §0 与 §7 W7 的自相矛盾（一边说投影语义不进 CLI 合同，一边又规定白名单）。

实现：`src/cli/turns-project.ts`（policy 注册表 + 投影）、`scry turns project <selector> [--policy team-metadata@1]`。未知 policy 直接报错，记录不存在退出 1。

实测（uploader 只调 `turns project`、不读 records）：原始 record 内确实含 `CONFIDENTIAL-PROMPT-TEXT` 与 `CONFIDENTIAL-OUTPUT`，而 uploader 实际发出的 payload 对 prompt 正文、工具输出、`/etc/hosts`、`sudo cat` 命令原文、workspace 路径五项检查全部 clean；`usage` 为 `null` 且 `evidence.usage = unavailable/unavailable`（不写成 0）；危险操作只有 `{level: danger, reason: "sudo 提权", tool: "Bash"}`。

字段白名单由用例锁定（键集合精确断言 + 禁止字段不出现断言），改动白名单必须同时改测试。

**W7b `@ali/scry-uploader`（独立包）**

- 作为已授权 entry 被调用：读 stdin 通知 → 调 `scry turns project` → 落 outbox → exit 0（目标 ≤ 200ms）。
- 默认投影字段（policy `team-metadata@1`）：

```json
{
  "schemaVersion": 1,
  "workspaceIdHash": "sha256:…",
  "provider": { "id": "codex", "model": "…" },
  "sessionId": "…", "recordId": "…", "sequence": 42,
  "startedAt": "…", "durationMs": 0, "status": "completed",
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "reasoningTokens": 0, "costUsd": 0 },
  "modelTiming": { "cumulativeMs": 0, "occupiedMs": 0 },
  "counts": { "tools": 0, "skills": 0, "mcps": 0, "agents": 0, "hookInstances": 0 },
  "interventions": { "count": 0, "waitMs": 0 },
  "dangerousOperations": [{ "level": "high", "reason": "…" }],
  "diffStats": { "filesChanged": 0, "added": 0, "removed": 0 },
  "evidence": { "tools": "available/exact", "hooks": "unavailable" },
  "policyVersion": "team-metadata@1"
}
```

- **`workspaceId` 必须哈希化**：默认取目录名（`workspace-init.ts:114`），原样上传即泄露项目名。
- 禁止上传：prompt、prompt hash（可字典反推）、assistant 文本、thinking、tool input/output、文件路径、patch、repo remote URL、env 值。
- 可靠性：按 `recordId` 幂等 upsert、durable outbox、指数退避、oversized 明确终止、401 使凭据失效、HTTPS-only、`--dry-run` 打印完整 payload。

**W8 `capture` 真实 preset + `policyVersion`**

- 新增 `capture.preset`（含 `prompt:false`/`assistant:false` 的团队档），record 落 `policyVersion`；旧记录缺该字段按 `unavailable` 处理。
- record 级目前没有 provenance 字段，只有每个 Evidence 的 `source: string[]`（`turn-record.ts:20`）——新增字段需同步 `isAgentTurnRecord`。

**W9 `import`（需先定记录归属）**

必须先回答三个问题，否则不许开工：

1. 写哪里——`records/` 会破坏 sequence 与时间序的对应，且 `verifyStore` 要求连续无洞（`store.ts:355-372`）。建议独立 `records-imported/`。
2. 是否参与 drain——若参与，一条命令就会把几周历史推给 Uploader。默认**不参与**。
3. provenance 如何表达——需新增 `recordKind`/`origin` 并同步类型守卫。

其余：只读、per-file cursor + 记录级 hash 去重、`--dry-run` 先打印扫描面与将被标 `partial/inferred` 的字段、绝不默认递归 home。

**W10 容量文档与归档 — ✅ 已完成**

`scry records archive --before <30d|ISO>` 搬移连续前缀到 `archive/<cutoff>/`（含 sha256 manifest），并把 floor 写入 `archive-state.json`。

三条硬性约束（均有用例）：

1. `verifyStore` 只接受被 floor 解释的空洞；手动删除仍报 `sequence gap`。
2. **序号分配器必须跨过 floor**——实测发现的真实 bug：`commitRecord` 原先只按 `files.at(-1).sequence + 1` 取号，归档全部记录后会从 1 重新开始并与已发出的序号冲突。现取 `max(liveMax, archivedThrough) + 1`。
3. 配置了 commit hook 时拒绝归档未 ACK 的记录（退出 5），除非 `--force`。

原始要点：

- 全仓库无 retention/prune；`listRecords`/`verifyStore`/`turns list`/`doctor` 全量读，drain 每个 hook 事件 `readdir` 整个 records 目录（`store.ts:69,337,355`）。
- README 新增「容量与保留」，给**实测**数字而不是拍脑袋：无工具无 diff 的轮次约 2.9 KB；5 次 Edit + 5 个文件 diff 的轮次 6.6–9.9 KB（diff 约 5.4 KB、tools 约 2.2 KB）；按 8 KB/轮、100 轮/天估算约 20 MB/月。
- 已写明手删单个 record 会被 `doctor` 当作 store 损坏（退出 4），并给出目前唯一安全做法（先 `turns export`，再整体删 `records/` 与 `notifications/`，并提醒重放需幂等）。

**W11 `support-bundle`**

- 仅含版本、Provider 检测、配置指纹（非内容）、hook 状态、health 计数、record 数量与 schema 版本、`ackedThrough`/`notifyBacklog`、脱敏错误。
- **必须处理 `health.lastError` 与 recorder 日志中的绝对路径**（`io.ts` 滚动日志会写路径）。
- 明确断言不含 record 正文、文件路径列表、env 值。
- 同时定义送达渠道与脱敏复核责任人，否则它只是个本地文件。

### P2

**W12 发布 manifest（不做自带 runtime）**

CLI 发布物附：

```json
{
  "version": "0.x.y",
  "sourceCommit": "…",
  "buildHash": "…",
  "recordSchemaVersion": 1,
  "commitHookProtocol": 1,
  "supportedProviders": ["claude", "codex", "qoder", "opencode", "pi"]
}
```

**删除 v1 的自带 Node runtime**：会让分发通道变成三条（npm-global `upgrade` 走 `npmPrefixFromEntry`、App 内置 `SCRY_CLI_BUNDLED`、独立 `~/.scry/versions`），而 `~/.scry` 已被更新状态文件占用（`update.ts:56`）。改为文档给出 nvm/PATH 排障清单。

**W13 Windows**

`provider-hook.ps1` + 分平台 `hookCommand`；socket 换 named pipe 或强制 `SCRY_RECORDER_TRANSPORT=direct`。放开 `package.json` 的 `os` 前必须先有 Windows CI。

**W14 兼容矩阵**：CLI × Node(20/22/24) × Provider × `recordSchemaVersion` × `commitHookProtocol`。

## 8. 配置演进（向后兼容）

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "workspaceId": "my-workspace",
  "dataDir": ".scry",
  "repositories": { "mode": "discover-nested-git", "maxDepth": 2 },
  "capture": {
    "prompt": true, "assistant": true, "toolOutput": "summary",
    "diff": true, "hooks": true, "patchExcludeBasenames": []
  },
  "commitHook": { "entry": "tools/scry-uploader.sh", "files": ["tools/scry-uploader.sh"] }
}
```

- P0 不新增配置字段；激活状态存**仓库外**授权记录，不写进 `scry.config.json`（配置在仓库里，不能自我授权）。
- P1 新增 `capture.preset` 一项。
- 不新增 `sync` / `endpoint` / `credential`。
- 保留既有校验：`dataDir` 不得逃逸 workspace、不得经 symlink、`commitHook.entry` 必须在 `files` 清单内。

## 9. 安全与隐私评审要点

1. **CI 静态检查要瞄准真实模块**：Core 实际引入 `node:http`（`daemon.ts:4`，`createServer` + `httpRequest`），v1 却禁 `node:https`。规则应覆盖 `node:http` / `node:https` / `node:net` / `undici` / `axios` / `fetch`，对 `daemon.ts` 允许但**额外断言 `httpRequest` 调用必须带 `socketPath`**。
2. commitHook 授权必须 fail closed 且指纹变化重新确认（§7 P0-0）。
3. Uploader 默认不需要 records 读权限（§7 W7a）。
4. 新增日志只记 recordId、sequence、状态、错误分类、字节数、hash，不复制正文。
5. `import` 显式触发、`--dry-run` 先行、默认不参与 drain。
6. 若未来提供路径排除，必须同时作用于 prompt / tool / diff / import / 派生统计并可验证——不重复 AITrace「排除只挡部分链路」的语义歧义。
7. `support-bundle` 与 `--json` 输出需有「禁止字段不出现」的断言测试。

## 10. 测试与验收

```bash
npx vitest run src/cli src/core/turn-recorder
npm run typecheck
npm run check:cli-release
git diff --check
```

修改 `provider-hook.sh` 时追加 `npm run test:shell`。

重点用例：

- `commit-hook trust`：指纹不匹配 fail closed；授权记录不在仓库内；权限位 `0600`；`status` 显示 `blocked:fingerprint-mismatch`。
- `status`：`Trusted` 恒为 `unknown`；`configured_but_not_activated` 不显示为「无积压」；`openTurnsPending` 与 `notifyBacklog` 不混用。
- `verify-capture`：六个原因码各有用例；不使用固定 sleep，等待文件原子出现。
- `notify-drain` / drain 预算：hook 非零退出后 `ackedThrough` 不推进且不跳号；预算截断后剩余仍为 pending；重投最新一条**不推进游标**；指纹变化触发全量重放；超时被杀记未 ACK。
- `integrations diff/uninstall`：按 handler id 识别；命令形状变化后不重复追加；group 内混合 hook 只删 scry 条目；坏 JSON 拒绝且不落部分写；重复执行幂等。
- `turns project`：白名单序列化（断言禁止字段绝不出现）、`workspaceId` 已哈希。
- `doctor`：退出码 0/2/3/4/5 回归。
- Core 无远端网络：静态检查用例（含 `socketPath` 断言）。
- `provider-activity.json`：断言 `sync: false`。

Uploader 的退避、oversized、401、outbox 幂等测试属独立包。

## 11. 版本与发布

- CLI 命令/合同/集成/包内容变化 → 升 `packages/turn-recorder-cli/package.json`；**`RECORDER_VERSION`（`store.ts:8`）必须同步**，已有测试守护（`version.test.ts:14`）。
- **README 版本无门禁**（`cli-package-smoke.mjs` 只校验 bin 版本）→ 需在 `version.test.ts` 补一条 README `@x.y.z` 断言，否则「同步 README」这条规则必然漂移。
- App 侧未变更时不动根 `package.json`。
- 发布只用 `npm run publish:cli`（`prepublishOnly` 强制 `check:cli-release`）。
- **P0 发 `0.3.0` 会关闭 0.x 自动升级窗口**：`isCompatibleAutoUpdate`（`update.ts:87-92`）对 `0.x` 要求 minor 相同，存量 0.2.31 只会得到 `update_available`，需人工 `scry upgrade`（且 auto-update 本身需 `SCRY_AUTO_UPDATE=1` + TTY + 非 CI）。试点公告必须写明这一步。
- Uploader 独立版本，用 `commitHookProtocol` 声明兼容性。

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| commitHook 在独立模式无法激活 | §7 P0-0 指纹授权门；否则明确写死 App-host-only |
| drain 拖死 Provider hook | §5.3 有界 drain + 预算 + `truncatedByBudget` 可见 |
| Uploader 重复计费/重复统计 | §5.2 写明 at-least-once + `recordId` 幂等 |
| 任意 entry 读走全部正文 | §7 W7a 投影命令 + 指纹授权 + 官方 Uploader 默认 metadata-only |
| 用户以为「已同步」但实际未激活/积压 | `status` 显式区分 `not-configured` / `configured_but_not_activated` / `notifyBacklog` |
| hook 重复追加 | §7 W3 按 handler id 识别 + smoke 出现次数断言 |
| `import` 把历史一次发出去 | 默认不参与 drain + 独立目录 + `--dry-run` |
| records 无限增长、手删致 `sequence gap` | P0 文档化 + P1 `records archive` |
| 试点团队版本分裂 | §11 公告人工 `scry upgrade` |
| 有人把网络能力加回 CLI | §9.1 静态检查 + 本文件作为决策记录 |

## 12.5 P0 交付状态（2026-09-03）

| 工作项 | 状态 |
|---|---|
| P0-0 commit hook 指纹授权门 | ✅ `commit-hook status/trust/revoke` |
| §5.3 drain 预算 + at-least-once 合同 | ✅ 8 条 / 1.5s + `recorder notify-drain` |
| W1 `scry status` 六阶段矩阵 | ✅ |
| W2 `scry verify-capture` | ✅ 6 个原因码 |
| W3 `integrations diff` / `uninstall` | ✅ 按 handler id 识别 |
| W4 `doctor` 稳定 schema + 冻结退出码 | ✅ |
| W10 records 容量文档 | ✅ README「容量与保留」 |
| W7a `turns project` 只读投影（P1 首位） | ✅ `team-metadata@1` |
| W8 `capture` preset + record `capturePolicy` | ❌ 已删除（见 §12.6） |
| W9 `support-bundle` | ✅ 脱敏诊断包 |
| W10 `records archive` + 归档 floor | ✅ |
| `integrations repair` | ✅ 按 handler id 重写 |
| 官方 Uploader（独立包） | ⏸ 用户决定暂不做 |
| W6 `import` | ⏭ 未做（需先定记录归属） |

P0 未做版本升级：`0.2.31` 保持不变，等准备发布时一次性升 `0.3.0`（并按 §11 公告存量安装需人工 `scry upgrade`）。

## 12.6 已撤销：capture preset 与 capturePolicy

`team-minimal` preset、`CAPTURE_PRESETS` 注册表、`init --preset` 与记录上的 `capturePolicy` 字段已全部删除。撤销理由：

1. **零能力增益**：`{"prompt":false,"assistant":false,"toolOutput":"none"}` 本来就能配出完全相同的效果，preset 只是给这组值起名。
2. **命名夸大保护力**：实测确认（`recorder.ts:1674`、`aggregate.ts:70`）`toolOutput: 'none'` 只关工具**输出**摘要；工具**入参**、文件路径与 diff patch 仍会落盘。叫 `team-minimal` 会让接入方以为敏感内容已被移除。
3. **`capturePolicy` 是第二套同义状态**：证据模型已经用 `disabled` + `omissionReason: ... disabled by config` 区分「配置关掉」与「Provider 不支持（`unavailable`）」，再存一个策略字段属于重复。

保留 `scry capture show`：它输出解析后的生效值（含配置省略的默认），并明确说明关闭正文不覆盖工具入参与 diff。

若将来真要做「最小采集」，正确做法是在 `aggregate.ts` 增加 `capture.toolInput: 'none' | 'full'` 这一真实开关，而不是给现有值起别名。

## 12.7 采集延迟实测与 daemon 定位

`UserPromptSubmit` hook 在用户按下回车、等待 Agent 响应的那一刻同步执行,是唯一被用户直接等待的采集成本。实测(macOS,Apple silicon,git spawn 约 75ms):

| 阶段 | 优化前 | 优化后 |
|---|---|---|
| `beginGitTurnDiff` 干净仓库 | 553.6ms | **310.8ms** |
| 端到端 `UserPromptSubmit`(轻) | 1117.6ms | **870.8ms** |
| 端到端 `UserPromptSubmit`(重,50 MB transcript) | 1281.1ms | 1057.8ms |

优化内容:`beginGitTurnDiff` 原先用 4 次 `git rev-parse` 分别问 work-tree 探测、toplevel、common dir 与 index 路径,已合并为 1 次调用。bare 仓库在 `--show-toplevel` 上 exit 128 而不是返回 `false`,合并后统一降级为 `not_git`,并有回归测试固定该路径。

复现:`npm run build:cli && npm run bench:git-diff`(`scripts/git-turn-diff-bench.mjs`,只测 `begin`,不设阈值、不是门禁)。

### daemon 的真实定位

同一套基准对比 daemon 与 `SCRY_RECORDER_TRANSPORT=direct`:

- **单事件无收益**:差值 +5.6 / +0.9 / +38.4ms(`UserPromptSubmit`)与 −21.6 / −41.7 / +2.5ms(`Stop`),符号在不同负载档翻转,属噪声。结构上也符合预期 —— hook 脚本无论哪种模式都要启动一个 Node 进程,daemon 只是多一次 socket 往返,且 `daemon.ts` 调用的是同一个 `handleRecorderHook`,没有任何跨事件缓存。
- **并发有稳定收益**:每档重复 7 轮,2/4/8/16 并发下 daemon 分别快 27.3 / 48.4 / 53.3 / 119.2ms(14%–21%),多数档位 min/max 区间不重叠。机制是 `withDirectoryLock` 为文件系统锁 + 20ms 轮询,冷进程越多轮询周期越多,同时 N 个冷进程还会争 CPU。Provider 会并发触发多个工具 hook,该场景真实。

因此:**不为 shell hook 默认关闭 daemon**(会让真实并发场景退化 14%–21%);**也不为 daemon 增加仓库元信息缓存** —— 合并 `rev-parse` 之后可缓存的静态成本仅剩约 159ms(1 次 `rev-parse` + 1 次 `check-ignore`),而缓存失效判断错误会导致走错仓库根、证据错归属,风险与收益不成比例。

### 剩余成本重心已转移到 `Stop`

`finishGitTurnDiff` 随本轮改动文件数近似线性增长:0 个文件 586.5ms、5 个 1110.7ms、50 个 2718.8ms。但 `Stop` 不在用户等待路径上(回复已呈现),约束只是 Provider 的 10–15s hook 超时,当前仍有余量。继续优化需要动 diff 采集算法(增量 numstat、跳过 patch 生成),属于有回归风险、而收益用户不可感知的改动,暂不进行。

## 12.8 open turn 过期收敛

原有实现里,一个永远等不到终态的轮次会有三重后果:记录永久不产生、`doctor` 仍报 healthy(`pendingCount` 只统计 managed/closing/quarantined)、daemon 因 `recorderHasOpenTurn` 为真而无限重排空闲定时器。本机实测证据:一个 treehouse worktree 的 daemon 存活 **3 天 8 小时**,该 workspace 有 2 个 8 月 29 / 31 日的 `status: open`;另一个活跃 workspace 累积 **48 个**孤儿轮次。

现在的判定是**双判据**:轮次年龄超过 24 小时 **且** transcript mtime 也超过 24 小时未变。只看年龄会把跑了 30 小时的长任务误判为中断,而长任务会持续追加 transcript。无 transcript 的轮次只按年龄判定。

收敛结果:`status: 'interrupted'`,已观测证据段降级 `partial` 并给出原因,未观测段保持 `unavailable`。`recoverRecorder` 返回值新增 `expired` 计数(与 `recovered` 区分强制过期与正常恢复);`doctor` 新增 `turns.stale` 检查与 `staleOpenTurns[]`,命中时报 `degraded`(退出码 5,沿用既有语义,未新增退出码)。

实测(3 天前开启、无 transcript 的孤儿轮次):

```
doctor          exit=5  turns.stale: warn | 1 open turn(s) past the expiry window; oldest 72h
recorder recover        {"recovered":1,"pending":0,"expired":1}
记录             status=interrupted  tools=unavailable（未观测，非 partial）
收敛后 doctor    exit=0
daemon（idle=2s）      启动 True → idle 后 False   ← 原先会永不退出
```

### 过期轮次不发布 diff

实测发现的证据错误:过期收敛若照常调用 `finishGitTurnDiff`,会把基线之后的**全部**改动算进这一轮,并标成 `available` + `exact`。实测在轮次开启后写入 3 个无关文件,三者全部被归因:

```
diff 段 status: available | quality: exact
  归因到这一轮的文件: x1.ts +3  x2.ts +3  x3.ts +3
```

修正:过期路径改为 `cancelGitTurnDiff` 释放基线,`evidence.diff` 置为 `unavailable`,原因说明基线跨越过期窗口无法归因。

这同时解决了性能问题 —— git diff 收尾正是过期收敛的主要开销:

| 孤儿轮次数 | 修正前 | 修正后 |
|---|---|---|
| 20 | 33.7s / 峰值 RSS 112 MB | **2.5s / 88 MB** |
| 200 | 624.6s / 峰值 RSS 183 MB | **27.5s / 110 MB** |

### 两个实现缺陷(均由测试或实测抓出)

1. 最初按"是否在 stale 候选集合里"计数 `expired`,但候选轮次仍可能靠真实终态(如 Codex `turn_aborted`)收敛;既有用例立刻失败,改为只在真正走过期分支时计数。第二个过期分支还漏了该标记 —— 记录已是 `interrupted` 但计数为 0,靠交叉核对记录状态与计数才发现。
2. 首次内存测量得出"堆完全不涨"的结论是**假的**:所有 CDP 请求都被 409 `protocol mismatch` 拒绝,daemon 实际没干活。补上 `x-scry-protocol`/`x-scry-provider`/`x-scry-event` 头并断言 records 数量后才拿到有效数据。

## 12.9 daemon 内存:高水位,非泄漏

通过 CDP 强制 GC 前后对比 40 个真实轮次(transcript 累积 35.4 MB):

```
启动后    heapUsed  9.4 → GC后 7.8   RSS  65.2 MB
10 轮后   heapUsed 31.6 → GC后 9.0   RSS  98.0 MB
20 轮后   heapUsed 28.4 → GC后 9.2   RSS 101.3 MB
30 轮后   heapUsed 28.8 → GC后 9.5   RSS 108.4 MB
40 轮后   heapUsed 32.8 → GC后 9.3   RSS 107.0 MB

GC 后 heapUsed 相对启动增长: 1.7 MB
```

结论:**不是泄漏**。GC 后堆稳定回落到约 9 MB,40 轮只留下 1.7 MB;峰值 28–33 MB 是单轮 transcript 解析的瞬时分配。RSS 从 65 MB 涨到约 107 MB 且不归还,属于 V8/OS 高水位。

因此本机观察到的 239–298 MB 活跃 daemon 对应的是**更大的历史峰值**(该 workspace 有 690 个会话目录、1082 条记录、48 个孤儿轮次),不是持续增长。由于 daemon 是每 workspace 一个且没有全局上限,多 worktree 并行时这个高水位会叠加 —— 这是"每 worktree 一个 daemon"的真实代价,记录在此供后续决定是否需要上限或 RSS 触发的自重启。

## 12.10 事件投递快路径:hook 脚本直投 daemon

§12.7 的结论是 daemon 对 shell hook 几乎没有延迟收益,原因是 hook 脚本无论如何都要启动一个 Node 进程。这条前提现在被去掉了:hook 脚本在 daemon 已运行时用 `curl --unix-socket` 直接 POST `/v1/hook`,不再启动 Node。

实测单个工具事件:

| 路径 | p50 |
|---|---|
| curl 直投 daemon | **83ms** |
| CLI → daemon(旧默认) | 155ms |
| CLI 自己落盘(`TRANSPORT=direct`) | 476ms |

一整轮的合计:5 次工具调用 2.09s vs 8.36s;30 次工具调用 **5.19s vs 32.30s**(省 83.9%)。工具调用越多差距越大,因为省下的是每事件一次 Node 启动(约 79ms)。

fail-safe 设计:
- stdin 先读进 `payload` 变量再投递 —— stdin 不可重放,不先缓存就无法回退。
- 只有 HTTP `200` 算成功,其余(陈旧 socket、协议不匹配、daemon 卡死、curl 缺失)一律回退到 CLI。
- managed 模式(App 宿主)不走快路径,保持 `--managed` 语义。
- 协议版本从 `PROTOCOL_VERSION` 插值,不在脚本里写死字面量。

实测四种边界:冷启动无 daemon → 回退且 daemon 被拉起;daemon 在 → 走快路径;daemon 被杀 + socket 删除 → 记录正常;**socket 存在但进程已 `kill -9`(陈旧 socket)→ 回退,记录数正确**。1 MB 工具入参经快路径投递后按既有 8 KiB 预算省略并标 `partial`,没有静默截断。

### 现有 workspace 需要重新生成 hook 脚本

`init` 每次都会重写 `.scry/provider-hook.sh`,所以存量 workspace 需要执行 `scry init` 或 `scry integrations repair` 才能拿到快路径;不执行也只是保持旧的较慢行为,不会出错。

## 12.11 CPU 空转与长轮次

两个可能造成"风扇狂转"的怀疑点都做了实测,结论是都不成立:

**daemon 空转**(静置 30 秒,单核百分比):

```
无进行中轮次        0.0%
1 个进行中轮次 小 transcript   0.1%
1 个进行中轮次 6.8MB transcript 0.4%
20 个进行中轮次     1.3%
```

daemon 在有未结束轮次时会轮询 recovery(1s 起、指数退避到 15s 上限),每次都要扫描全部会话目录并解析 transcript;实测该开销在 15 秒退避下可忽略。

**长轮次内的 O(n²)**:同一轮里连发 400 对工具事件,单对耗时**没有随事件数上升**(第 1–50 对 287.3ms → 第 351–400 对 275.6ms),801 个事件文件合计 328 KB,`Stop` 合并 800 个事件耗时 1477ms。不存在累积退化。

## 12.12 第二轮消融:删除重复面与零消费者

| 删除项 | 依据 |
|---|---|
| `state/next-sequence.json` | **只写不读**。生产代码里唯一的引用就是那次写入,注释本身写着"commit recovery always trusts record files, never this value"。每次提交白付一次原子写 |
| `scry verify-capture`(190 行) | 与 `scry status` **重复**。4 个原因码与 status 的 4 个 `state` 一一对应,`pending_open_turn` 对应 `openTurnsPending`,`disabled` 对应 `recorder.enabled`。唯一独有行为是阻塞等待,而 `status` 退出码 0 已经等价于"采到了",一个 `until` 循环即可替代 |
| `scry turns project`(177 行) | **零消费者**。它是为独立 uploader 准备的脱敏投影,而 uploader 已被搁置。白名单在没有真实消费方之前只是猜测,验证不了 |
| `scry capture show` | 折进 `doctor` 输出的 `capture` 字段。它唯一独有的信息是"解析后的默认值",一个字段就能给,不值一个命令 |
| `--timeout` / `--policy` flag | 随上述命令一并移除 |

替代 `verify-capture` 的写法(`status` 退出码:0 在采集 / 2 未启用 / 3 已配置未采到):

```bash
i=0; until scry status >/dev/null 2>&1; do i=$((i+1)); [ "$i" -ge 30 ] && break; sleep 2; done
```

实测替代等价:未采到时 `status` exit=3,采一轮后 exit=0。

保留下来的判断依据:`status`(逐 Provider 六阶段,回答"卡在哪一环")与 `doctor`(store 完整性、health、孤儿轮次,回答"是否健康")交集只有 `enabled` 一项,不构成重复。

### 消融复审后保留:`records archive`

`archiveRecords` / `ArchiveState` / `readArchiveState` / 提交路径的 archive floor / `verifyStore` 的 `archivedThrough` 共约 130 行,当前零使用,曾作为删除候选被复审。

**结论:保留。** 判断依据不是"以后可能有用",而是它保护的不变量在删除后没有替代答案:用户迟早会自己去清理 `.scry/records`,而没有 archive floor 时,手工删除会让 `verifyStore` 报 sequence gap、并让分配器重用已发出的序号。提供正确入口比拒绝支持更安全 —— 这也正是提交路径分配器要取 `max(liveMax, archivedThrough) + 1` 的唯一理由。

两个不变量都有测试锁定:

- `recorder.test.ts:2591` 归档全部记录后新轮次从 floor+1 继续,store 仍连续
- `recorder.test.ts:2608` 未记录 floor 的手动删除仍然报 sequence gap

代价也如实记录:这是本轮唯一为新功能而修改 append-only 提交路径的改动,是 recorder 里风险最高的一处。

## 12.13 真实 workspace 收敛实测(rate-native)

在本机真实工作区执行过期收敛,暴露并修掉了一个实现缺口。

**缺口**:Provider 会轮转删除 transcript,此时 `stableTranscript` 返回 `identityMatched === false`,`finalizeOpenTurn` 便永久返回 `pending` —— 轮次既不收敛也不消失。实测第二遍 recover 返回 `expired: 0` 而 `doctor` 仍报 6 个孤儿,才发现这一点。

**修正**:仅在过期路径上,身份无法匹配时不再等待,而是**丢弃整份 transcript 证据**后收敛。绝不借用无法确认归属的内容:`assistant` 与 `modelSegments` 置 `unavailable` 并说明"transcript 已不再包含这一轮",只保留 lifecycle hook 侧属于该轮自己的证据(如 hook 收到的 prompt)。

三遍收敛结果:

```
第一遍  {'recovered': 29, 'pending': 13, 'expired': 29}
第二遍  {'recovered': 0,  'pending': 13, 'expired': 0}   ← 暴露缺口
第三遍  {'recovered': 6,  'pending': 7,  'expired': 6}   ← 修正后
```

最终:records 1085 → 1120,孤儿轮次 35 → **0**,剩余 14 个 open.json 全部是"还不该被收敛"的(7 个 codex 未满 24 小时、7 个 `closing` 待 App 两阶段提交)。

**顺带发现的既有问题(与本次改动无关)**:该 workspace 的 `doctor` 在收敛前就报 `corrupt` —— 1315 个序号里有 230 个空洞,而 `archive-state.json` 的 floor 是 0,即这些记录是被手工/外部流程删掉的,只有 1 个能在 `.scry/upload/reconciled` 里找到对应。这正是 §12.12 决定保留 `records archive` 的现实依据:没有 floor 解释的空洞就是损坏,而不是"已清理"。收敛只在末尾追加序号,不改变这一既有状态。

## 12.14 自动更新:边界从 minor 移到 major

本次发布定为 **0.2.32** 而不是 0.3.0。依据是核对了 registry 上已发布的 0.2.31 tarball:它的命令面只有 `init` / `recorder` / `turns` / `doctor` / `integrations install-pi|status-pi` / `upgrade` / `version` —— 本轮删掉的 `verify-capture`、`turns project`、`capture show` **从未发布过**(它们和 `status`、`commit-hook`、`records archive`、`support-bundle` 一样都是本轮新增的,只是压在同一个 0.2.31 版本号上没有单独发版)。相对已发布版本,本次是纯新增,patch 语义正确,存量 0.2.x 用户能够继续接收。

### 三道门,只放宽一道没有用

| 门 | 原行为 | 现行为 |
|---|---|---|
| `isCompatibleAutoUpdate` | 0.x 要求 minor 相同 | 同 major 即可 |
| `updateSpec` | 0.x 用 `~<current>`,锁死 minor | `>=<current> <major+1.0.0` |
| `runBackgroundUpdate` | `checkOnly: true`,**从不安装** | `allowBreaking: false`,安装同 major 更新 |

第三道门是关键发现:后台任务此前只检查不安装,所谓"自动更新"名不副实 —— 而 `consumeUpdateNotice` 一直在读 `updatedFrom` / `updatedTo` 来打印"已自动更新",那个分支在 `checkOnly: true` 下永远不可达。这说明原设计本就打算安装,后来被改成只检查。现在恢复为安装,那条提示路径也随之变为可达。

第二道门也必须改:`~` 锁 minor,而 npm 的 `^` 对 0.x 同样把 minor 当 breaking,两者都无法表达"同 major 内任意更高版本",必须显式写出上界。

### 迁移链

存量客户端用的是**它自己那份**规则,所以放宽后的规则只能通过一个"旧规则已经接受"的版本送达:

```
0.2.31（旧规则）──接受同 minor──> 0.2.32（新规则）──接受同 major──> 0.3.x / 0.9.x
```

因此这次必须发 0.2.32 而不是 0.3.0,否则存量用户拿不到新规则。测试锁定了这条链(`update.test.ts`)。

### 代价

放宽之后,一次真正破坏性的发布会被静默装到用户机器上。唯一的表达手段变成 **major**:破坏 CLI 合同时必须升到 `1.0.0`,而不是靠 0.x 的 minor。这条约定必须遵守,否则用户会在不知情的情况下被换掉命令面。

## 12.15 投递移出 hook 关键路径

`handleRecorderHook` 过去在返回前同步 drain commit 通知。这是错的分工:**记录**必须让 Provider 等,**唤醒外部 uploader** 不必,而它的预算(8 条 / 1.5s)要在每个事件上付。

现在 `RecorderHookInput.deferDelivery` 让长活调用方跳过内联投递,daemon 在 `writeJson(200)` **之后**调用 `drainRecorderDelivery`。一次性 CLI 进程不能设这个标志 —— 它会在投递前退出,那样等于丢投递;因此 direct 模式仍是同步投递。

实测(commit hook 回调 350ms/条、积压 6 条):

| 路径 | 每事件 |
|---|---|
| hook 内同步投递(旧行为 / direct 模式) | 1688ms |
| daemon 响应后投递 | **500ms** |

崩溃窗口由既有的 at-least-once 重投覆盖(`redeliverLatestCommitNotification` + 指纹变化时 `ackedThrough` 归零)。

### 触发这项改动的真实场景:壳仓库 + 15 个子仓库

本机 `rate-native` 是壳仓库,真实代码在嵌套子仓库里,`repositories.mode: discover-nested-git` 发现 **15 个仓库**。实测每轮开始的 git 基线:

```
串行合计            5.05s
并行实际（生产路径）  1.6–2.0s      ← begin 已经是 Promise.all
最慢单仓库           rateplatform 1245ms
```

该 workspace 的自建 hook 脚本给轮次起止事件 4s 的 curl 超时,超时即回退到 CLI **把同样的活重做一遍**;`transport.log` 累计 **1693 次** `cold-direct`。2s 基线 + 最多 1.5s 投递 + IO 正好在 4s 边缘,所以这项优化直接降低回退概率。

对嵌套采集是硬需求的场景,`workspace-only` 不是选项;可行方向按收益排序:

1. ✅ 投递移出关键路径(本节,最多 −1.5s/事件)
2. 调大该 workspace 的 `SCRY_RECORDER_SEND_TIMEOUT`(回退比等待更贵)
3. 排除确实不需要采集的子仓库(实测每个干净仓库约 120–160ms)
4. 待评估:daemon 缓存逐仓库的 git layout。§12.7 曾以"只值 159ms"否决,但那是单仓库;15 个仓库时静态调用约 1.1s,结论需要重估

## 13. 落地顺序

1. **P0-0 授权门**（决定方案成立与否）。
2. P0：`status`、`verify-capture`、`integrations diff/uninstall`、`doctor` schema、`notify-drain`、drain 预算 + at-least-once 合同、records 容量文档。
3. 试点 1–2 个团队，纯本地跑两周，靠 `status --json` + `doctor` 输出收集问题。
4. P1：`turns project` → Uploader → `capture` preset → `import` → `archive` → `support-bundle`。
5. P2 按需。

## 14. v1 → v2 修订表

| 位置 | v1 说法 | 实际情况 | v2 处理 |
|---|---|---|---|
| §0/§3 | 「CLI 零出网」 | `update.ts:150-160` 有 opt-in `npm view` | 改为「不做数据上报出网」 |
| §5 | commitHook 是「现状可用接缝」 | 仅 App 激活（`main/commit-hook-trust.ts:312`；README.md:65） | 新增 §5.0 定性 + P0-0 授权门 |
| §5 | 「全部记录计为 pending」 | 只有 `ackedThrough` 为 0 时才是全部（`store.ts:224-227`） | 改为「未 ACK 的剩余记录」 |
| §5 | 只说 exit 0 才算 ACK | stdin 写失败/超时同样判负（`store.ts:190-210`） | 补齐 |
| §5 | 未提重复投递 | 三条重复来源（`store.ts:236-305`） | 新增 §5.2 at-least-once |
| §12 | 「10s 超时足以防阻塞」 | 单次 drain 无总预算（`recorder.ts:2113`，`store.ts:241`） | 新增 §5.3 预算 |
| §4 | socket 固定 `.scry/recorder-v1.sock` | >100B 回落 tmpdir，可被 env 覆盖（`daemon.ts:124-137`） | 图上标注 |
| §6 | 新增 `doctor --json` | 已只输出 JSON（`scry.ts:36,270-309`） | 改为「稳定 schema + 保留退出码」 |
| §7 W3 | 「复用现有 marker 托管块」 | 无 marker 块，command 全等匹配（`workspace-init.ts:147,176`） | 改为「新增 handler id 识别层」 |
| §7 W5 | team preset | 等价默认值（`config.ts:99-102`） | 删除，改 P1 真实 preset |
| §7 W2 | `record_without_terminal_status` | 封闭 union 强校验（`turn-record.ts:196`） | 换为 6 个真实原因码 |
| §7 W1 | 非 codex 的 `Trusted: n/a` | CLI 无 trust 观测能力（`workspace-init.ts:395`） | 全部 `unknown` + `omissionReason` |
| §7 W1 | Pi 与其他 Provider 同列 | Pi 是用户全局（`pi-integration.ts:37`），`init` 拒绝 pi | 单列 `global` |
| §7 W1 | `provider-activity.json` 走默认原子写 | 默认 `sync: true` 双 fsync（`io.ts:20-28`） | 强制 `{ sync: false }` |
| §9.1 | 禁 `node:https` | Core 用 `node:http`（`daemon.ts:4`） | 规则重写 + `socketPath` 断言 |
| §11 | 「同步 README 版本」 | README 版本无门禁 | 补 `version.test.ts` 断言 |
| §11 | 未提 0.3.0 影响 | `0.x` 自动升级要求 minor 相同（`update.ts:87-92`） | 公告人工升级 |
| §7 W6 | `import` 未定记录归属 | 同 store 会破坏 sequence 且被 drain 推走 | 三问前置 |
| — | 未提 records 保留 | 无 prune，全量扫描（`store.ts:69,337,355`） | 新增 W10 |
| §7 W7 | `workspaceId` 原样上传 | 默认取目录名（`workspace-init.ts:114`） | 改为 `workspaceIdHash` |
| §0 vs §7 W7 | 自相矛盾 | — | 新增 W7a 投影命令 |
| §7 W10 | 自带 Node runtime | 会有三条分发通道，`~/.scry` 已占用 | 删除，保留 manifest |

## 15. 遗漏项与内部附录

### 待补设计

- **Monorepo / 嵌套 Git**：`init` 强制在 git 顶层（`workspace-init.ts:104-116`），`repositories.mode: discover-nested-git` 只影响 diff 范围（`config.ts:189-215`）；子仓库开发者的接入姿势未定义。
- **同 workspace 多 Agent 并发**：单 daemon、单全局 sequence、`commit.lock` 2s；多 Provider 同时收敛的行为与失败表现无说明、无用例。
- **CI / headless**：hook 在无 TTY/CI 的行为，以及是否允许在 CI 采集。
- **卸载后数据归属**：records 留在用户仓库，谁删、是否会被误提交（`init` 只写 `.git/info/exclude`，克隆者不继承）。
- **服务端治理**：Uploader 发出后由谁运营、保留多久、能否删除。
- **文档语言**：目前全中文（README 亦然），跨团队英文入口未规划。

### 内部附录（不随包外发）

对 AITrace 的实测细节（安装路径、`~/.r2c/logs/session-capture.db` 体积与权限位、内部上报域名等）属内部评审材料。CLI 包为 MIT 并发布到内网 registry，本文件若随包分发，需先移除具体内部路径与实测数字，只保留架构层面的对比结论。

## 16. 定位表述

> AITrace 回答「组织用了多少、生成并采纳了多少」。
> Scry CLI 回答「这一轮到底发生了什么、证据从哪来、哪些不可观测」，并通过 fail-closed 授权门 + 只读投影，把「什么可以离开本机」交给团队显式决定。
