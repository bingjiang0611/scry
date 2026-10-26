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
