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

## 核验意见（审查方，2026-10-25）

**结论：C2 已核验；C3 已核验（fixture 范围，真实 Provider 待用户实测）；C1 需修改（VC1：stale socket 回归）。**

### 复跑

- 红测在各自的测试提交上复现：`78d599f` hook-fallback 2 个失败；`3c5f9ac` hook-socket-path 2 个失败、2 个通过；`ac1104b` hook-command 9 个失败。与报告一致。
- HEAD `04fcaf6`（Linux/Node 22）：三个新测试文件，加上 workspace-init、scry.test 和 `src/core/turn-recorder`，451/451 通过。没有跑全量；`src/main/git.test.ts` 那条失败与本批无关（无 diff），按报告单列。

### VC1（必改）：daemon 崩溃或重启后留下的 socket 让所有事件只进 inbox、不再拉起 daemon

- 机制：shell 只用 `-S` 判断 socket 文件存在。daemon 被 SIGKILL、OOM 或机器重启之后，`$workspace/.scry/recorder-v1.sock` 这个文件还在，但没有进程在监听，curl 立即以 rc=7（连接失败）返回。新代码把所有非 200 都当成「投递结果未知」，设置 `SCRY_RECORDER_DAEMON_TRIED=1`；CLI 随后只入队（`queueOnly`），并且跳过 `startRecorderDaemon`（`scry.ts:142-170`）。下一个事件遇到的是同一个 stale socket，于是同样只入队。没有任何东西会去重放 inbox，除非有人手动执行 recover 或 restart。
- 证实（临时探针，已删除，未提交）：用 python bind 一个 socket 后不监听，模拟崩溃或重启后的残留；再走生成的 shell 和真实 `runScryCli`，依次投递 UserPromptSubmit 和 Stop。
  - HEAD：`{"tried":"1","daemonStartCalls":0,"inbox":2,"openTurn":false}`，两条事件都停在 inbox，daemon 没有被拉起。
  - 基线 `17f22ed`：`{"daemonStartCalls":2,"inbox":0,"openTurn":false}`，事件直接应用，并尝试拉起 daemon。
  - 本机 curl 对这种 socket 的退出码是 `000 rc=7`。
- 影响：数据没有丢（在 inbox 里，doctor 显示 pending warn），但重启机器是最常见的情况。之后这台机器上这个 workspace 的所有轮次都不会自动成为 record，也不会上传，直到有人手动处理。这违背了「无人值守、多台机器」的使用场景。
- 改法：只有在**确实可能已经送达**时才设置标记。shell 在 `code="$(curl ...)"` 之后用内建的 `rc=$?` 区分结果：
  - rc=7（连不上）：daemon 一定没有收到这条事件。保持原来的回退：不设置标记，CLI 正常直写，并 `startRecorderDaemon`（它会清理 stale socket）。
  - 其他非 200（超时 28、空回复 52、接收失败 56、HTTP 非 200）：投递结果未知，维持现在的 queueOnly 行为。
- 测试：先补一个在当前实现上失败的测试，即 stale socket（无监听）时事件被应用、daemon 启动被调用、inbox 为空；再单独提交修复。原有 wedged 用例保持不变。

### VC2（建议，可与 VC1 一起做）：pointer 目标加属主检查

`.scry/recorder-socket-path` 的内容会被 shell 直接采用，hook payload（包括 prompt）会 POST 到它指向的 socket。建议在 `[ -S "$recorded_socket" ]` 之外再加 `[ -O "$recorded_socket" ]`（test 内建，不新增进程），只接受当前用户拥有的 socket，避免被指向其他本机用户的 socket。同一用户下的攻击者不在信任模型保证范围内，所以这只是低成本加固，不是承诺。

### C1 范围

除 VC1 外，范围接受：curl 回退只发一次请求，事件先持久落入 inbox，不在同一进程里同步重做；direct/cold-start 保持原有时序，语义仍是 at-least-once；不做全模式的硬实时 deadline。报告如实纠正了「三重处理」的说法（实测是两次 POST 加一次本地 apply），这一点做得好。180 秒宽限的评估结论接受：direct 且没有 daemon 时，需要显式 recover；`status`、`doctor`、`turns list` 不会代替 recover 收尾。

### C2

接受。只在 listen 成功后才发布 pointer；`.scry` 是符号链接时拒绝发布并关闭本次 daemon；stale hint 只有在目标仍是 socket 时才采用；相对路径的 override 按 workspace 解析，与 Node 一致。`writeTextAtomic` 是从原实现原样抽出来的，fsync 没有变。显式超长 override 仍走 CLI，这种情况少见，可以接受。

### C3

- 接受。成功时只用 shell 内建向上查找，stdin 不会被提前读取，在最近的 `.git` 处停止。
- `repair` 按 handler id 去重，三种 JSON Provider 都验证过两次 repair 结果幂等。
- 用户级的 `bridge_not_found` 日志还没有进入 doctor，已转到 D2 处理（见 STATUS）。
- **用户验证补一项**：bob 的主要场景是带十几个子仓库的工作区。请在 C-U2 之外，再在该类工作区的某个**子仓库**里启动 Codex 跑一轮。按现在的设计，查找会在子仓库的 `.git` 处停下，不会借用外层 workspace 的 bridge；而且 Provider 很可能根本不会加载外层的 hook 配置，那样连 skip 日志也不会有。实测结果决定 D 批次是否要处理「在子仓库启动的会话」这类覆盖缺口。

### 状态

M5 → 需修改（VC1）；L1 → 已核验；M6 → 已核验（待用户实测）。执行方先做 VC1（以及可选的 VC2），在本报告末尾追加「VC1 修改记录」，M5 改回「待核验」。在此之前不开始 D。
