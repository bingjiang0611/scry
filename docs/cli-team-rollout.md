# Scry CLI 团队推广技术方案

本方案只讨论独立 CLI `@ali/scry-turn-recorder`（当前 `0.2.31`），不涉及 Scry 桌面 App。
参考对象为本机安装的 AITrace `1.3.109`（AliLang 托管 sidecar + `@ali/ai-coding-trace`）。

## 0. 已定决策

**CLI 不引入任何远端上报能力。** 团队汇总只通过既有 `commitHook` 接缝完成，Uploader 作为**独立包**发布、独立版本、独立评审。

因此：

- Recorder Core（`src/core/turn-recorder/`）保持无网络、无 Electron、无原生依赖。
- CLI 不新增 `sync` 命令、不新增 endpoint/token 配置、不新增出网依赖。
- CLI 唯一对外接缝是 `commitHook`：committed 后以 stdin 投递通知，ACK 后推进游标。
- 「上传什么、脱敏到什么程度、发去哪里」是 Uploader 的职责与风险，不进入 CLI 合同。

代价必须说清：Uploader 独立后，团队接入是两步（CLI + Uploader），推广成本高于一体化方案；但 CLI 的信任边界与审计面最小，这是本方案刻意选择的取舍。

## 1. 目标与非目标

### 目标

1. 其他团队能在 10 分钟内在自己的 Git 仓库接入，并能自证「真的采到了」。
2. 出问题可自助诊断、可修复、可干净卸载。
3. 需要团队汇总时，有官方 Uploader 参考实现与稳定合同，而不是每个团队自己猜。
4. 环境可复现：CLI 版本、Node 版本、Provider 版本、record schema 可对齐。

### 非目标

1. 不做用户级全局 transcript 扫描（AITrace 的做法）。
2. 不做常驻中央进程与跨项目明文大库。
3. CLI 不做任何默认或可选的网络上报。
4. 不追求 Provider 数量对标 AITrace。

### 必须保留的既有边界

- 缺 `scry.config.json` 时 fail closed（`resolveRecorderEnablement` → `missing_config`）。
- `.scry/` 目录 `0700`，record 原子写入 `0600`（`src/core/turn-recorder/io.ts`）。
- 一轮一个 append-only JSON，序号严格递增（`src/core/turn-recorder/store.ts`）。
- `unavailable` / `partial` / `disabled` 不得伪装成 `0` 或空数组。

## 2. 现状差距（推广视角）

| 差距 | 现状 | 影响 |
|---|---|---|
| 安装依赖用户环境 | 需 Node ≥ 20，`os: [darwin, linux]` | Windows 团队直接阻塞；nvm/PATH 问题多 |
| 成功判定不直观 | `doctor` + `turns list` 人工判断 | 用户误以为 `init` 成功即采集成功 |
| Codex 需手动 `/hooks` 信任 | CLI 无法代替 | 静默无记录，且不易发现 |
| 配置漂移无检测 | 无 diff/repair | Provider 升级或用户改配置后失效 |
| 无历史导入 | 只记录接入后的轮次 | 试用当天数据稀疏，说服力弱 |
| 汇总链路缺参考实现 | 只有 `commitHook` 合同 | 每团队自建 Uploader，重复踩坑 |
| 支持成本高 | 无标准诊断包 | 跨团队排障靠人肉 |

## 3. 借鉴 AITrace 的能力清单

| AITrace 能力 | 借鉴结论 | 落到 Scry CLI |
|---|---|---|
| bundled Node runtime + component manifest / SBOM / hash | 借鉴 | 自带 runtime 的独立发行包（P2） |
| 逐 Provider 状态（NotDetected / Running / Stopped） | 借鉴并细化 | `scry status` 多阶段矩阵（P0） |
| Hook 幂等注册、保留原有 Hook、备份 | 部分借鉴 | 显式 `integrations diff / repair / uninstall`（P0） |
| transcript offset cursor / payload hash 去重 / backfill | 借鉴，但改为显式触发 | `scry import --dry-run`（P1） |
| SQLite outbox + retry + oversized 终止 | 借鉴到 **Uploader**，不进 CLI | 独立包（P1） |
| 逐数据类型开关 | 借鉴并强化语义 | `capture` preset + record 落 `policyVersion`（P1） |
| 本地配置 webview | 不借鉴（CLI 无 UI） | `doctor --json` + `support-bundle`（P0/P1） |
| 全局自动采集与默认上报 | **不借鉴** | 保持 workspace opt-in、CLI 零出网 |
| 中央 `~/.r2c/logs/session-capture.db`（约 1.47 GB、`0644`） | **不借鉴** | 保持 workspace 分区 + `0600` |
| 「目录排除」只作用于部分上传链路 | **不借鉴** | 若做 exclude，必须全链路生效并可验证 |

## 4. 目标架构

```text
scry CLI (可选自带 runtime)
  → 命令层 (src/cli)
  → Recorder Core (src/core/turn-recorder)  ← 无网络
      ├─ Provider hook / Pi lifecycle 扩展
      ├─ workspace unix socket daemon (.scry/recorder-v1.sock)
      └─ <workspace>/.scry/records/*.json   ← canonical
  → commitHook (进程边界, stdin 通知 + ACK)
      → @ali/scry-uploader (独立包, 独立版本, 独立评审)
          → 团队服务
```

CLI 与 Uploader 的关系是**单向、进程外、可缺省**：没有配置 `commitHook` 时 `drainCommitNotifications` 直接返回 `{ delivered: 0, pending: 0 }`，CLI 行为与今天完全一致。

## 5. commitHook 合同（推广后需冻结）

### 5.1 现状（已实现，作为 v1 冻结）

- 配置：`scry.config.json` 的 `commitHook.entry` 必须是 workspace 相对路径，且必须包含在 `commitHook.files` 清单内；路径不得逃逸 workspace（`config.ts` 校验）。
- 运行期：`SCRY_RECORDER_COMMIT_HOOK` 必须是绝对路径且可执行文件，否则记录错误并把全部记录计为 `pending`。
- 调用：`spawn(hook, [], { stdio: ['pipe','ignore','ignore'] })`，环境变量按白名单裁剪（`COMMIT_HOOK_ENV_KEYS`），超时 10s，SIGTERM 后 1s 升级 SIGKILL。
- stdin 单行 JSON：

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

- ACK 语义：**exit 0 才算投递成功**。成功后原子写 `.scry/notifications/commit-hook-state.json`（`schemaVersion`、`hookFingerprint`、`ackedThrough`），失败即停止本轮、保留 `pending`，不跳号。
- 并发：`.scry/locks/commit-notification.lock` 目录锁，单 drain。
- 指纹变化（`SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT`）会使 `ackedThrough` 归零重放。

### 5.2 明确的信任边界

通知本身**不含**任何 record 正文。但 Uploader 可以按 `workspace + recordId` 自行读取 `.scry/records/*.json`，因此：

> commitHook 是「把本地记录交给外部程序」的授权点，不是脱敏机制。

推广文档必须直说这一点，不能宣传成「CLI 只发元数据所以安全」。

### 5.3 需要新增的最小能力（仍不出网）

1. `scry recorder notify-drain [--json]`：手动触发 drain，输出 `delivered / pending / lastError`，便于 Uploader 联调。
2. `doctor` / `status` 增加 commitHook 段：是否配置、entry 是否在 files 清单、可执行位、`ackedThrough`、`pending` 数、最近失败原因。
3. `commitHook` 未 ACK 时的 `pending` 必须在 `status --json` 暴露，避免团队以为「已同步」。

## 6. 命令面新增

```bash
# P0
scry init --preset local|team [--providers ...] [--dry-run]
scry status [--json]
scry verify-capture [--timeout 120]
scry integrations diff
scry integrations repair [--yes]
scry integrations uninstall [--yes]
scry doctor --json
scry recorder notify-drain [--json]

# P1
scry import <provider> --since 7d [--session <id>] [--dry-run]
scry capture show|explain <field>|diff
scry support-bundle create [--out <path>]

# P2
scry install | upgrade | rollback      # 自带 runtime 的独立发行包
```

`verify-capture` 是推广关键：等用户跑一轮真实任务，检测新增 record 并输出证据覆盖率，替代「自己去 `turns list` 看」。

## 7. 分阶段方案

### P0 — 接入与自证

**W1. `scry status`**

新增 `src/cli/status.ts`，逐 Provider 输出六个阶段，任一阶段不可知必须显式 `unknown`：

```text
Provider  Detected  Configured  Trusted  HookSeen  RecordSeen  Health
claude    yes       yes         n/a      2m ago    2m ago      ok
codex     yes       yes         unknown  never     never       blocked:hook-not-trusted
qoder     no        no          n/a      -         -           not-detected
pi        yes       yes         n/a      1m ago    1m ago      ok
opencode  no        no          n/a      -         -           not-detected
```

- `HookSeen` 需要新增 `.scry/state/provider-activity.json`（每 Provider 最近事件名与时间戳），由 hook 入口更新，走 `writeJsonAtomic`。
- Codex 的 `Trusted` 只能是 `unknown`，不得推断为 `false`。
- 末尾附 commitHook 段（见 §5.3）。

**W2. `scry verify-capture`**

轮询 record store，超时返回明确原因码：

`no_hook_event` / `hook_without_record` / `record_without_terminal_status` / `ok`

**W3. `scry integrations diff | repair | uninstall`**

复用 `src/cli/workspace-init.ts` 现有 marker 与合并逻辑，把「计划写入」与「实际写入」拆开：

- `diff`：只打印将修改的文件与差异，零副作用。
- `repair`：需 `--yes`，幂等，仅动带 marker 的托管块，保留用户已有 hook。
- `uninstall`：只移除托管块与 `.scry/provider-hook.sh`，保留 `.scry/records`，并打印保留了什么。

**W4. `doctor --json`**

稳定 schema：`schemaVersion` / `checks[] {id, status, detail, remediation}` / `summary`，供团队 CI 与支持脚本消费。

**W5. `init --preset`**

- `local`：现状默认。
- `team`：`toolOutput: "summary"`、`diff: true`、预置 `patchExcludeBasenames`；写入后自动跑 `status` 并提示下一步 `verify-capture`。
- `--dry-run` 打印将创建/修改的文件清单。

**P0 验收**：一个干净仓库，从 `init` 到 `verify-capture` 通过，全程不需要读源码或本仓库文档以外的资料。

### P1 — 团队价值与可运维

**W6. `scry import`（显式历史导入）**

- 只读 Provider 历史目录，`--dry-run` 必须先打印：扫描目录、文件数、字节数、时间范围、可恢复字段、哪些字段只能 `partial/inferred`。
- 借鉴 AITrace：per-file offset cursor + 记录级 hash 去重。
- 导入记录 `source` 必须含 `"import"` 且证据不得标 `exact`，与实时 hook 记录可区分。
- 绝不默认递归用户 home，必须显式命令 + 显式 Provider。

**W7. `@ali/scry-uploader`（独立包）**

- 独立仓库目录或 `packages/uploader/`，独立版本，独立 README 与安全说明。
- 作为 commitHook entry 被调用：读 stdin 通知 → 读 record → 投影 → 入本地 outbox → 异步发送 → 成功后 exit 0。
- **必须先 ACK 语义正确**：只有 record 已持久进 outbox 才 exit 0；网络失败不应阻塞 CLI（10s 超时会被杀）。
- 默认投影为 metadata-only 白名单：

```json
{
  "schemaVersion": 1,
  "workspaceId": "…",
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

- 默认禁止上传：prompt、prompt hash、assistant 文本、thinking、tool input/output、文件路径、patch、repo remote URL、环境变量值。
  - prompt hash 对常见提示词可被字典反推，不作为脱敏手段。
- 可靠性借鉴 AITrace：durable outbox、指数退避、oversized 明确终止不无限重试、401 使凭据失效并要求重新配置、HTTPS-only。
- 必须提供 `--dry-run` 打印完整将上传 JSON。

**W8. `scry capture`（语义可解释）**

- `capture show`：当前生效采集配置与来源（配置文件 / env / sentinel）。
- `capture explain <field>`：该字段是否采集、为何采集、缺失时会写什么 `omissionReason`。
- record 落盘 `policyVersion`，保证事后可解释「当时为什么采了这个字段」；旧记录缺该字段时按 `unavailable` 处理，不得默认为最新 policy。

**W9. `scry support-bundle create`**

- 仅含：CLI/Node/OS 版本、Provider 检测结果、配置指纹（非内容）、hook 状态、health 计数、record 数量与 schema 版本、`pending`/`ackedThrough`、脱敏错误。
- 明确断言不含 record 正文、文件路径列表与环境变量值。

### P2 — 覆盖率与交付

**W10. 独立发行包**

借鉴 AITrace `component-manifest.json`，CLI 发布物附：

```json
{
  "version": "0.x.y",
  "sourceCommit": "…",
  "buildHash": "…",
  "nodeRuntime": { "version": "…", "sha256": "…" },
  "recordSchemaVersion": 1,
  "commitHookProtocol": 1,
  "supportedProviders": ["claude", "codex", "qoder", "opencode", "pi"]
}
```

布局 `~/.scry/versions/<v>/` + `~/.scry/bin/scry`，支持 `install / upgrade / rollback`。
保持现有更新策略：默认不后台联网，`SCRY_AUTO_UPDATE=1` 才检查，registry 强制 HTTPS（`SCRY_CLI_REGISTRY`）。

**W11. Windows 支持**

- `provider-hook.ps1` 与分平台 `hookCommand`；unix socket 换 named pipe 或强制 direct 模式。
- 放开 `package.json` 的 `os` 字段前必须先有 Windows CI。

**W12. 兼容矩阵**

发布 CLI × Node(20/22/24) × Provider 版本 × `recordSchemaVersion` × `commitHookProtocol` 支持表，`doctor` 能对照给结论。

## 8. 配置演进（向后兼容）

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "workspaceId": "my-workspace",
  "dataDir": ".scry",
  "repositories": { "mode": "discover-nested-git", "maxDepth": 2 },
  "capture": {
    "preset": "team",
    "prompt": true,
    "assistant": true,
    "toolOutput": "summary",
    "diff": true,
    "hooks": true,
    "patchExcludeBasenames": []
  },
  "commitHook": {
    "entry": "tools/scry-uploader.sh",
    "files": ["tools/scry-uploader.sh"]
  }
}
```

约束：

- 新增仅 `capture.preset` 一项；缺省时行为与今天完全一致。
- **不新增** `sync`、`endpoint`、`credential` 等字段。
- 保留既有校验：`dataDir` 不得逃逸 workspace、不得经 symlink、`commitHook.entry` 必须在 `files` 清单内。

## 9. 安全与隐私评审要点

1. Recorder Core 不得引入 HTTP 客户端；CI 增加依赖/导入检查，禁止 `fetch`/`axios`/`node:https` 出现在 `src/core/turn-recorder/`（现有 `daemon.ts` 的本地 socket 除外，需加白名单注释说明）。
2. commitHook 是执行授权点：文档必须写明「entry 可读取全部 `.scry/records`」，并建议团队把 entry 纳入代码评审与 CI 校验。
3. 新增日志只记录 recordId、sequence、状态、错误分类、字节数、hash，不复制正文。
4. `import` 必须显式触发、`--dry-run` 先行。
5. 若未来提供路径排除，必须同时作用于 prompt / tool / diff / import / 派生统计，并提供验证命令——不重复 AITrace「排除目录只挡部分上传链路」的语义歧义。
6. `support-bundle` 与 `--json` 输出需有「禁止字段不出现」的断言测试。

## 10. 测试与验收

改动集中在 `src/cli/` 与 `src/core/turn-recorder/`，交付前至少：

```bash
npx vitest run src/cli src/core/turn-recorder
npm run typecheck
npm run check:cli-release
git diff --check
```

修改 `provider-hook.sh` 时追加 `npm run test:shell`。

新增测试重点：

- `status`：六阶段状态组合；Codex `Trusted` 为 `unknown` 不退化为 `false`；commitHook `pending` 正确显示。
- `verify-capture`：四种原因码各有用例，不使用固定 sleep，等待文件原子出现。
- `integrations diff/repair/uninstall`：非托管 hook 保留、坏 JSON 拒绝且不落部分写、重复执行幂等。
- `notify-drain`：hook 非零退出后 `ackedThrough` 不推进、无跳号；指纹变化触发重放；超时被杀记为未 ACK。
- `import`：cursor 去重、乱序/截断行、导入记录强制 `partial` 且 `source` 含 `import`。
- `capture`：preset 生效、record 落 `policyVersion`、旧记录无该字段不误判。
- `support-bundle`：断言不含正文、路径列表与 env 值。
- Core 无网络：静态检查用例。

Uploader 的重试、退避、oversized、401、白名单序列化测试属于独立包，不进 CLI 测试面。

## 11. 版本与发布

- CLI 命令/合同/集成/包内容变化 → 升 `packages/turn-recorder-cli/package.json`，并同步 README 安装示例版本。
- App 侧未变更时不动根 `package.json`。
- 发布只用 `npm run publish:cli`（`prepublishOnly` 强制 `check:cli-release`）。
- Uploader 独立版本，不与 CLI 强行对齐；用 `commitHookProtocol` 声明兼容性。
- 建议节奏：P0 → CLI `0.3.0`；P1 → CLI `0.4.0` + Uploader `0.1.0`；P2 → CLI `0.5.0`。

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| Uploader 独立导致接入两步、推广摩擦 | 提供一键脚本、示例仓库、`init --preset team` 直接生成 commitHook 骨架 |
| 团队自研 Uploader 泄露正文 | 官方 Uploader 默认 metadata-only + 明确 README 风险说明 + 建议 entry 进代码评审 |
| commitHook 阻塞 committed 路径 | 已有 10s 超时与 SIGKILL；Uploader 必须先落 outbox 再 exit 0 |
| 用户以为「已同步」但实际 pending | `status --json` 与 `doctor` 必须暴露 `pending` 与 `lastError` |
| 自动 `repair` 破坏用户 Provider 配置 | 默认只 `diff`；`repair` 需 `--yes`、仅动 marker 块、原子写 |
| `import` 被当默认能力滥用 | 仅显式命令、`--dry-run` 先行、记录强制 `partial` |
| Windows 缺失阻塞推广 | 文档先明确不支持，再按 P2 补 CI 与 named pipe |
| 后续有人把网络能力加回 CLI | §9.1 静态检查 + 本文件作为决策记录 |

## 13. 推荐落地顺序

1. 完成 P0 全部 + 接入文档与示例仓库。
2. 选 1–2 个试点团队，只用本地模式跑两周，靠 `support-bundle` 收集问题。
3. 再做 P1：`import`、`capture`、独立 Uploader。
4. 覆盖率仍不足时才进 P2。

## 14. 定位表述

> AITrace 回答「组织用了多少、生成并采纳了多少」。
> Scry CLI 回答「这一轮到底发生了什么、证据从哪来、哪些不可观测」，并把「是否离开本机」交给团队通过独立 Uploader 显式决定。
