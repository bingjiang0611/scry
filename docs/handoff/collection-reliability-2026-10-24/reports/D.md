# 批次 D 修改记录（待核验）

分支 `reliability/collection`；基线 `ffbc022e`。仅 D1 → D2，未开始 E。D1、D2 均已修复到自动化/本地 CLI fixture 范围；真实 OpenCode / Qoder / Codex 手验留给用户。

## 结论与提交

| 条目 | 结论 | 证实测试提交 | 修复提交 |
|---|---|---|---|
| D1 | 已修复：深度截断不再静默，record 降级并保留原因，doctor 有界探测下一层 | `d1321fe5` | `acddcc75` |
| D2 | 已修复：同毫秒的不同仓库快照不再被合并，保留发现清单和每个请求的真实结果 | `8b82f9cd` | `0febe9e7` |
| D2 附项 | 已修复：用户级 bridge_not_found 单独进入 doctor/bundle；hook 入口清除继承的内部标记 | 同上 | 同上 |

### 经用户授权的前置拆分

用户选择“按职责拆分”“先拆分再做 D”。前置提交 `1e3c269e`；20 KB 门禁及 hooks 配置未改，未绕过。

- recorder 按生命周期、解析、trace、轮次和 hook 职责拆分；原入口与单一 cache owner 保留。CLI 按命令/集成拆分；独立 CLI tsconfig 使用原有两个入口，私有 recorder 构建入口不变。
- 原 43 KB CLI 测试按命令拆分，原 46 项保留；精确 checks 列表只增加新检查项。
- shared 按合同、usage、diff、校验拆分。扩展字段前 AST 检查原 136 个声明完全一致；之后仅合同/normalizer/校验有预期改变，无丢失/重复声明或检测到的运行时循环。
- 原 46 KB CLI README 的详细章节移到包内三份文档，原章节与 Retry 锚点保留。npm files 加入 docs，dry-run 证明入包，相对链接检查通过。

## 旧实现的失败证据

以下是实际输出节选（去掉 ANSI 颜色），不是推演结果。测试使用 `mkdtemp` 工作区，不写日常 `.scry`。

### D1：3 个失败

```text
npm run test:unit -- src/core/turn-recorder/repository-coverage.test.ts

→ expected [ Array(1) ] to match object { …(3) }
→ expected undefined to deeply equal { maxDepth: 2, …(1) }
→ expected { status: 'available', …(3) } to match object { status: 'partial', …(2) }
→ expected undefined to match object { status: 'warn', …(1) }

Test Files  1 failed (1)
Tests       3 failed (3)
```

真实临时 Git 夹具包含 `root/a/b/c/.git`，旧实现只有根快照且无缺口提示。旧全量 **3 failed / 3953 passed / 4 skipped**，失败均为新测试。日志：`/tmp/scry-D1-before.log`、`/tmp/scry-D1-test-unit.log`。

### D2：10 个失败

```text
npm run test:unit -- src/cli/user-hook-diagnostics.test.ts src/cli/hook-environment.test.ts src/core/turn-recorder/repository-snapshots.test.ts

× retains every discovered repository and its captured/timeout/failed outcome even at the same timestamp
  → expected 'available' to be 'partial' // Object.is equality
× keeps user-global bridge failures separate from workspace counts in doctor and support bundles
  → expected undefined to match object { status: 'available', …(2) }
× clears an inherited daemon-attempt marker before any hook branch (false, '')
  → expected '1' to be null

Test Files  3 failed (3)
Tests      10 failed (10)
```

6 个用户级日志测试、3 个真实 shell 标记测试、1 个 canonical record 测试失败。旧全量 **10 failed / 3959 passed / 4 skipped**，没有额外失败。日志：`/tmp/scry-D2-before.log`、`/tmp/scry-D2-test-unit.log`。

仓库结果测试真实执行发现、正常仓库 Git 捕获、终结、聚合、commit 和读取 record；只在 `beginGitTurnDiff` 边界注入另两个请求的 timeout/deadline、failed/git_error，且它们没有 repoRoot。仅固定 Date，使三份 snapshot 同时结束。旧通用 harness 去重键不含仓库身份，错误结果被合并掉，diff 误报 available。因此不能按“字段已有、不改”交付。

实现中另有两次先失败后修正的补充检查：

- 未加入 `diff.discovery` 前，正常轮次与 stalled closing 的清单断言 **2 failed / 5 passed**（`/tmp/scry-D2-discovery-before.log`）。不能从不可用 diff 的空值推断发现了零个仓库。
- 自审发现“截断后可见 tail 恰好没有 bridge 行”仍显示 pass。补测得到 `Expected: "warn", Received: "pass"`，**1 failed / 9 passed**（`/tmp/scry-D2-truncated-before.log`）；修为 partial 窗口始终 warn，未弱化断言。

## 改动后的行为与证据位置

### D1：深度边界

`config.ts` 的发现结果新增 `maxDepth`、`depthLimitedDirectories`。后者只统计达到边界而未继续扫描的目录，不猜测漏掉的仓库数量。默认 2、上限 5 不变；默认 hook 发现路径不增加下一层扫描。

开始状态写入 `.scry/runtime/<provider>/<session-key>/open.json.repositoryDiscovery`。终结时若有截断，已有 available diff 改为 partial/inferred，`omissionReason` 包含 `maxDepth=N` 和截断目录数，source 增加 `repository_discovery`。已有 unavailable/disabled 不被抬升，原原因和已捕获快照保留。

`doctor.checks[id=repositories.depth]` 额外查看 depth+1 一层，最多 32 个边界目录、128 个目录项；超限/读失败说明 probe incomplete，不声称扫描完整。不自动改配置；提示显式设置 maxDepth/exclude。这是范围 warning，不改变既有退出码。

### D2：每轮清单和结果

canonical 事实源仍是 `.scry/records/`；用 `scry turns show <recordId>` 读完整 record：

| 字段 | 含义 |
|---|---|
| `diff.discovery.requestedRoots` | 本轮请求目录清单；长度不是磁盘全部仓库数或已确认 Git root 数 |
| `diff.discovery.maxDepth` / `depthLimitedDirectories` | 本轮观察到的发现策略/深度截断；没有发现证据时省略，不补 0 |
| `diff.value[].requestedRoot` | 已知请求目录，即使 Git baseline 失败仍能对应到请求 |
| `diff.value[].repoRoot` | 只有 Git 确实解析到时才有，不能用 requestedRoot 冒充 |
| `diff.value[].status` / `reason` | 原捕获层提供的 captured / timeout / failed / unavailable 及原因，保持原含义 |

去重键加入请求/解析仓库、scope、baseline 时间和 status；相同 snapshot 重放仍去重，不改变工具调用生命周期的计数。原 Promise.all 并发不变，没有修改 `git.ts`、并发值、deadline 或默认发现深度。

stalled closing 等不能可信归因 diff 的情况，仍为 unavailable，不补造每仓库快照/耗时；但已知 discovery 清单可以保留。历史记录和升级前未保存发现元数据的 open 不回填当前配置。共享校验拒绝非法 requestedRoot、重复清单、负截断数，并继续接受无新字段的旧 record。字段含义已同步 [CLI README](../../../../packages/turn-recorder-cli/README.md#多仓库覆盖与诊断)。

### D2 附项：用户级日志与入口标记

- 读取 `${XDG_STATE_HOME:-$HOME/.local/state}/scry/hook-skip.log` 和 `.1`，只统计 `bridge_not_found`。每份最多读尾部 1 MiB；只读，不轮转/改写用户日志。
- `doctor.userHookSkips`、`support-bundle.userHookSkips` 是独立 evidence，source 为 `user_global_hook_skip_log`。value 内包含 count/recentCount/lastAt/retained_log_window/truncated，以及 `reason: bridge_not_found`、`workspaceAttribution: unknown`。
- 不可读/受检路径为 symlink/无可用绝对 state 目录：unavailable，无伪造的 count=0。截断：partial，即使可见 count=0 也 warn。缺失日志：available + 空保留窗口，不证明 native hook 加载成功。
- `hook.userBridgeSkips` 的非空/不完整/不可用窗口只告警，不归罪当前 workspace，不合并到 workspace `hookSkips`、health 或退出码。时间不明的行仍计入 recentCount，但任意时间文本、原始用户日志不进入 bundle。
- 生成的 `provider-hook.sh` 在 `set -u` 后无条件执行 shell builtin `unset SCRY_RECORDER_DAEMON_TRIED`，再进入 managed/direct/socket 分支。在线快路径仍只有原 dirname/cat/curl 外部进程；C 的 wedged/stale socket 行为保留，shell 返回 0。
- OpenCode plugin 不使用 C3 的 shell bootstrap 日志；这里不伪造 Provider parity。

### 升级与 repair

D1、record 字段/去重、doctor/bundle 读取升级 CLI 后生效；运行中的 daemon 需在对应 workspace `scry recorder restart`。入口标记清理必须 `scry integrations repair --yes`，再重启 Provider；旧脚本会被 doctor 判 outdated。没有安装本分支 CLI 到日常环境。

## 验证记录

环境：macOS arm64、Node 24.18.0、Vitest 3.2.7；CLI 包版本仍 0.2.51，未升版本/发布。每项使用临时 workspace；新增 doctor fixture 同时隔离 HOME/XDG，不读写日常用户日志。

| 检查 | 实际结果 |
|---|---|
| 前置 refactor focused | 33 文件、525 passed；typecheck、CLI build、shell 通过 |
| D1 修复后 focused | 7 文件、205 passed；typecheck、CLI build 通过 |
| D1 提交前全量 `npm run test:unit` | 3959 passed / 4 skipped |
| D2 最终 focused（命令见下） | 43 文件、569 passed |
| `npm run typecheck` | node/web 都通过 |
| `npm run build:cli` | 通过；未构建/安装 App |
| `npm run test:shell` | PASS setup-scry-workspace |
| `npm run smoke:cli-package` | 最终构建通过：临时 npm 安装、bin、幂等 init、真实 shell hook 产 record、doctor、通知身份隔离和旧 cursor 保留 |
| 最后一次全量 `npm run test:unit` | **3972 passed / 2 failed / 4 skipped**；2 个原有测试 5 秒超时，见下；不报全量通过 |
| `npm run performance:measure -- --scenario source-control.diff --compare acddcc75 --out /tmp/scry-D2-performance` | ratchet 通过，git/total subprocess 都 8 → 8，无 worse；仅 L1 相邻 diff workload，不是发现/冷启动 L2 或 L3 |
| diff/门禁/文档 | diff --check、原 staged-file-size 门禁通过；三份包内文档入包，原章节与相对链接检查通过 |

最终 focused：

```bash
npm run test:unit -- src/core/turn-recorder/*.test.ts src/cli/*.test.ts src/shared/trace.test.ts src/shared/turn-record.test.ts
```

覆盖上述新增行为及 legacy record；同时保留 warm/stale/wedged、fsync、commit trust/通知回归。

### 实际构建产物 probe（不是真实 Provider）

`/tmp/scry-D-built-probe.mjs` 用当前构建 CLI、隔离 HOME/XDG 和临时 Git（一个 index 损坏）投递合成 Pi 事件，经 CLI 读回 record/doctor/bundle。最终日志 `scry-D-built-probe-final.log`：

```json
{"records":1,"diffStatus":"partial","requestedDirectories":2,"depthLimitedDirectories":1,"snapshots":[{"status":"captured","reason":null,"requestedRootKnown":true,"resolvedRootKnown":true},{"status":"failed","reason":"git_error","requestedRootKnown":true,"resolvedRootKnown":false}],"doctorStatus":"healthy","workspaceSkips":0,"userBridgeSkips":1,"bundleMatches":true,"userLogUnchanged":true}
```

实际坏 Git 保留 failed/git_error，未伪造 repoRoot；全局 warning 不改变 workspace health。probe/包 smoke 的临时目录与 npm prefix 已清理，原生 stop 后无匹配测试进程；未安装到日常环境。

### 首次失败与复查（未隐藏）

- 前置拆分的漏 import/重复类型已修正；旧 CLI wildcard 造成 TS6059，改为实际入口。只清理失败 build 生成的 50 个未跟踪 JS，未删用户文件。之后 type/build/focused 通过。
- 前置全量 4 failed / 3949 passed / 4 skipped：原 staged-size fixture 超时、原大 Unicode diff fixture、两个原 Pi menu-only fixture。定向 4 passed；之后 D1 红测全量所有原有 3953 测试通过。未改旧断言/超时。
- D2 第一轮全量 3 failed / 3970 passed / 4 skipped：原 hook-socket-path 的 long-path、relative override 两项和 transcript-archive cold indexing，均 5 秒超时。相同代码定向 3 passed。随后文档分发变更后的全量 3973 passed / 4 skipped，仍保留首轮记录。
- 补上截断空窗口 warn 后，最后全量 2 failed / 3972 passed / 4 skipped：`terminal-recording-history` 的 bounds pages / concurrent scans，以及 `performance-counters/files.counters` 的 sample 3，均 5 秒超时。失败文件和 terminal history 实现相对基线无改动；当时 load average 25.85/18.90/15.11（10 核）。不能据此证明每个超时的原因。
- 定向调用两项 test body 都通过，但最初按 `-t sample 3` 过滤违反 counters 的 afterAll“必须收齐三份 sample”合同，suite 因 1≠3 失败。随后完整运行该 counters 文件 **6 passed**；没有删断言或改超时。terminal history 目标已通过。最后全量仍记失败，不继续重跑求绿，不修这些原有用例。
- 新测试草稿的 realpath 别名与 stalled closing 状态已按真实合同修正，未放宽生产预期。

日志在 `/tmp/scry-D-refactor-*`、`/tmp/scry-D1-*`、`/tmp/scry-D2-*`。最终检查见 `scry-D2-verified-*`，包 smoke 见 `scry-D2-package-smoke-final.log`，中间绿色全量见 `scry-D2-final-unit.log`。四个 skip 沿用 performance-correlation、billing-admin-real、P0、P1；未开真实账号探针。

## 用户验证（待用户执行）

参考 [USER-VERIFY](../USER-VERIFY.md)。每个 Provider 分别准备独立临时 Git workspace、HOME/XDG/原生配置；明确选择账号与费用后才调用原生 Provider。不要复制整个 HOME、关闭 trust 或把本分支 CLI 全局安装。本次没有调用真实 Provider；隔离登录/入口不可用时停止留证，不回退到日常配置伪装通过。

### D-U1：准备多仓库夹具

在本分支运行 `npm run build:cli`，将生成的 `packages/turn-recorder-cli/dist/cli/scry.js` 绝对路径记为 `$CLI`。创建临时 `$RUN/workspace` 为 `$W`，隔离 HOME/XDG 放在其外；设置 `SCRY_AUTO_UPDATE=0 SCRY_NO_UPDATE_CHECK=1`，不改全局 PATH。

1. 创建并分别 `git init`、提交初始 README：`$W`、`$W/one`、`$W/a/b/c`。测试提交使用公开身份。根 `.gitignore` 排除 `one/`、`a/`、`.scry/` 和 `scry.config.json`，避免父仓库把子仓库当普通文件捕获。
2. 对当前 `$PROVIDER`（opencode/qoder/codex）执行：

```bash
node "$CLI" init --providers "$PROVIDER" --workspace "$W"
node "$CLI" integrations repair --yes --workspace "$W"
node "$CLI" recorder restart --workspace "$W"
node "$CLI" doctor --workspace "$W"
```

3. 确认 `scry.config.json` 的 `repositories.mode=discover-nested-git`、`maxDepth=2`、`capture.diff=true`；确认 `.scry/cli-path` 是上述绝对入口。原生 trust 提示由用户正常确认，不跳过指纹校验。
4. doctor 的 `repositories.depth` 应 warn 并提到 `a/b/c`，提示 maxDepth/exclude；不自动改变配置。

### D-U2：分别用 OpenCode / Qoder / Codex 完成一轮

在 `$W` 用隔离 Profile 启动 `opencode` / `qoder` / `codex`，请求“只在 one/README.md 和 a/b/c/README.md 各追加测试标记，完成后结束”。确认实际改动与 Provider terminal，记录 session/turn 身份，不能只看 exit 0。

```bash
node "$CLI" recorder recover --workspace "$W"
node "$CLI" turns list --workspace "$W"
node "$CLI" turns show '<本轮 recordId>' --workspace "$W"
```

在固定夹具无额外目录时：`diff.discovery.requestedRoots` 包含根与 one、不含深层 c；截断数 1；diff partial，原因含 maxDepth=2；健康 Git 的两份 snapshot 分别可见。深层 c 的实际改动不能被冒充已经采集。

OpenCode/Qoder 短轮次可能沿用已接受的 180 秒终态宽限；以 terminal/deferredTerminalAt 为准，宽限后 recover 再读回，不改短宽限、不把 pending 当作已成功或已丢失。若没有记录，先按 USER-VERIFY 检查真实 hook/插件是否加载，不把 CLI 合成 fixture 当作 native 手验。

### D-U3：显式扩大范围

仅把临时 workspace 的 maxDepth 改为 3，再做一轮标记修改。固定夹具应有根/one/c 三个请求与真实 status，截断数 0；无其他缺口时 diff 可 available。旧 record 仍 partial，不回填。三个 Provider 分开重复。

### D-U4：用户级 bridge 诊断（Qoder / Codex shell bootstrap）

退出 Provider，停止**临时 workspace** daemon，备份并暂时改名该 workspace 的 `.scry/provider-hook.sh`。保持隔离 HOME；如需避免 Provider 清理 XDG 造成路径差异，可在此终端 unset XDG_STATE_HOME，让 native hook 和 doctor 都使用该 HOME 的 `.local/state`。再用原生 CLI 做一次仅回复 OK 的轮次，然后读取：

```bash
node "$CLI" doctor --workspace "$W"
node "$CLI" support-bundle create --workspace "$W" --out "$RUN/support.json"
```

预期：Provider 不因观测 hook 失败而报错；用户级日志增加 bridge_not_found，两份报告的 userHookSkips 一致、workspaceAttribution=unknown，check 为 warn，不把它加到 workspace hookSkips。若日志无新增，不能判通过：按 C-U2 查 native 是否加载 hook 及实际 HOME/XDG。尤其在多仓库工作区的子仓库启动时，Provider 可能根本不加载父配置。OpenCode plugin 不走该 shell bootstrap，不要求它生成同类日志。

恢复备份桥接脚本，再 repair、重启 Provider；不要删除/清零历史日志来伪装修好。日志只按保留窗口报告。

### D-U5：继承标记与失败结果

在隔离终端设置 `SCRY_RECORDER_DAEMON_TRIED=1`，停止临时 daemon 后启动正常原生轮次。修复脚本应先清除继承值，恢复正常直接写入/拉起 daemon，而不是只留下无人消费的 inbox。完成后读回本轮 record；测试后 unset 该内部变量。

受控 timeout/failed 和三分支标记行为可离线复查：

```bash
npm run test:unit -- src/core/turn-recorder/repository-snapshots.test.ts src/core/turn-recorder/recorder-trace-merge.test.ts src/cli/hook-environment.test.ts src/cli/user-hook-diagnostics.test.ts
```

这些是临时 fixture，不是“真实 Provider 发生 timeout”的证明。需要手动破坏 Git index 的验证只能用另一个可丢弃夹具，不能在日常仓库执行；本次已用构建 CLI 的临时坏 Git probe 证明 failed/git_error 与未知 repoRoot 的保留。

## 未验证项与留给用户决定的事

- 用户负责按 D-U1～D-U5 核验真实 OpenCode/Qoder/Codex、native trust 和子仓库启动；本次只验证合成 hook/临时 CLI，不冒充真实 Provider 验收。确认后再决定是否进入 E。
- 请确认用户级不可归因日志采用“独立 warning、不改变当前 workspace 退出码”的边界。若要机器全局 CI 阻断，应另定策略，不能静默把别的仓库失败算在当前仓库上。
- doctor 的 32/128 上限有意限制成本；出现 incomplete 时先显式配置范围或人工检查，完整盘点需另行评估，不自动扩大默认扫描。
- 未测 Linux、Node 20/22、断电、真实多仓库 timeout 比率或冷启动 L2；L1 8→8 不替代这些验证，不宣称更快。原有全量超时交维护者统一处理，本批不修、不放宽。
- 未改 trust/fingerprint、ACK、fsync、并发或 uploader；无 main push、PR、发布、日常安装。保留忽略的构建产物和 `/tmp` 日志/脚本；新增 fixture/probe/临时 npm 安装已清理。

## 核验意见（审查方，2026-10-25）

**结论：D2 及两个附项已核验；前置拆分逐声明比对通过，但需要恢复被删掉的注释（VD2）；D1 的语义需要调整（VD1），等用户选定方案。**

### 复跑

- 红测在各自的测试提交上复现：`d1321fe` repository-coverage 3 个失败；`8b82f9c` user-hook-diagnostics、hook-environment、repository-snapshots 共 10 个失败。与报告一致。
- HEAD `9f408fc` 全量（Linux/Node 22）：8 个失败、3965 个通过、5 个跳过。其中 7 个是此前记录的环境失败。新出现的 1 个是 `desktop-client.test.ts > does not evict recorded runs merely to satisfy receipt capacity`：单独重跑 3 次都通过，D 批次没有改动 `src/main`，它只从 `shared/trace` 引入类型。按「首次失败」如实记录，判断为负载下的偶发，不归因到本批。
- Recorder Core 独立性：`src/core/turn-recorder/` 下新拆出的文件没有引入 Electron、SQLite 或 Provider SDK。

### 前置拆分的核验方法与结果

我用 TypeScript AST 把拆分前后的顶层声明逐个按名字比对（去掉 `export` 前缀后归一化空白），测试则按 `describe > it` 的标题比对函数体：

- `recorder.ts`、`scry.ts`、`workspace-init.ts`（`ffbc022`）对比 `1e3c269` 的全部新文件：202 个声明中只有 `parseCodexRollout` 有变化，原因是末尾的 skill 注入循环被抽成 `finalizeCodexTurns`，逐行等价。两个同名的 `hookCommand` 哈希一致。**行为没有变化。**
- `scry.test.ts`（`d1321fe`）对比拆出的 4 个测试文件（`acddcc7`）：41 个测试没有缺失；只有 doctor 健康用例的 checks 列表多了 `repositories.depth`，符合预期。
- `shared/trace.ts`、`turn-record.ts`（`8b82f9c`）对比 7 个文件（`0febe9e`）：136 个声明没有缺失，变化只出现在 D2 的合同、normalizer 和校验里。
- 流程问题（记录，不要求返工）：测试文件拆分混进了 D1 修复提交 `acddcc7`，shared 和 README 的拆分混进了 D2 修复提交 `0febe9e`，红测和修复的边界因此不如前几批清楚。以后拆分请单独提交。

### VD2（必改，小）：恢复拆分时删掉的注释

拆分时删掉了 9 行解释证据来源的注释，而且 `parseCodexRollout` 里出现了缩进错乱。CLAUDE.md 要求注释解释证据来源和失败模式，如果是 20 KB 门禁迫使删注释，应该继续拆文件，而不是删注释：

- `parseCodexRollout`：`turn_context` / `token_count` 是 host-authored 事实；只有一个模型时才归因；每轮重建 `CodexUsageDeltaFilter` 的原因；`last_token_usage` 相邻同值帧必须丢弃，否则会高估。
- `recorder.ts:133`（`ffbc022`）：`// These Provider Stop contracts expose the same-turn continuation flag; do not infer parity.`

用 `git show 1e3c269 | grep -E '^-\s*//'` 与新增注释对比就能找出原文。只恢复注释和缩进，不改代码。

### VD1（需要用户决定）：深度截断几乎让所有 record 都变成 partial

问题出在我写的 D1 规格，执行方是照规格做的。

- `depthLimitedDirectories` 统计的是走到深度边界、没有继续下探的**所有非 Git 目录**，而不是「可能漏掉的仓库」。`init` 默认是 `discover-nested-git`、`maxDepth=2`。
- 探针（临时，已删除）：一个普通的单仓库，只有 `src/features/auth` 这种三层目录，就得到 `{"repositories":[root],"maxDepth":2,"depthLimitedDirectories":1}`。
- 结果是几乎所有工作区（包括没有任何嵌套仓库的单仓库）的每一条 record 的 diff 都会被降为 `partial`，`doctor` 的 `repositories.depth` 也永远是 warn。partial 和 warn 因此不再携带信号，下游分析无法再区分「确实可能漏了仓库」和「只是目录比较深」。

推荐方案（A）：

1. record 的 diff 状态**不再因为 `depthLimitedDirectories > 0` 降级**。`diff.discovery.maxDepth` 和 `depthLimitedDirectories` 照常写入，作为覆盖边界的元数据，供分析侧过滤。`omissionReason` 只在有缺失证据时写。
2. doctor 只有在下一层探测**实际看到 `.git`** 时才 warn，并列出路径。探测不完整但没有发现时保持 pass，detail 写明「下一层探测不完整（32 个目录 / 128 个条目上限）」，不声称已经确认没有。
3. 原有的红测按新语义调整断言，并在提交说明里写明依据：断言改变是因为规格修订，不是为了变绿。新增两个反例测试：普通的深目录单仓库，record 保持 available，doctor pass；`root/a/b/c/.git`，doctor warn 并列出路径，record 带有 discovery 元数据。

另一个选项（B）是保持现状：任何目录深的工作区都会出现 partial 和 warn。

### D2 与附项

接受。同一毫秒内不同仓库的快照不再被合并：去重键加入了仓库身份、scope、baseline 和 status，相同快照重放仍然去重。`requestedRoot` 与 `repoRoot` 分开，Git 没有解析到时不冒充。缺少 discovery 证据时直接省略，不补 0。旧 record 仍能通过校验。用户级 `bridge_not_found` 作为独立 evidence，不计入当前 workspace 的退出码；日志被截断时标 partial 并 warn。`unset SCRY_RECORDER_DAEMON_TRIED` 放在 `set -u` 之后，所有分支之前。

### 状态

D2 → 已核验。D1 → 需修改（VD1 待用户选定方案，另含 VD2）。在此之前不开始 E。
