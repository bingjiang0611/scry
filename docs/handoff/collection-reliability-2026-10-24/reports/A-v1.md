## V1 修改记录

范围：只修本节核验意见 V1。V2 的 orphan-only 范围按审查意见接受；**V3 不做，批次 B 未开始**。基线为审查提交 `f3716181`。

- 失败测试提交：`7ced5ba5`（生产实现仍为修改前版本）。
- 修复提交：`82f6e5e3`。
- 沿用用户已授权的本批文件大小 pre-commit 临时豁免；没有修改持久 Git 配置或 recorder commit callback 的 trust 检查。

### 四条要求的落实

| 要求 | 改动与证据 |
|---|---|
| 无 open turn 的会话结束不误报 | `recorder.ts` 对 `SESSION_END_EVENTS` 直接返回 duplicate；不写 orphan，不增加 missingStartTerminals/orphanEvents，不改写 lastError。覆盖 SessionEnd、session.end、session_end、session.exited、process.exit；有 open turn 的结束处理保持不变 |
| 续跑与其他 Provider 的重复信号 | Claude/Codex/Qoder 的 Stop 仅在 `stop_hook_active === true` 且无 open turn 时豁免；不向 Pi/OpenCode 猜测该字段语义。OpenCode 插件去重没有新活动的重复 idle，首次未知 idle 仍投递，详见下表 |
| 比较实际时刻而非字符串 | terminalAt、record.startedAt、record.completedAt 都用 Date.parse 后比较。回归覆盖 `+08:00` 与 `Z` 表示同一时间，以及无毫秒的结束时间和晚 500ms 的新终态，分别应 duplicate/orphan |
| 不带 timestamp 的真实形状 payload | 新增 `recorder-terminal-replay.test.ts`：真实形状的 Claude start/Stop 先提交一条 record，再投递无 timestamp 的 SessionEnd/续跑 Stop；断言 record 仍一条、两项计数为 0、lastError 不变、无 orphan 目录。保留原有缺开始 Stop 测试，另补四 Provider 无 timestamp 的真正缺开始负控制 |

### 其他 Provider 的确认依据与处理

以下是合同/源码核对与本地 fixture 验证，**不冒充当前真实 Provider 会话验收**。

| Provider | 证据 | 本次处理 |
|---|---|---|
| Claude | 已安装 `@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 StopHookInput 明确包含布尔 stop_hook_active；审查方提供的实际无 timestamp 形状 | 仅无 open turn 的 Stop + true 返回 duplicate |
| Codex | [官方 Stop input schema](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/stop.command.input.schema.json) 及 `codex-rs/hooks/src/events/stop.rs` 均包含 stop_hook_active；本次下载的 schema Git blob 为 `dbd4a3f648071bee1af24758e9596e11ab78c782`，与 API tree 一致 | 同上；缺字段的旧版本行为不变，不以字段名近似匹配 |
| Qoder | 已安装 `@qoder-ai/qoder-agent-sdk@1.0.17/dist/protocol/hooks.d.ts` 的 StopHookInput 包含 stop_hook_active:boolean | 同上；另验证 open turn 仍能正常收敛 |
| OpenCode | [v1.18.25 status.ts](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/status.ts)：每次 set 都发布 Status，idle 时直接发布 Idle 并删除内存状态，没有比较前后状态。与本机 SDK 版本 1.18.25 对应 | 在生成插件中识别同一实例内已投递的 idle；重复 idle 不再产生第二个空 Stop。chat.message 或 session.status 的 busy/retry 重置去重状态。普通 idle 状态通知不重置 |
| Pi | 仓库 `packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs`：agent_settled 已用 `!turn || turn.settled` 去重，session_shutdown 只对未 settled 的 active turn 发 Stop；payload 有 promptId | 复用现有机制，不改 Pi、不注册虚构的新信号 |

OpenCode 只记住最近 128 个 idle session，避免新增无界缓存。首次未知 idle、插件重载、缓存淘汰后仍投递，不把“没有活动轮”直接当作 duplicate。已知 spawn 错误或非零退出不加入去重集合，保留后续 idle 的投递机会。返回 0 只证明 hook 分发完成，不声称 record 已持久化；本次没有改 ACK/投递语义。测试覆盖首次未知 idle、新 prompt、busy/retry、重复 idle 状态通知、128 项淘汰和非零退出。

**生效方式**：核心终态判断升级 CLI 即可；OpenCode 插件需在目标 workspace 执行 `scry integrations repair --yes`，并重新加载该测试 Provider 的插件。本次没有安装 CLI 或修改日常 workspace。shell curl 快路径、退出码、fsync 和 commit trust 实现均未修改。

### 旧实现失败输出与迭代记录

```sh
npm run test:unit -- src/core/turn-recorder/recorder-terminal-replay.test.ts src/cli/workspace-init.test.ts -t V1
```

在 `7ced5ba5` 对应旧生产实现上的实际输出节选：

```text
FAIL V1 real Claude 'SessionEnd' without timestamp after a committed turn is not missing_start
FAIL V1 real Claude 'Stop' without timestamp after a committed turn is not missing_start
expected { status: 'orphan' } to match object { status: 'duplicate' }

FAIL V1 SessionEnd / session.end / session_end / session.exited / process.exit ...
expected { status: 'orphan' } to match object { status: 'duplicate' }

FAIL V1 claude / codex / qoder declares stop_hook_active as same-turn continuation
expected { status: 'orphan' } to match object { status: 'duplicate' }

FAIL V1 compares instant values across timestamp formats ('duplicate')
expected { status: 'orphan' } to match object { status: 'duplicate' }
FAIL V1 compares instant values across timestamp formats ('orphan')
expected { status: 'duplicate' } to match object { status: 'orphan' }

FAIL V1 OpenCode repeats idle only after new activity, while preserving the first unmatched idle
expected ... to have a length of 1 but got 2

Test Files 2 failed (2)
Tests 13 failed | 6 passed | 15 skipped (34)
```

6 个通过的负控制证明：真正缺开始的四 Provider Stop 仍保存 orphan，Pi/OpenCode 不使用未经确认的 stop_hook_active 字段。15 个 skipped 来自本次 `-t V1` 过滤，不是新增 skip。

首次编写 Claude 两例时，fixture 引用了不存在的 transcript，导致尚未提交 record 的前置断言失败；随后补上临时目录内的真实形状 user/assistant transcript，而不是修改生产逻辑或削弱断言。修正 fixture 后重复测试，得到上面的真正 orphan/duplicate 失败，再单独提交测试。修复后首轮这两个文件 34/34 通过；补充插件 idle/retry/失败分发控制后再执行下方完整验证，全部通过。

### 最终验证

环境：macOS Darwin arm64、Node v24.18.0、Vitest 3.2.7。测试只写 mkdtemp 临时 workspace；没有真实 Provider 调用或付费探针。

| 检查 | 结果 | 本机日志 |
|---|---|---|
| focused（下方命令） | 6 文件、233 测试通过 | `/tmp/scry-V1-focused.log` |
| `npm run typecheck` | node/web 均通过 | `/tmp/scry-V1-typecheck.log` |
| `npm run build:cli` | 通过，仅生成仓库内 ignored 产物 | `/tmp/scry-V1-build.log` |
| `npm run test:shell` | PASS setup-scry-workspace | `/tmp/scry-V1-shell.log` |
| `npm run test:unit` | 322 文件通过、4 跳过；3913 测试通过、4 跳过 | `/tmp/scry-V1-unit.log` |
| `git diff --check` | 通过 | 提交前执行 |

```sh
npm run test:unit -- src/core/turn-recorder/recorder-terminal-replay.test.ts src/core/turn-recorder/recorder.test.ts src/core/turn-recorder/recorder-durability.test.ts src/core/turn-recorder/hook-diagnostics.test.ts src/cli/workspace-init.test.ts src/cli/scry.test.ts
```

全量的 4 个跳过仍是 performance-correlation、billing-admin-real、p0-integration、p1-integration。没有原有失败，也没有删除断言、扩大超时或新增 skip。旧 A2/A3 回归、缺开始 Stop、SessionEnd 幂等、daemon 快路径命令数和 trust 测试均继续通过。

### 核验交接与限制

- A1 改回待核验，A2/A3 保持已核验。请审查方复跑 `7ced5ba5` 的失败测试及修复后的 focused；本次不要求扩大 orphan-only 范围。
- 真实 Provider 验证仍由用户执行：使用前文的独立临时项目和分支 CLI。Qoder/Codex 正常一轮后观察后续续跑终态不再增加 missingStartTerminals；OpenCode repair 后完成一轮、保持空闲，再发送新 prompt，确认重复 idle 不新增 orphan，第二轮仍新增 record。真正抑制开始 hook 的 A-3 步骤仍应产生 orphan。不要用已接受的旧版本手验结果代替本次版本。
- Linux/Node 20/22、本机真实 Provider 版本和插件重载后的事件序列未在本轮验证。OpenCode 的重载/缓存淘汰会失去重复证明，选择保留未知终态而非静默丢弃；若实际出现频繁淘汰误报，再测量并决定是否需要持久化终态身份，不在本次扩展。
- V3 的历史 skip 告警策略保持原样。无额外待用户选择的实现分歧；执行方到此停止，等待 V1 核验，不启动 B。

## V1 核验意见（审查方，2026-10-25）

核验对象：`6097bbfc`（生产代码 `82f6e5e3`）。环境：Linux x86_64，Node 22.22.0。

- 在 `7ced5ba5`（只有 V1 测试）上跑 `-t V1`：13 失败 / 6 通过，与报告一致。
- 修复后 6 个 focused 文件 233/233 通过。
- 全量 `npm run test:unit`：3905 通过，7 失败，全部在本批未改动的文件里（`owned-app-processes`、`db-outbox`、`MarkdownLayout`、`SessionRename`、`desktop-client`、`desktop-directory-picker`）。原因是审查环境以 root 运行（「不可读目录」类断言对 root 不成立）、没有 Chromium，以及 TLS 环境差异；执行方在 macOS 上全量通过。recorder 与 CLI 相关测试在 Linux 上全部通过。
- 读了 `recorder.ts` 与 OpenCode 插件的 diff：SessionEnd 无 open turn 直接 duplicate；`stop_hook_active` 只对给出合同依据的三个 Provider 生效，且要求严格 `=== true`；OpenCode 去重有 128 上限，投递失败不进入去重集合，首次未知 idle 仍投递。这些都符合要求。

接受的取舍：用户中途关掉会话、且这一轮的开始事件恰好也丢了时，唯一的信号是 SessionEnd，现在会被判 duplicate。这种情况需要两个故障同时发生，代价可以接受。

**结论：A1 已核验，批次 A 全部通过。** V3 仍等用户决定。可以开始批次 B。
