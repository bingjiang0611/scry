## 验证与首次失败记录

环境：macOS Darwin arm64，Node `v24.18.0`，Vitest `3.2.7`。最终生产代码为 `25f9382a`；无真实 Provider 调用。新测试均使用 mkdtemp workspace，清理临时目录，不写开发仓库或用户日常 `.scry`。

| 检查 | 最终结果 | 证据 |
|---|---|---|
| focused | 5 文件 / 214 测试通过 | 下方完整命令；`/tmp/scry-A-focused-final2.log` |
| typecheck | node + web 均通过 | `npm run typecheck`；`/tmp/scry-A-typecheck-final2.log` |
| CLI 构建 | 通过；仅本仓库 ignored dist/out | `npm run build:cli`；`/tmp/scry-A-build-cli-final2.log` |
| shell | `PASS setup-scry-workspace` | `npm run test:shell`；`/tmp/scry-A-shell-final2.log` |
| 最终全量 unit | 321 文件通过、4 跳过；3894 测试通过、4 跳过 | `npm run test:unit`；`/tmp/scry-A-unit-final2.log` |
| diff | `git diff --check` 通过 | 各代码提交前检查；未改 trust/指纹实现、inbox 删除/recover 循环或其他批次 |

```sh
npm run test:unit -- src/core/turn-recorder/recorder.test.ts src/core/turn-recorder/recorder-durability.test.ts src/core/turn-recorder/hook-diagnostics.test.ts src/cli/workspace-init.test.ts src/cli/scry.test.ts
```

四个既有跳过：`performance-correlation`、`billing-admin-real`、`p0-integration`、`p1-integration`，未启用费用/账号探针，未新增 skip。全量不含真实 Provider 验收。

迭代失败未隐藏：

1. A1 最初新增测试有一处直接用 session 字符串定位 runtime，出现 ENOENT；按已有 `safeKey` 修正 fixture 后，旧实现稳定为 6 个真正合同失败，再提交测试。
2. A1 首次修复后 145/148 通过：Provider 对比误用了对象而不是 `provider.id`，且时间判断过窄。修正对象字段后剩 1 个旧重复 Stop 测试失败；使用正式 record 的明确时间窗口后 148/148 通过。没有修改这些旧断言。
3. A2 首次修复后 57/59 通过：doctor 的既有精确 check 列表需要新增 `hook.skips`；脚本首条注释出现 curl 字样误触原有顺序断言。同步 schema 断言、调整注释后 61/61（含新增快路径/轮转测试）通过。
4. A3 旧实现先失败 3 个测试；改用软断言展示所有缺失屏障后仍失败 3 个。相同计数负载修复后通过。
5. 首轮最终全量为 3892 通过、4 跳过；随后自审增加符号链接负控制，证明 A2 新日志路径会写到拒绝的目标。修复后重新执行 focused、typecheck、build、shell 和全量；最终为上表的 3894 通过。未把首轮结果当最终版本证据。

## 用户验证：OpenCode / Qoder / Codex

**以下尚未执行，由用户在三个 Provider 上分别确认；会产生真实 Provider 用量。只在新的临时仓库操作，不安装到日常前缀。** 按 [USER-VERIFY.md](../USER-VERIFY.md) 的 A 节展开；不执行其为 C3 收集信息的 A-5，避免扩批。

在专用测试终端、Scry 仓库的本分支运行（本报告源码已构建；若之后更新分支需重建）：

```sh
npm run build:cli
export SCRY_A_CLI="$PWD/packages/turn-recorder-cli/dist/cli/scry.js"
export SCRY_A_WORKSPACE="$(mktemp -d /tmp/scry-verify-A.XXXXXX)"
git -C "$SCRY_A_WORKSPACE" init -q
cd "$SCRY_A_WORKSPACE"
node "$SCRY_A_CLI" init --providers codex,qoder,opencode
node "$SCRY_A_CLI" integrations repair --yes
# 从本终端启动 Provider，确保失败注入不被已在线 daemon 的 curl 路径绕过。
export SCRY_RECORDER_TRANSPORT=direct
unset SCRY_RECORDER_MANAGED SCRY_CLI_PATH SCRY_RECORDER_ENABLED
```

Codex 按其原生 `/hooks` 信任要求启用本临时项目；Qoder/OpenCode 按各自项目集成加载方式重新启动。不要更改全局 Provider 配置或绕过信任。

### A-1 正常采集

分别启动三个 Provider 的**新会话**，发一个简单请求，例如“只回答 OK，不修改文件”。终态后：

```sh
node "$SCRY_A_CLI" recorder recover
node "$SCRY_A_CLI" turns list
node "$SCRY_A_CLI" doctor
```

预期：每个 Provider 本轮各增加一条 record；初始干净 workspace 没有 hook-skip 日志/`hookSkips.count=0`。若不满足，先报告加载/信任状态，不把未采到事件等同采集器通过。

### A-2 CLI 失效仍 fail open

```sh
cp .scry/cli-path .scry/cli-path.before-A
printf '%s\n' '/does-not-exist/scry-A' > .scry/cli-path
```

在三个 Provider 各跑新一轮。预期 Provider 正常完成、不出现 Scry 非零退出错误；`.scry/logs/hook-skip.log` 出现 `cli_not_executable`（与模板的泛称 cli_path_missing 区分）。若删除路径文件本身，则应为 `cli_path_missing`。

```sh
node "$SCRY_A_CLI" recorder status
node "$SCRY_A_CLI" doctor
node "$SCRY_A_CLI" support-bundle create --out "$SCRY_A_WORKSPACE/support-A.json"
mv .scry/cli-path.before-A .scry/cli-path
```

预期汇总 count/lastAt 可见，doctor 为 error/退出 5；payload 不出现在 hook-skip 日志或汇总中。CLI 诊断使用保留的绝对路径，不依赖损坏的 cli-path。

### A-3 精确抑制开始事件，不靠手速切路径

备份并在**临时项目**放置测试包装器；三个 Provider 最终都调用此 bridge，OpenCode 的 session.idle 发的是 Stop。

```sh
cp .scry/provider-hook.sh .scry/provider-hook.real.sh
cat > .scry/provider-hook.sh <<'SH'
#!/bin/sh
[ "${2:-}" = 'UserPromptSubmit' ] && exit 0
exec "$(dirname "$0")/provider-hook.real.sh" "$@"
SH
chmod +x .scry/provider-hook.sh .scry/provider-hook.real.sh
```

各 Provider 新开会话、跑一轮，随后 recover。预期：缺开始的终态保存为 `reason:missing_start` orphan，health 的 `missingStartTerminals` 增加；默认 full capture 下 payload envelope 有内容或明确截断。本实现**预期没有重建 record**。工具事件也可能成为 orphan，所以 `orphanEvents` 总增量不必恰好等于 1。不要把旧会话已有 record 当本次新增。

检查 `.scry/runtime/<provider>/*/orphans/`、`.scry/health.json` 和 `.scry/logs/recorder.log`。可重复向同一 bridge 输入同一个 Stop payload；同一哈希文件和计数不应重复增加。不要分享原始 payload，它可能含敏感内容。

```sh
mv .scry/provider-hook.real.sh .scry/provider-hook.sh
node "$SCRY_A_CLI" integrations repair --yes
```

### A-4 invalid_config 与恢复

```sh
cp scry.config.json scry.config.before-A.json
printf '%s\n' '{invalid-json' > scry.config.json
```

在每个 Provider 各跑一轮。预期 Provider 继续工作；hook-skip 日志有 `invalid_config`，doctor error/退出 3。恢复配置后再跑正常轮次，确认 record 重新增长：

```sh
mv scry.config.before-A.json scry.config.json
node "$SCRY_A_CLI" doctor
```

已有失败日志仍会让 doctor 报 error/退出 5，这是**保留窗口历史告警**，不等同恢复失败。先保存诊断；需清除告警时，仅在临时目录移走 `.scry/logs/hook-skip.log` 及存在的 `.1`，再确认健康。不要删除 records 来清告警。

回报格式：Provider、步骤编号、通过/不通过、record 数量变化、missingStartTerminals 增量、hookSkips count/lastAt、doctor 状态/退出码。不要回传 prompt/assistant/tool 原文。结束后退出这些测试 Provider；保留临时目录供审查，用户确认无需取证后再删除。以上未安装日常 CLI，无需重启日常 App。

## 未验证与留给用户决定的事

1. **A1 部分交付是否接受**：静默丢整轮已改成可查 orphan，但没有自动重建 record。Codex 有权威 turn ID 时存在可复用解析能力；如果验收要求本批必须生成降级 record，请审查方标“需修改”，由执行方补 A1 专项测试与实现，不进入 B。当前不把“没做重建”说成“无法重建”。
2. **日志软阈值**：本批沿用“shell 只追加、CLI 轮转”的方向。若必须在 CLI 已损坏且永不运行诊断时仍限制磁盘，需要另定 shell 计数/轮转策略；当前不引入额外快路径进程或配置。
3. **真实 Provider/平台矩阵**：用户执行上方 OpenCode/Qoder/Codex 手验；Linux、Node 20/22、GUI PATH、nvm/fnm/volta/Homebrew 切换、约 18–19 子仓库真实工作负载未专项验收。全量现有 nested Git fixture 通过，不冒充该规模实测。
4. **持久化上限**：仅验证 fsync 调用及既有临时目录恢复测试，未验证掉电后的文件系统结果；orphan/health/log 之间非事务。存储不可写、符号链接被拒绝、workspace 无法定位时只能保持 fail-open，不能承诺必有日志。
5. 审查方核验本报告及真实 Provider 回报后决定 A 的接受范围。执行方到此停止；**B 必须等 A 核验，不自动继续**。

本机验证日志保留在 `/tmp/scry-A-*.log`；测试临时目录由 fixture 清理，无本批启动的长期 Provider/daemon。构建产物只在本仓库 ignored 的 `out/`、`packages/turn-recorder-cli/dist/`，未全局安装、未发布。

## 核验意见（审查方，2026-10-24）

核验对象：`fc0aa87a`（生产代码 `25f9382a`）。环境：Linux x86_64，Node 22.22.0，与执行方的 macOS / Node 24 互补。

已复跑：
- 5 个 focused 文件 214/214 通过；`npm run typecheck` 通过。
- 在 `258cacaf`（只有 A1 测试、无修复）上跑 `-t 'missing-start|orphan tool payload'`：6 个失败，与报告一致，证实测试有效。
- 逐行读了 `recorder.ts`、`store.ts`、`hook-diagnostics.ts`、`workspace-init.ts`、`scry.ts` 的 diff。

结论：**A2、A3 已核验；A1 需修改（一个误报问题），orphan-only 范围本身接受。**

### V1（需修改）A1：正常的会话结束和续跑 Stop 被计成 missing_start

真实 Claude hook payload 没有 `timestamp` 字段（fixture 里的 `payload()` 总是带 timestamp，所以现有测试覆盖不到）。新逻辑在没有 open turn 时，只有拿到 turn ID 或显式时间戳才判 duplicate，否则一律 orphan + `missingStartTerminals++`。

复现（临时探针，未提交）：Claude `UserPromptSubmit` → `Stop` → `recover` 提交 1 条 record，然后：
- `SessionEnd`（`{ session_id, hook_event_name, reason: 'exit' }`）→ `orphan`
- `Stop`（`stop_hook_active: true`，续跑）→ `orphan`

结果 `missingStartTerminals: 2`、`orphanEvents: 2`，`lastError` 被改写为 orphan，但实际**没有丢任何数据**。每个正常退出的 Claude 会话都会产生一次这样的误报，计数会失去意义，并且掩盖真正的问题。

修改要求：
1. `SESSION_END_EVENTS` 在没有 open turn 时，说明会话在两轮之间结束，这是正常情况，不能当作缺开始的证据。返回 `duplicate`（或新增一个不计数的状态），不写 orphan，不加计数。缺开始的那一轮如果存在，它的 Stop 已经单独被记成 orphan 了。
2. Claude 的 `stop_hook_active: true` 是对已有一轮的续跑，没有 open turn 时同样不算缺开始。请执行方确认其他 Provider 有没有类似的「同一轮重复终态」信号（例如 OpenCode 的 `session.idle` 在空闲期间是否会重复触发），有的话一并处理，没有就在报告中写明。
3. 时间窗口比较改用 `Date.parse`，不要直接比较字符串：`terminalAt >= record.startedAt` 在两边格式不一致时会出错（`explicitTimestampOf` 已规范化，但 record 字段来源不同，不要依赖这一点）。
4. 补回归测试，使用**不带 timestamp 的真实形状 payload**：正常一轮之后的 SessionEnd、`stop_hook_active: true` 的 Stop，断言 `missingStartTerminals` 为 0；同时保留现有「缺开始的 Stop 记为 orphan」的测试。

### V2（接受）A1 orphan-only 范围

接受不做 transcript 重建。理由：目标是「不再无痕丢失」，orphan 已保留 payload（含 `transcript_path`），事后可以离线重建；而在线重建在没有轮首身份时容易把别的轮次内容归到这一轮，违反证据诚实。Codex 有权威 turn ID 时的降级重建，作为可选的后续项，等用户手验后再决定要不要做。

### V3（不阻塞，留给用户决定）A2：doctor 对历史 skip 永久报 error

只要保留窗口内有一条 skip，`doctor` 就一直是 `error` / 退出 5，修复之后也不会恢复，除非手动移走日志。建议改成按时间分级（例如最近 24 小时内有 skip 报 error，更早的报 warn），这样修复后能看到恢复。是否要做由用户决定，可以和 V1 一起改。

### V4（记录）managed 分支从 `exec` 改为子进程

managed 分支原来用 `exec` 让 CLI 替换 shell，现在 shell 会留下来等待 CLI 返回。宿主超时杀掉 shell 时，CLI 子进程不一定被一起杀掉，会继续跑完。这不会丢数据，只是行为有变化，记录在此，不要求修改。

### 下一步

执行方只修 V1（V3 视用户决定），在本报告末尾追加「V1 修改记录」，STATUS 中 A1 改回 `待核验` 后 push。B 继续等待。
