## VC1 修改记录

基线 `2aa8c73a`。VC1 已修复；同时采纳 VC2。仍只做 C，没有开始 D。测试提交 `d822f840`，修复提交 `5bb630e1`。沿用本批已批准的临时 Git hook 豁免；没有修改持久配置、文件大小门限或其他工作区改动。

### 失败证据与测试纠正

新增 stale socket 用例在临时 git workspace 启动一个 Node socket fixture，等 listen 成功后，仅向这个新建 fixture 发送 SIGKILL，留下真实 socket inode。先断言 `isSocket()`，再调用真实 curl，确认 `stdout=000`、退出码 **7**。然后通过生成的 shell 依次投递 UserPromptSubmit/Stop，捕获其交接给 CLI 的 payload/标记，进入真实 `runScryCli`；只 stub daemon 启动，以统计是否发起启动且不拉起测试外的 peer。

`/tmp/scry-VC1-before.log`（旧实现，修复前）：

```text
stale socket (curl rc=7) ...
expected '1' to be ''
expected null to match object { status: 'open' }
expected [ Array(1) ] to deeply equal []
expected [ …(2) ] to deeply equal []
expected "sendRecorderDaemonHook" to be called 2 times, but got 0 times
expected "startRecorderDaemon" to be called 2 times, but got 0 times
pointer ownership contract ...
expected generated script to contain '[ -S "$recorded_socket" ] && [ -O "$recorded_socket" ]'
Tests 2 failed | 5 passed (7)
```

原有两个 wedged 用例未改，旧实现仍通过它们。红测提交前 typecheck 通过，全量 **2 fail / 3951 pass / 4 skip**，失败仅为上述两项。

首次应用修复后 focused 为 **98 pass / 1 fail**：新测试错误地预期无 turn id 的 Claude Stop 留下 `open.status=closing`。按 `recorder.ts` 原合同，该情况同步 finalize 并删除 open，而不是 deferred。已将此断言纠正并加强为：开始时有 open 且无 record；Stop 后 open 不存在、恰好一条 `completed` record、inbox 为空；不是删除生命周期断言来迁就实现。其他失败断言均保持，纠正后 focused 全通过。首次失败日志保留在 `/tmp/scry-VC1-focused.log`。

### 实现

仅修改生成的 bridge，不改 recorder/daemon 的现有启动和持久化实现：

| curl 结果 | 新行为 |
|---|---|
| rc=0 且 HTTP 200 | 原成功快路径，exit 0 |
| **rc=7** | unset `SCRY_RECORDER_DAEMON_TRIED`；CLI 恢复原有 send → 连接失败后直写 → `startRecorderDaemon` 路径，不将 stale socket 误判为已送达 |
| 其他非成功结果（含 28/52/56、HTTP 非 200） | 仍设置标记，queueOnly；不重发或重启结果未知的 peer |

`rc=$?` 直接保存 curl command substitution 的退出码，不能先用 `|| code=""` 抹掉它。所有新增判断、unset/export 都是 shell 内建；成功路径仍无新增进程。始终保留 bridge 的 fail-open exit 0，未改 fsync、trust、record schema 或 180 秒宽限。

VC2：读取 pointer 后同时要求 `[ -S "$recorded_socket" ] && [ -O "$recorded_socket" ]`，才采用它。显式 `SCRY_RECORDER_SOCKET` override 语义不变。现有真实 socket 测试证明当前用户的目标仍可达；另加生成脚本的属主 guard 合同断言。**没有使用 sudo/chown，没有伪称已做另一 OS 用户拥有 socket 的真实负向验收**；同用户攻击者也不在该检查的保证范围内。

### 当前构建的真实 CLI / daemon 探针

补充 `/tmp/scry-VC1-stale-probe.mjs`：使用本次构建的绝对 CLI 路径、独立 HOME/临时 git workspace、真实残留 socket。没有 mock CLI/core/daemon，也没有发送真实 Provider 请求。实际执行生成的 bridge 后，观察 daemon 自行启动，再发 Stop，检查正式 record 与 inbox。没有额外执行 start/recover 来补成功。

`/tmp/scry-VC1-probe.log`：

```json
{"staleSocket":true,"realCli":true,"daemonAutomaticallyStarted":true,"startApplied":true,"completedRecords":1,"inbox":0,"hookExit":0}
{"ownedDaemonExited":true,"temporaryWorkspaceRemoved":true}
```

结束时只停止这个临时 workspace 的 daemon，并确认该 PID 退出，才删除 workspace。此探针验证了实际自动启动，而不只是 spy 被调用。没有计时性能结论，没有安装分支 CLI。

### 验证结果与未通过项

环境仍为 macOS arm64 / Node 24.18.0 / Vitest 3.2.7。

| 检查 | 结果 / 日志 |
|---|---|
| focused：hook-fallback、hook-socket-path、hook-command、workspace-init、scry、daemon | **99 pass / 6 files**；`/tmp/scry-VC1-focused-final.log` |
| `npm run typecheck` | pass；`/tmp/scry-VC1-typecheck.log` |
| `npm run build:cli` | pass；`/tmp/scry-VC1-build.log` |
| `npm run test:shell` | PASS setup-scry-workspace；`/tmp/scry-VC1-shell.log` |
| 真实 CLI stale socket 探针 | pass；`/tmp/scry-VC1-probe.log` |
| 首次修复后全量 unit | 工具外层 600 秒上限中断，无最终汇总，**不算通过**；`/tmp/scry-VC1-unit.log` |
| 再次完整 `npm run test:unit` | **29 fail / 3924 pass / 4 skip，7 failed files / 321 passed files**；`/tmp/scry-VC1-unit-final.log` |
| `git diff --check` | pass |

外层中断后先检查日志与进程：日志仍在逐文件推进，未出现用例失败，该次 Vitest 已退出。后续只增加工具等待完整命令的时间，没有扩大任何测试 timeout。第二次完整运行耗时 917.64 秒。中断后机器负载（1/5/15 分钟）为 42.07/33.81/23.34；完整运行结束后为 46.04/126.45/118.79。高负载是观测事实，不能仅凭这些数值断定每个失败的原因。

全量失败分布（保留首次完整失败，不循环重跑求绿）：

| 文件 | 失败数 | 输出 |
|---|---:|---|
| scripts/check-staged-file-size.test.ts | 1 | 5000ms timeout |
| src/cli/hook-command.test.ts | 2 | Codex/Qoder 子目录用例 5000ms timeout |
| src/renderer/remote-workbench.test.ts | 2 | 15000ms / 5000ms timeout |
| src/main/git-readonly.test.ts | 10 | 5000ms timeout |
| src/main/git-terminal-pair.test.ts | 2 | 20000ms timeout |
| src/main/git.test.ts | 9 | 多项 timeout；一项实际状态 timeout 而非 captured |
| scripts/performance-counters/subprocesses.counters.test.ts | 3 | 命令超时、120000ms timeout、子进程计数 8 而非 6 |

这些测试文件相对 VC1 基线没有 diff。子目录测试会把生成的 bridge 替换为 fixture，因此不会执行本次新增的 curl/pointer 分支；这两项此前 focused 通过。其余 Git/性能/remote 生产路径未改。原有两条 wedged、新 stale socket、pointer、workspace-init、scry、daemon 在这次全量中均通过。没有改旧测试、加 skip、删除断言、扩大用例 timeout，**没有宣称最终全量绿色**。剩余失败归因及空闲环境复核交给维护者，不在本批扩修。

开始时存在的两处 performance-resource-monitor WIP 未编辑、未暂存或提交。4 个既有 skip 保持原样。自动化均使用临时 workspace；测试外层中断可能留下测试临时目录，未做猜测性的批量删除。探针自身的 workspace/daemon 已确认清理；本机脚本与日志保留在 `/tmp/scry-VC1-*`。

### 生效与用户验证

- 必须升级 CLI 后在目标 workspace 执行 `scry integrations repair --yes`：VC1/VC2 都在生成的 bridge 中，单升级不会更新旧脚本。然后按原有流程重启 Provider，Codex 原生 trust 提示照常确认。
- 不要求用户在日常环境 SIGKILL daemon。stale socket 的自动恢复已由隔离真实 CLI 探针验证；要自行复跑用 `npm run test:unit -- src/cli/hook-fallback.test.ts src/cli/hook-socket-path.test.ts`。
- C-U2 的真实 Codex 环境与“多子仓库工作区内启动”的用户验证继续保留；本轮未调用真实 Provider，不把这两项标为通过，也不开始 D。
- 请审查方核验 VC1/VC2；请维护者在较空闲环境复核上述全量失败。跨 OS 用户的 pointer 负向验证尚未执行，若要求真机负向证据，需安排受控双用户环境，不能由当前单用户正向测试代替。

## VC1 核验意见（审查方，2026-10-25）

**结论：VC1 和 VC2 已核验，C1 通过，批次 C 关闭，可以开始 D。**

- 复跑证实：在 `d822f84` 上，hook-fallback 与 hook-socket-path 共 2 个失败、5 个通过，失败的正是 stale socket 和 pointer 属主两个用例。
- 修复后（HEAD `28bab43`，Linux/Node 22）：hook-fallback、hook-socket-path、hook-command、workspace-init、scry.test 和 `src/core/turn-recorder` 共 452/452 通过。
- 全量（同一环境）：7 个失败、3945 个通过、5 个跳过。7 个失败与此前记录的环境失败完全一致（owned-app-processes、db-outbox、desktop-client×2、desktop-directory-picker、MarkdownLayout、SessionRename，原因是 root 用户、没有 Chromium、TLS 环境），**没有新增失败**。执行方在 macOS 上看到的 29 个失败，在这里不复现，与「高负载下的既有超时」这个判断一致，但我无法替那台机器下结论。
- 代码：
  - curl 改为 `rc=$?` 单独取得退出码。rc=7 时 `unset` 标记，走直写并拉起 daemon；其他非 200 仍然只入队。脚本只开了 `set -u`，没有 `set -e`，去掉 `|| code=""` 是安全的。
  - 测试用 SIGKILL 杀掉真实的 Node 监听进程来制造残留 socket，并先断言 curl 确实返回 rc=7 和 `000`，不是模拟出来的退出码。
  - `[ -O ]` 是 test 内建，不新增进程。
- 非阻塞建议：标记现在只在 curl 分支里设置或清除。没有 socket 或没有 curl 时，如果 Provider 的环境里恰好继承了 `SCRY_RECORDER_DAEMON_TRIED=1`，CLI 会一直只入队。可以在脚本开头无条件 `unset SCRY_RECORDER_DAEMON_TRIED`，只用一个内建命令，可以留到 D 顺带做。

状态：M5 → 已核验。C-U2 的用户实测（Codex 子目录，以及多仓库工作区的子仓库）仍待用户完成，结果会影响 D1 的范围。
