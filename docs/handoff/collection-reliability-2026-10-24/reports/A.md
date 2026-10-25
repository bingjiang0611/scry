# 批次 A 执行报告（待核验）

范围：仅 A1/H1、A2/H2、A3/L2。分支 `reliability/collection`，起点 `531adf84`。未开始 B/C/D/E，未合入、未开 PR、未安装分支 CLI 或 App。

## 结论与提交

| 条目 | 结果 | 证实测试 commit | 修复 commit |
|---|---|---|---|
| A1 / H1 | **部分**：缺开始终态不再静默丢弃；保留有界 orphan、health 和日志。没有实现 transcript 自动重建 record，见下方决定项 | `258cacaf` | `fc2061b1` |
| A2 / H2 | **已修复**：文档列出的跳过分支和 CLI 非零退出留痕，invalid_config 单独诊断；managed 也保持退出 0 | `d55b1779` | `73554d09` |
| A3 / L2 | **已修复**：初始 open/session 和终态 closing 等待文件及父目录 fsync，中间工具事件不增加 fsync | `4361a596` | `eb5a0e52` |
| A2 自审补充 | **已修复**：invalid_config 日志不得沿已拒绝的 `.scry` 符号链接写到工作区外；shell 同样保护 | `83244154`（对 `eb5a0e52` 失败） | `25f9382a` |

本地 pre-commit 禁止提交任何完整文件超过 20 KB，交接指定的既有文件多数超限。首次测试提交被拒绝后，用户明确选择“仅本批豁免”。各提交使用一次性 `git -c core.hooksPath=/dev/null commit`；未修改门禁脚本或持久 Git 配置。此豁免只涉及开发仓库的文件大小检查，**不涉及 recorder commit callback 的 trust/fingerprint gate**。

## 旧实现上的失败证据

以下为实际失败输出节选；临时目录缩写为 `<tmp>`，ANSI 颜色已省略。测试提交均先于对应修复。

### A1

```sh
npm run test:unit -- src/core/turn-recorder/recorder.test.ts -t 'missing-start|orphan tool payload'
```

```text
FAIL missing-start claude Stop preserves bounded payload once instead of claiming duplicate
FAIL missing-start codex Stop preserves bounded payload once instead of claiming duplicate
FAIL missing-start qoder Stop preserves bounded payload once instead of claiming duplicate
FAIL missing-start opencode Stop preserves bounded payload once instead of claiming duplicate
AssertionError: expected { status: 'duplicate' } to match object { status: 'orphan' }

FAIL missing-start after a committed turn is not proved duplicate by session identity alone
AssertionError: expected { status: 'duplicate' } to match object { status: 'orphan' }

FAIL orphan tool payload respects capture policy and byte limits
AssertionError: expected undefined to match object { storage: 'truncated', …(2) }
Tests 6 failed | 142 skipped (148)
```

在仅加入这些测试的旧生产实现上也跑了全量：`1 failed | 318 passed | 4 skipped` 个文件，`6 failed | 3871 passed | 4 skipped` 个测试。失败只有上述新增测试，未发现原有失败。

### A2

```sh
npm run test:unit -- src/cli/workspace-init.test.ts src/cli/scry.test.ts -t hook-skip
```

```text
hook-skip cli_path_missing / node_bin_dir_missing / cli_not_executable /
managed_cli_invalid / cli_failed:
ENOENT: no such file or directory, open '<tmp>/.scry/logs/hook-skip.log'

hook-skip managed_cli_failed:
AssertionError: expected 17 to be +0

hook-skip status / bundle:
expected ... to match object { hookSkips: { count: 2, ... } }
hook-skip doctor:
AssertionError: expected +0 to be 5
hook-skip invalid_config:
ENOENT: no such file or directory, open '<tmp>/.scry/logs/hook-skip.log'

Test Files 2 failed (2)
Tests 10 failed | 49 skipped (59)
```

自审追加控制：

```sh
npm run test:unit -- src/core/turn-recorder/hook-diagnostics.test.ts
```

```text
FAIL invalid-config diagnostics do not bypass the rejected dataDir symlink boundary
Expected: KEEP\n
Received: KEEP\n2026-10-24T15:55:13.060Z\tcodex\tStop\tinvalid_config\t0\n
Tests 1 failed | 1 passed (2)
```

### A3

```sh
npm run test:unit -- src/core/turn-recorder/recorder-durability.test.ts
```

```text
SCRY_DURABILITY_L1 {"event":"Stop","managed":false,"start":5,"intermediate":2,"closing":5,"recovery":8,"total":20}
SCRY_DURABILITY_L1 {"event":"SessionEnd","managed":false,"start":5,"intermediate":2,"closing":2,"recovery":8,"total":17}
SCRY_DURABILITY_L1 {"event":"Stop","managed":true,"start":5,"intermediate":2,"closing":5,"recovery":0,"total":12}
FAIL fsync start and closing boundaries ('Stop', managed=false), not intermediate hooks
FAIL fsync start and closing boundaries ('SessionEnd', managed=false), not intermediate hooks
FAIL fsync start and closing boundaries ('Stop', managed=true), not intermediate hooks
AssertionError: expected [] to have a length of 1 but got +0
Tests 3 failed (3)
```

软断言继续检查同一个用例的所有屏障：初始 `open.json`、`session.json` 的文件/目录 sync 和 closing 的文件/目录 sync 均缺失。软断言仍使测试失败，不是跳过断言。

## 改动后的行为

### A1：从静默 duplicate 到可查询 orphan

涉及 `src/core/turn-recorder/{recorder,store}.ts`。

- 没有 open turn 时，只有已提交 Provider turn ID，或同 Provider/session 的最后一条正式 record 的明确终态时间窗口，才能证明 duplicate。只有 session 存在不够；更晚终态或无身份、无时间的终态保留为 orphan。
- 已有重复 Stop、SessionEnd、process.exit 的正常幂等测试继续通过。
- 缺开始的终态保存到 `<dataRoot>/runtime/<provider>/<safeKey(session)>/orphans/<stableHash(event,payload)>.json`。不再只保留 event 名。
- `reason: missing_start`；`payload` 是已有 ToolContent envelope，含 `storage`、`encoding`、`savedBytes`、`content`、`reasons`。正文仅在 prompt、assistant、完整工具采集都启用时保存；否则 `storage: omitted`，顶层 `omissionReason: capture_policy`。超限为 `truncated/json-fragment`，不声称完整 JSON。
- payload 字节预算取 field/turn 上限较小值；未配置或 unlimited 时，本诊断副本仍使用 8 KiB field / 128 KiB turn 的有界默认。大 payload 不保证完整保留；不把诊断副本当 canonical transcript。
- `health.json` 增加 `missingStartTerminals`，同时增加 `orphanEvents`；旧 health 文件兼容默认 0。`recorder.log` 包含 provider/event、原因和 orphan ID，不记录 payload。
- 无 open turn 和 turn ID 不匹配的工具 orphan 共用上述保存逻辑。相同 payload 重放复用同一文件，不重复计数；recover 重入不生成 record。
- orphan 文件先原子且 sync 落盘，再更新 health/log。三者不是跨文件事务；若在两者间崩溃，orphan 是可查证据，计数/日志可能少于文件数，不宣称精确审计。
- **未生成降级 record**，所以没有新增 record schema/endReason，也没有编造 token、duration 或 diff。升级 CLI 即可生效。

#### transcript 重建判断（代码阅读，不是真实 Provider 验收）

| Provider | 当前可用依据与边界 | 本批处理 |
|---|---|---|
| Claude | `parseTranscriptSnapshot` 依赖 pinned turn ID/promptHash；都缺时退到最后一轮，不能证明就是迟到 Stop 所属轮 | orphan，不用 `.at(-1)` 猜轮次 |
| Codex | rollout 可按明确 turn ID 定位；无 ID/hash 时同样取最后一轮。**有权威 ID 的情形有继续重建的技术基础，未在本批实现或宣称不可能** | orphan；ID 匹配的降级重建留给用户决定 |
| Qoder | 普通 transcript 选择也依赖 ID/hash；credits 还要求 Hook 的权威 ID，prompt 不能替代计费身份 | orphan，不补猜测值 |
| OpenCode | 插件把 `session.idle` 映射为 `Stop`；payload 是会话/assistant/观测 usage，没有 transcript 路径及可靠轮首时间 | 按真实 `Stop` 事件测试并保存 orphan |
| Pi | 共用核心无 open turn 的处理；本批未另做 Pi 专项真机/Provider 验收 | 不宣称能力齐平 |

### A2：跳过分支留痕与诊断

涉及 `src/cli/{workspace-init,scry,support-bundle}.ts`、`src/core/turn-recorder/{hook-diagnostics,config,recorder}.ts`。

- 固定 bootstrap 日志位置为工作区 `.scry/logs/hook-skip.log`，不依赖可能已损坏的配置或自定义 dataDir。
- TSV 五列：UTC 时间、provider、event、原因码、CLI 返回码。原因包括 `cli_path_missing`、`node_bin_dir_missing`、`cli_not_executable`、`managed_cli_invalid`、`cli_failed`、`managed_cli_failed`、`payload_read_failed`、`invalid_config`。前两种是路径文件无法读取，第三种是文件中指定的 CLI 不可执行。
- shell 追加用内建 `printf`；`mkdir`/`date` 只在失败分支执行。daemon 成功快路径的受控命令探针只有原来的 `dirname → cat → curl`，新增进程数为 0。这里使用临时 socket 和返回 200 的 curl fixture，不等同真实 daemon 网络端到端验收。
- managed 不再 `exec` 丢掉控制权；保留 CLI 原始退出码用于日志，对 Provider 始终 exit 0。CLI 回退同样记录非零返回码。
- `invalid_config` 在 hook 核心路径单独写日志；`.scry-disabled`、环境禁用和 `enabled:false` 的判定顺序不变。
- `recorder status`、`doctor`、support-bundle 增加 `hookSkips: { count, lastAt, scope: retained_log_window, truncated }`。只汇总保留窗口，不冒充历史累计。support-bundle 不输出 hook payload 或任意原始日志字段。
- 有 skip 时 doctor 顶层 `status:error`、check `hook.skips:fail`、退出 5；invalid_config 为 `status:error`、退出 3。既有健康 schema 测试增加新 check ID，保留所有旧 check 和断言。
- shell 只追加；CLI 诊断超过 1 MiB 时轮转一代，每代只读末尾 1 MiB，截断显式标记。**这是软阈值，不是硬磁盘配额**：CLI 不可执行且无人运行诊断时，文件会继续增长；轮转后的旧代也可能超过 1 MiB，但读取有界。
- 拒绝沿诊断存储符号链接写入；诊断读取遇到符号链接会明确失败。无可写日志目录、根目录无法解析、文件系统失败等情况下，无法保证落痕，仍优先遵守 fail-open。
- 没有增加 CLI 自动回退；不破坏显式 `SCRY_CLI_PATH` 不回退 PATH 的约定。
- **shell 变化需要 `scry integrations repair --yes`**。存量脚本会报 outdated。invalid_config 核心留痕和 CLI 诊断只需升级 CLI。

### A3：持久化边界与 L1 计数

涉及 `recorder.ts`，独立测试 `recorder-durability.test.ts`。真实调用 FileHandle.sync 后计数，不用“设置了 sync 参数”冒充执行。负载是临时 workspace、diff 关闭、一个 start、一个工具事件、一个终态；非 managed 再执行 recover。

| 场景 | start 前→后 | 工具事件前→后 | closing 前→后 | recover 前→后 | 合计前→后 |
|---|---:|---:|---:|---:|---:|
| Claude Stop | 5→9 | 2→2 | 5→7 | 8→8 | 20→26 |
| Claude SessionEnd | 5→9 | 2→2 | 2→4 | 8→8 | 17→23 |
| managed Stop（仅 lifecycle，不含 App canonical 提交） | 5→9 | 2→2 | 5→7 | 未执行 | 12→18 |

新增的 6 次是必要持久化工作：初始两份状态各 file+directory（4），closing 的 file+directory（2）。普通终态、managed 终态、stale-terminal deferred closing 都改为 sync；其余中间状态保留原样。没有删除 fsync、没有放宽门限。不是性能优化，不给出 L2 毫秒或 L3 日常性能结论；没有执行断电/内核崩溃试验。升级 CLI 即可生效。

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
