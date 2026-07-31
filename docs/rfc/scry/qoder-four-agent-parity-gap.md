# Qoder / 四 Agent 会话数据一致性 Gap Analysis

## 1. 现状描述

Scry 已经具备统一 `TurnEvidence` 和 Codex managed canonical commit，但 Qoder 尚未接入，因此同一轮由 App SDK archive 与 CLI lifecycle/transcript 各自重建。

- `src/main/index.ts:312-373`：managed progress/commit 只接受 `providerId === 'codex'`。
- `src/main/managed-turn-commit.ts:20-50`、`src/core/turn-recorder/managed.ts:35-48`：managed 公共类型只允许 Codex；CLI recovery 也只扫描 Codex runtime root。
- `src/main/providers/qoder.ts:50-68,308-489`：Qoder 进程未启用 managed recorder，且 run result 没返回 native turn identity。
- `src/core/turn-recorder/recorder.ts:141-144,1576-1608`：turn identity 不识别 Qoder `promptId` 及 bridge 的 `raw_qoder_payload.promptId`，双投递会误切轮。
- `src/main/normalize.ts:525-579`、`src/core/turn-recorder/recorder.ts:1148-1156`：compact summary 被当作新用户轮；通用 parser 不能按 Qoder `promptId` 选中原轮。
- `src/main/normalize.ts:347-378`：Qoder 外层 `toolUseResult.isError/exitCode` 未进入 `tool_result.isError`。
- `src/renderer/components/ChatTurn.tsx:706-732`：result 会合并进共享 `toolUseId` 的 hook，Header 又统计所有 `isError`，把截图时已记录的失败错误放大成 13；完整 native turn 后续继续执行，最终可审计真值为 6。

目标样本已经证明 Provider 调用 ID 本身一致：工具/Agent 270、直接 Skill 5、MCP 1。主要缺口是轮次身份、compact 归属、错误归一化和证据提交路径。

## 2. 用户需求复述

按优先级修复 Qoder 与 Scry CLI 除 token 外的不一致，并确保 Claude Code、Codex、Qoder、opencode 四个 Agent 的既有行为和数据合同兼容。

## 3. Delta 识别

1. **轮次身份 Delta**：Qoder 同一 `UserPromptSubmit` 的直连与 bridge 包装没有落到同一个 native turn key。
2. **compact Delta**：synthetic compact summary 错误开启新轮，CLI 选到 summary + post-compact assistant，而不是原始 prompt 对应的完整轮。
3. **错误 Delta**：App 漏掉外层 Qoder 工具失败；renderer 又把工具结果错误复制到 hook。
4. **canonical Delta**：Qoder App/CLI 没有共享同一份 evidence、diff、hook、file、skill 和 timing。
5. **四端兼容 Delta**：managed 类型、恢复、完成通知和强停保护只识别 Codex；扩展 Qoder 时必须保证 Claude/opencode 不被隐式迁移。

## 4. 闭合选项

### 选项 A：只修 renderer 数字

- 代价：约 2 处。
- 结果：只能让 Header 看起来正常；重复轮、compact 错选和 CLI 详情缺失仍存在。
- 结论：否决。

### 选项 B：只修 legacy recorder 的 Qoder parser

- 代价：约 3 个实现点 + 测试。
- 结果：重复轮和 compact 可修，错误可对齐；但 App/CLI 仍由两套来源重建，hook/diff/file/skill/timing 以后仍可能漂移。
- 结论：作为防御层保留，但不足以单独闭合需求。

### 选项 C：Qoder 接入既有 canonical，并补 legacy 防御（推荐）

- 代价：约 7 个实现文件及对应测试，不新增存储格式。
- 做法：
  1. recorder 识别 direct/nested Qoder `promptId`，parser 跳过 compact summary 并保留 `providerTurnId`。
  2. 仅当工作区 recorder 已启用时，Qoder App run 才注入 managed 环境。Qoder 标准 hook 输入不保证暴露 native promptId，因此 lifecycle 先建立唯一 provisional open；App turn ID 优先取 SDK raw `promptId`，缺失时只接受当前 session 日志中唯一的 root SDK prompt 事件，再在 canonical prepare 阶段绑定，多个 provisional open 或多个 root ID 均 fail closed。
  3. managed provider 类型、按 provider 过滤的恢复和 main 生命周期从 `codex` 扩为 `codex | qoder`；只有这两端走 canonical，Claude/opencode 保持原路径。
  4. Qoder tool result 同时读取 block 与外层失败字段；Header 使用共享 `isOverviewToolErrorEvent`，且 result 只合并到 tool/skill/agent 调用事件。
  5. Qoder adapter 从 result subtype/interrupt 显式返回 `completed | failed | interrupted`。completed 继续要求 exact assistant + Provider result timing；非 completed 可保留 unavailable assistant，缺 result timing 时使用同一份 App 运行边界时间提交 archive 与 CLI record，避免 pending 永久阻塞。
- 结果：Scry 启动的 Qoder 与 CLI 对同一轮写入同一份 `TurnEvidence`；terminal-only Qoder 仍受 identity/compact 防御保护。

### 选项 D：四个 Provider 一次性全部迁到 managed

- 代价：需要分别证明 Claude/opencode 的权威 turn identity、result timing 和 hook handoff，影响面显著扩大。
- 结论：否决；当前没有证据证明两端需要或满足严格前置条件。

## 5. 推荐方案 + 回问清单

采用选项 C。

- 公共契约：新增内部 `ManagedRecorderProviderId = 'codex' | 'qoder'`；`AgentTurnRecord.provider.id`、archive schema 和 CLI JSON 均已支持四 provider，无 schema migration。
- 空值策略：recorder 未启用时保持普通 archive且不校验 pinned CLI；严格 recorder 已启用但 Qoder 缺少唯一 provisional open 或 native turn ID 时 fail closed，不把 hook 的 session ID 当 turn ID、不悄悄回退双源记录。仅 Qoder 的失败/中断在没有 Provider timing 时使用 App 观测边界；Codex 保持原有 exact assistant/result timing 语义。
- 老数据：不重写已有 Qoder archive/record；新会话开始生效。
- 性能：managed start 不做 Git diff，canonical 复用 App 已采集 diff；renderer 仍为单轮 O(n) 扫描。
- 观测：pending progress/journal、recorder health、archive providerTurnId 和 App recording error 继续使用现有机制；恢复按 provider 过滤，Qoder pending 不阻塞 Codex，反之亦然。
- 验证：定向失败测试 → 全量 test/typecheck/build/build:cli/diff-check → Scry L2 → four-agent quick/runtime。40 轮四 provider 正式长回归涉及真实模型成本与配置备份，另过 checkpoint 后再跑，不把未执行结果写成通过。

开放问题：无阻塞项。token 明确不在本次范围；用户若要求修复历史目标 session，需要另做一次显式、可审计的数据迁移。
