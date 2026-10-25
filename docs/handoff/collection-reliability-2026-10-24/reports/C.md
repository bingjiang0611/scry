# 批次 C 执行报告

基线：`17f22edd`；分支：`reliability/collection`。只做 C，没有开始 D/E。环境：macOS arm64、Node 24.18.0、Vitest 3.2.7。

## 结论与提交

| 条目 | 结果 | 失败测试提交 | 修复提交 |
|---|---|---|---|
| C1 / M5 | **部分**：已消除 shell 失败回退中的第二次 daemon 请求，并先持久化到 inbox；未建立所有模式的硬实时上限或 exactly-once 保证 | `78d599fc` | `b8ad9b1e` |
| C2 / L1 | **已修复**：长 workspace 的实际 socket 路径可由 shell 读取；显式相对路径按 workspace 解析 | `3c5f9acc` | `de4baedb` |
| C3 / M6 | **已修复（fixture 范围）**：项目目录变量缺失时向上找 bridge，到最近 Git 边界停止；真实 Provider 环境待用户验证 | `ac1104bc` | `4d60564c` |

每条均先提交红测，再提交修复；提交前运行全量 unit，红测提交的失败是预期证据。用户已授权本批必要提交临时使用 `git -c core.hooksPath=/dev/null`，没有修改整文件大小门限或持久 Git 配置。

## C1：失败回退与预算

### 证实

`src/cli/hook-fallback.test.ts` 使用真实 Unix socket HTTP server：接受请求、消费 body，但不响应。运行生成的 shell；用临时 CLI 捕获其交接的 stdin/env，再在测试进程进入真实 `runScryCli`，以便 spy 统计 handler 调用。仅 daemon 启动被 stub，避免测试拉起其他进程。

旧实现的有效红测输出（`/tmp/scry-C1-red.log`）：

```text
{"event":"Stop","elapsedMs":8547,"postRequests":2,"handleInvocations":1}
{"event":"SessionEnd","elapsedMs":2469,"postRequests":2,"handleInvocations":1}
expected 2 to be 1
expected "sendRecorderDaemonHook" to not be called at all
expected "startRecorderDaemon" to not be called at all
expected [] to have a length of 1 but got +0
Tests 2 failed (2)
```

此 fixture 中 daemon 没有执行 core，因此实际 `handleRecorderHook` 是 **1 次，不是 3 次**。证明的是两次 POST 加一次本地 apply 路径；不能把推测的三重执行当成已测事实。首次草稿还有 `safeKey` 导入位置错误，保留在 `/tmp/scry-C1-before.log`；纠正测试导入后才得到以上有效红测并提交，没有弱化断言。

### 改动后的行为

- shell 的 curl 非 200 后设置 `SCRY_RECORDER_DAEMON_TRIED=1`。成功 200 分支仍直接 exit 0。
- CLI 收到该标记后，不再 send，不尝试停止/重启结果未知的 peer；调用 core 的 `queueOnly` 分支。
- 原 payload、provider、event、sessionId、arrivedAt 原子落到 `<dataRoot>/runtime/<provider>/<sessionKey>/inbox/<arrival>-<uuid>.json`；沿用 fsync，不先等 session lock 或执行 finalize/delivery。
- recorder.log 写 `WARN daemon delivery uncertain; queued ... for replay`。此时不是 record，也不增加 orphan/drop 计数。status/doctor 后续刷新会把它计为 pending。
- 后续 recover 或同会话 hook 重放 inbox；沿用 B 的隔离、重试和生命周期去重。新增断言验证 recover 后原 inbox 被消费，缺开始的 Stop 才成为真实 orphan；SessionEnd 不制造 orphan。
- 修复后 fixture 的 POST 为 1、handler 调用为 1，但 handler 只入队、不 apply。若原 daemon 已经处理请求而 ACK 丢失，之后仍可能 at-least-once replay，**不承诺 exactly-once**。

### 真实子进程计时与上限

另用当前构建 CLI、真实 shell、真实 curl、真实不响应 socket 做子进程探针，没有 Vitest mock；每例临时 git workspace，结束关闭 server 并删除 workspace。`/tmp/scry-C-budget-probe.mjs` 与 `/tmp/scry-C-budget.log` 保留本机。

通过现有 `timing-run.mjs` 串行加锁。第一次因别的测量持锁退出 75，未抢锁；确认锁已释放后才运行。10 核，1 分钟负载开始 **12.31**、结束 **11.35**，`highLoad=true`。

| 事件 | 本次 shell 开始到退出 | POST / 持久 inbox | 退出码 |
|---|---:|---|---:|
| Stop | 5233 ms | 1 / 1，payload 相同 | 0 |
| SessionEnd | 1908 ms | 1 / 1，payload 相同 | 0 |
| PreToolUse | 1907 ms | 1 / 1，payload 相同 | 0 |

这些是高负载单样本，不是延迟上界，也不用于宣称 L2/L3 性能提升。红测的合成 shell→CLI 计时未加锁、未采负载且不含真实 Node 启动成本，只作诊断；可稳定比较的 **L1 计数是 POST 2→1**。线上成功快路径仍只启动原有 dirname、cat、curl；定位新增的 shell 操作全是内建。

实际宿主配置来自 `workspace-init.ts`，不是沿用文档中的笼统 10 秒：

| Provider / 事件 | init/plugin 宿主超时 | curl 不响应的等待预算 | 修复后的该回退路径 |
|---|---:|---:|---|
| Claude / Codex / Qoder：UserPromptSubmit、Stop | 15 s | 4 s | 4 s + Node 启动、配置/身份读取、持久入队与日志 |
| Claude / Codex / Qoder：PreToolUse、PostToolUse、PostToolUseFailure | 10 s | 1 s | 1 s + 同上 |
| Claude：SessionEnd | 3 s | 1 s | 1 s + 同上；本次实测有余量，但不保证所有机器 |
| OpenCode：Stop（含 session.idle 转换） | spawnSync 15 s | 4 s | 4 s + 同上 |
| OpenCode：UserPromptSubmit | spawnSync 10 s | 4 s | 4 s + 同上 |
| OpenCode：工具事件 | spawnSync 10 s | 1 s | 1 s + 同上 |

Codex/Qoder 未配置未经验证的 SessionEnd。Pi 不经过本批生成的 shell/plugin，未新增宿主超时结论。

**不能给出的保证：**文件系统、fsync、进程启动没有硬实时上限。没有 curl/没有 socket 时仍进入原 CLI cold-start 路径；显式 direct/managed 仍走原 core 路径，锁等待、聚合、通知可能超过宿主预算。没有用 `Promise.race` 或杀子进程伪装有界，否则可能先丢事件。本批只修复已证实的 curl 失败后二次尝试及同步重做路径；全模式 deadline/admission 机制属于尚待决定的扩大范围。

### 非 Claude Stop 与 180 秒附带确认（仅评估）

没有把 Codex/Qoder/OpenCode Stop 全部改成 pending，也没有改 `DEFERRED_TERMINAL_GRACE_MS=180000`：

1. 当前非 Claude Stop 在不命中既有 stale-terminal 保护时仍同步聚合。改成一律 pending 会让显式 direct 且无后台进程的最后一轮永久等下一次动作；本批不引入新的后台调度策略。
2. OpenCode/Qoder 缺稳定 turn identity 的短轮次可命中 180 秒保护。起算点是 `open.deferredTerminalAt`，不是 prompt 的 startedAt。
3. daemon 在线时，recovery 调度以 1 秒开始退避、最高 15 秒，宽限后下一次 recover 可完成聚合；这不是严格的 180 秒完成保证，还受 I/O、锁和证据收敛影响。
4. **direct 且无 daemon 时，时间流逝不会自行调用 recover。**应在终态后至少 180 秒显式运行 `scry recorder recover --workspace ...`，或由用户显式启动/restart daemon。
5. `status`、`doctor`、`turns list` 不执行 recover，只读/刷新观测状态，不能写成“任意 scry 命令都能收尾”。同 session 的下一次 hook 也不是通用定时恢复器：新 prompt 走 supersede/finalize 分支；其他活动可能清除 deferred terminal。不要依赖无关 hook 替代 recover。
6. curl 回退已入队但 daemon 真正卡死时，也需要用户检查并 restart/recover；不会为了“自动成功”重启结果未知的进程。

## C2：实际 socket 路径

旧实现有效红测（`/tmp/scry-C2-red.log`）：

```text
publishes the actual long-workspace socket ...
  promise resolved "Buffer[...invoked...]" instead of rejecting
explicit relative socket ...
  expected +0 to be 1
Tests 2 failed | 2 passed (4)
```

测试创建超过 100 字节默认 socket 路径的 workspace，daemon 真正监听短哈希路径，旧 shell 却启动了临时 CLI。显式绝对路径与 stale-hint 对照用例在旧版本已通过。

改动：

- daemon listen 成功后，原子写 `<workspace>/.scry/recorder-socket-path`，内容是实际 socket 绝对路径加换行。
- 将已有原子写实现抽成 `writeTextAtomic`，`writeJsonAtomic` 委托它；原来的临时文件、文件 sync、rename、目录 sync 和错误清理全部保留。没有新的依赖。
- pointer 的 `.scry` 父目录若是符号链接则拒绝发布，并关闭本次已监听的 daemon；listen 失败时不去删除别人的 socket。
- 无显式 override 时，shell 用内建 read 读 pointer，只在目标仍为 socket 时采用；stale pointer 回退默认路径。停止后可保留 hint，不把 hint 当活性证据。
- `SCRY_RECORDER_SOCKET` 非空时优先，不用 pointer 覆盖；相对值与 Node 合同一致，按 workspace 拼接，而不是 hook 子目录。
- 显式**超长** socket 值仍由 Node 哈希解析，shell 不做哈希：该少见 override 仍可能启动 CLI，但不改写其目标语义。本批优化的长 workspace 默认路径已真实走 curl，不启动 CLI。

`hook-socket-path.test.ts` 验证实际 HTTP 请求、fallback CLI 不被调用、pointer 内容、绝对/相对 override、stale hint。durability 回归继续通过。

## C3：子目录定位和存量 repair

旧实现有效红测（`/tmp/scry-C3-red.log`）：

```text
claude/codex/qoder locates the nearest bridge ...
  expected 127 to be +0
missing bridge (...)
  expected 127 to be +0
repair replaces old ... commands ...
  expected 'SCRY_HANDLER_ID=turn-recorder-v1 sh -…' not to be ...
Tests 9 failed (9)
```

这是明确移除项目目录变量、从临时仓库子目录执行真实配置 command 的 shell 复现；**不等价于已证明真实 Codex/Qoder 不设置变量**。

- 起点仍尊重对应 Provider 项目目录变量，缺失则使用 PWD。只用 shell 内建向上找最近可执行 `.scry/provider-hook.sh`；找到即 exec，stdin 不被提前读取。
- 在最近 `.git` 文件或目录处停止，不跨嵌套仓库借用父项目 bridge；没有 Git 边界则到 `/` 为止。
- 找不到/不可执行时 exit 0；尽力追加 `${XDG_STATE_HOME:-$HOME/.local/state}/scry/hook-skip.log`，固定 TSV 原因为 `bridge_not_found`，不写 payload/cwd。不可写时仍 fail open；拒绝日志目标及直接父目录的符号链接。
- 此用户级日志目前**不进入 workspace doctor/support-bundle 汇总**，也没有新增轮转机制；需要人工检查，不能宣称 workspace doctor 覆盖所有找不到 workspace 的故障。
- 没有重写 repair 算法：现有 `stripManagedHooks` 按 handler id 清除旧/重复条目，然后写新 command。三种 JSON Provider 的测试均证明只剩一个 managed Stop、foreign hook 原样保留、第二次 repair 无改动。
- 快路径计数测试从“直接执行 bridge”扩大为“子目录执行配置中的完整 command”，仍只观测到 dirname、cat、curl；断言未削弱。

## 生效方式

| 条目 | 需要的操作 |
|---|---|
| C1 | 升级 CLI **并 repair workspace bridge**；旧 bridge 不传新标记，单升级不能消除双重尝试 |
| C2 | 升级 CLI、repair bridge、`recorder restart` 让新 daemon 发布 pointer |
| C3 | `integrations repair --yes` 改写 Provider command，再重启 Provider；Codex 按原生 `/hooks` 提示重新确认 trust |

不要只升级后继续使用旧 daemon。迁移旧 command 用 repair，不把重复 init 当成迁移证明。本批未改 commit-hook trust、record schema 或权限语义，未安装日常 CLI/App。

## 验证记录

| 阶段 | 命令/范围 | 结果 |
|---|---|---|
| C1 红测 | `npm run test:unit -- src/cli/hook-fallback.test.ts` | 2 fail；提交前全量 2 fail / 3937 pass / 4 skip；typecheck pass |
| C1 修复 | focused 5 文件；typecheck；build:cli；test:shell；全量 unit | 97 pass；其余 pass；全量 3939 pass / 4 skip |
| C2 红测 | `npm run test:unit -- src/cli/hook-socket-path.test.ts` | 2 fail / 2 pass；提交前全量 2 fail / 3941 pass / 4 skip；typecheck pass |
| C2 修复 | focused 6 文件；typecheck；build:cli；test:shell；全量 unit | 92 pass；其余 pass；全量 3943 pass / 4 skip |
| C3 红测 | `npm run test:unit -- src/cli/hook-command.test.ts` | 9 fail；提交前全量 9 fail / 3943 pass / 4 skip；typecheck pass |
| C3 修复 | focused command/init/CLI | 71 pass |
| 最终 focused | 下列 11 文件 | 271 pass |
| 最终静态/构建 | `npm run typecheck`、`npm run build:cli` | pass |
| 最终复合入口 | `npm test` | **unit 1 fail / 3951 pass / 4 skip；未进入 shell** |
| 失败单项检查 | `npm run test:unit -- src/main/git.test.ts -t 'bounds encoded argv bytes'` | 1 pass / 49 未选中；不抹掉全量首次失败 |
| 独立 shell | `npm run test:shell` | PASS setup-scry-workspace |
| diff | `git diff --check` | pass |

最终 focused 命令：

```sh
npm run test:unit -- src/cli/hook-fallback.test.ts src/cli/hook-socket-path.test.ts src/cli/hook-command.test.ts src/cli/workspace-init.test.ts src/cli/scry.test.ts src/core/turn-recorder/daemon.test.ts src/core/turn-recorder/recorder.test.ts src/core/turn-recorder/recorder-inbox.test.ts src/core/turn-recorder/recorder-durability.test.ts src/core/turn-recorder/recorder-recovery-isolation.test.ts src/core/turn-recorder/io.test.ts
```

最终全量失败原文：

```text
FAIL src/main/git.test.ts > 每轮 Git 工作树快照 > bounds encoded argv bytes without skipping long-path suffixes or retaining preview artifacts
AssertionError: expected false to be true
src/main/git.test.ts:1068
expect(result.files.every(file => file.patchStatus === 'captured' && file.patch?.includes('+after'))).toBe(true)
Test Files 1 failed | 327 passed | 4 skipped (332)
Tests 1 failed | 3951 passed | 4 skipped (3956)
```

该测试、`src/main/git.ts` 和实际导出的 `src/core/turn-recorder/git.ts` 相对基线无 diff；该 Git 实现不依赖本次修改的 recorder/io/daemon。单项通过，C2 全量也通过。现有 patch 采集有短 deadline，机器有并行高负载，但**本次日志不足以判定该失败的精确原因**。按要求未修改测试、deadline 或 Git 实现，不把最终全量说成通过。

4 个既有 skip：performance-correlation、billing-admin-real、p0-integration、p1-integration。没有为本批新增 skip。新测试均 mkdtemp，未写日常 `.scry`。日志留在 `/tmp/scry-C1-*`、`/tmp/scry-C2-*`、`/tmp/scry-C3-*`、`/tmp/scry-C-final-*`、`/tmp/scry-C-unrelated-git.log`；临时 server/workspace 已清理。构建产物仅在仓库 ignored 输出目录，没有安装。

## 用户验证

以下是**待用户执行**的真实 Provider 验收，不计入上面的通过数。请给审查方返回每步“通过/不通过/观察”，附 Provider 版本、record 数、pending/doctor、耗时；不要上传凭据、完整 prompt 或环境变量列表。

### C-U1：准备独立临时仓库

在本分支构建后使用绝对路径，不安装到日常环境：

```sh
# 在 scry 仓库执行；把 CLI 设置为你本机实际路径。
npm run build:cli
export CLI="$PWD/packages/turn-recorder-cli/dist/cli/scry.js"
export SCRY_AUTO_UPDATE=0 SCRY_NO_UPDATE_CHECK=1
export RUN="$(mktemp -d /tmp/scry-C-verify.XXXXXX)"
export WS="$RUN/codex-workspace"
mkdir -p "$WS/src/deep"
git -C "$WS" init -q
node "$CLI" init --workspace "$WS" --providers codex
node "$CLI" integrations repair --workspace "$WS" --yes
node "$CLI" recorder restart --workspace "$WS"
```

对 Qoder/OpenCode 分别创建**不同**临时 git workspace，分别 init `qoder` / `opencode`；不要在日常项目改 hooks。使用本机已授权 Provider，任何原生 trust 提示由你确认，不加绕过 trust 的参数。

### C-U2：Codex 子目录的真实 cwd / 环境（C3 必测）

在临时 Codex workspace 把 bridge 暂时包一层，只记录目录字段，不读取 stdin：

```sh
mv "$WS/.scry/provider-hook.sh" "$WS/.scry/provider-hook-real.sh"
cat > "$WS/.scry/provider-hook.sh" <<'SH'
#!/bin/sh
root="$(cd "$(dirname "$0")/.." && pwd -P)" || exit 0
printf 'provider=%s event=%s cwd=%s CODEX_PROJECT_DIR=%s QODER_PROJECT_DIR=%s\n' \
  "$1" "$2" "$PWD" "${CODEX_PROJECT_DIR-<unset>}" "${QODER_PROJECT_DIR-<unset>}" \
  >> "$root/.scry/verify-hook-env.log"
exec "$root/.scry/provider-hook-real.sh" "$@"
SH
chmod 700 "$WS/.scry/provider-hook.sh"
cd "$WS/src/deep"
unset CODEX_PROJECT_DIR QODER_PROJECT_DIR
codex
```

在 Codex 内先 `/hooks` 检查项目 hook 已加载且每个事件只有一个 Scry 条目；按原生提示确认项目 hook trust。发送一条最小“只回复确认、不改文件”的消息，等 terminal 后退出。读 `$WS/.scry/verify-hook-env.log`：报告真实 cwd、CODEX_PROJECT_DIR 是 unset 还是何值，以及 UserPromptSubmit/Stop 是否到达。父 shell unset 不等于 Provider 未注入，以日志为准。

```sh
node "$CLI" recorder recover --workspace "$WS"
node "$CLI" turns list --workspace "$WS"
node "$CLI" recorder status --workspace "$WS"
node "$CLI" doctor --workspace "$WS"
```

预期：新 round 有 record；或者先明确 pending，recover 后按证据收敛。没有 log 时，先核对 `/hooks` 是否加载项目配置，不能直接认定是 bridge 搜索失败。不要上传 transcript。结束后退出 Provider，再 `integrations repair --yes` 恢复标准 bridge；必要时重新确认 Codex hook trust。

Qoder 可在独立 workspace 用同一目录探针，子目录启动 `qodercli`（或本机的 `qoder`），报告 QODER_PROJECT_DIR/cwd。OpenCode 插件按插件文件定位根，不依赖这些变量；在独立 workspace 子目录启动 `opencode` 做正常一轮对照。

### C-U3：长路径与真实快路径（C2）

另建名字足够长的临时 workspace，使 `printf %s "$WS/.scry/recorder-v1.sock" | wc -c` 大于 100；不要只建长子目录后仍在短根 init。init 对应 Provider、repair、restart。

- 查看 `.scry/recorder-socket-path`，应该是实际短 socket；`test -S "$(cat .../recorder-socket-path)"` 成功。
- 从其 `src/deep` 启动 Provider 做一轮。record、pending、doctor 按 C-U2 核验；不要只用 pointer 存在证明采集成功。
- 是否未启动 CLI 已由自动 fixture 的真实 HTTP/CLI spy 证明；用户没有进程探针时不凭体感宣称这一项通过。

### C-U4：宽限期、回退痕迹与修复配置

- OpenCode/Qoder 若短轮次先 pending，等 **Stop 后**至少 180 秒，再执行显式 `recorder recover`；记录新 record 与 pending 变化。
- 要验证 direct 行为，在独立测试 workspace 停 daemon，启动 Provider 前设置 `SCRY_RECORDER_TRANSPORT=direct`；结束后手动 recover。不要期待 status/doctor 自行提交。完成后 unset 并 restart daemon。
- 人工制造 wedged server 容易影响宿主预算，不要求用付费 Provider 重演。离线复现用 `npm run test:unit -- src/cli/hook-fallback.test.ts`；需要真实注入时另行明确测试范围。观察到真实回退时应保留 inbox/recorder.log，先诊断再对该临时 workspace restart/recover，不删除 inbox 来消除告警。
- 若已配置的 command 找不到 bridge，Provider 应继续；检查用户级 `hook-skip.log` 的 `bridge_not_found`，其不包含 payload。嵌套独立 git repo 不会借用父项目 bridge，这是边界约束。
- 对旧配置运行 repair 两次：第一次替换 managed command，保留 foreign hook；第二次无变化。随后重启 Provider，确认没有重复的 Scry 条目。
- 验证结束只停止这些临时 workspace 的 daemon，保留报告所需证据；不要清理日常 workspace 或日常 Provider 配置。

## 未验证项与留给用户决定的事

1. **C1 范围核验（审查方）**：是否接受本批限定为“curl 回退一次请求、durable inbox、无同步重做”，保留 direct/cold-start 的既有时序与 at-least-once？若要求所有环境严格不超宿主预算，需要另行授权设计统一持久 admission / 后台恢复策略；不能用当前计数测试证明该更强保证。
2. **direct 最后一轮（用户）**：本批仅评估且未改 180 秒。当前可用操作是显式启动 daemon，或宽限后执行 recover。若需要无需人工收尾，请另行决定后台触发机制，而不是默认缩短宽限。
3. **C3 真机 Provider（用户）**：请按 C-U2 在 Codex 实测；Qoder/OpenCode 用独立 workspace 对照。Linux、Node 20/22、无 curl、不同 Node manager/GUI PATH 的矩阵未实际运行，不把 macOS fixture 外推为全部通过。
4. **最终全量失败（审查方/维护者）**：保留 Git patch 既有路径的失败日志并另行排查；本批不修这条无 diff 路径。单项通过不等于最终全量绿色。
5. **全局诊断与特殊 socket（审查方）**：用户级 bridge-not-found 日志暂不汇总/轮转；显式超长 socket 仍走 CLI。若这两项要扩展，在核验意见中明确范围。

以上开放项均未被悄悄视为成功。C1/C2/C3 标为待核验，等待审查和用户验证；不进入 D。
