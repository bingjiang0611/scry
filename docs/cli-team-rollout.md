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
- `DrainResult` 新增 `truncated`；hook 失败**不**标记为截断，便于区分停滞原因。
- 截断状态持久到 `.scry/notifications/drain-status.json`（`{ sync: false }`，仅在状态转换时写），`status` 以 `lastDrainTruncated` 暴露。
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

### W2 `scry verify-capture`

原因码收敛为真实状态（`config.ts:137-165`）：

`missing_config` / `disabled`(sentinel/env) / `daemon_unavailable` / `no_hook_event` / `pending_open_turn` / `ok`

删除 v1 的 `record_without_terminal_status`：committed record 的 `status` 是封闭 union 且被 `isAgentTurnRecord` 强校验（`turn-record.ts:196`），该状态不存在。

### W3 `integrations diff` / `uninstall`（`repair` 降 P1）

- **必须新增按 handler id 的识别层**。`HANDLER_ID` 只作为字符串出现在 `hookCommand()` 生成的命令里（`workspace-init.ts:147-150`），Claude/Codex/Qoder 的 JSON 无 marker 块，判「已安装」用 command **全等**（`workspace-init.ts:176-186`）。命令形状一变（换 flag、换 `PROJECT_DIR` 变量、上 Windows）就会追加第二条 hook；`scripts/cli-package-smoke.mjs:63-66` 正是用出现次数断言幂等。
- 识别规则：命中 `SCRY_HANDLER_ID=turn-recorder-v1` 即视为托管条目；group 内混有用户 hook 时只删 scry 条目，group 空了才删 group。
- `uninstall` 覆盖面必须完整：Provider hook 条目、OpenCode 插件（含 marker，`workspace-init.ts:349`）、`.scry/provider-hook.sh`、`.scry/cli-path`、`.scry/node-bin-dir`、`.git/info/exclude` 条目（`workspace-init.ts:335-341`）、Pi **全局** extension 的处理说明；并打印保留了什么（records 保留）。
- `diff` 零副作用。

### W4 `doctor` 稳定 schema

- `doctor` 现在**已只输出 JSON**，`--json` 是已注册但被忽略的 flag（`scry.ts:36,270-309`）。工作内容是「稳定 schema」，不是「新增 --json」。
- **必须保留现有退出码 0/2/3/4/5**（`scry.ts:288-308`）并写进文档，团队 CI 会依赖。

### W5 `notify-drain`

显式触发 drain，输出 `delivered` / `notifyBacklog` / `truncatedByBudget` / `lastError`。Uploader 联调必需。

### （已删除）`init --preset team`

v1 的 team preset 等价于默认值：`toolOutput` 默认已是 `summary`、`diff` 默认 `true`、`patchExcludeBasenames` 默认 `[]`（`config.ts:96-103`，`workspace-init.ts:118-127`），且 `toolOutput` 只有 `none|summary` 两档。**空动作，从 P0 删除。**

团队场景真正需要的是**更少**采集（`prompt:false` / `assistant:false`，正文不落盘），配合 §7 W7a 的投影；等 preset 有真实语义再做（P1，见 W8）。

### P1

**W7a `scry turns project`（v2 新增，P1 首位）**

- 只读、无网络。输入 `recordId` + `--policy <id>`，输出 metadata-only 白名单 JSON。
- 让 Uploader 默认只消费投影，不需要 `.scry/records` 读权限——把「脱敏」放进被评审的 CLI 代码，而不是每个团队的脚本里。
- 解决 v1 §0 与 §7 W7 的自相矛盾（一边说投影语义不进 CLI 合同，一边又规定白名单）。

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

**W10 `records archive` + 容量文档（v2 新增）**

- 全仓库无 retention/prune；`listRecords`/`verifyStore`/`turns list`/`doctor` 全量读，drain 每个 hook 事件 `readdir` 整个 records 目录（`store.ts:69,337,355`）。
- P0 至少文档化「不要手删 records」（会触发 `sequence gap`）+ 给容量预估；P1 提供合规归档命令（保留序号连续性证明）。

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
