# B4-S · S0-3 场景脚本与 S0-6 启动计时：macOS 运行手册

对应 [P3-b4s-plan](../P3-b4s-plan.md) 的 S0-3（B4-V 场景表，开关打开）和 S0-6 的「App 启动」一项。维护者决定一步到位、不留逃生开关，S0 是唯一的安全网，所以两个脚本都按「没有证据就不算通过」写：缺前提、缺产品接口时记 not-run 并写原因，not-run 不会被当作通过。

| 脚本 | 作用 |
|---|---|
| `scripts/b4v-scenarios.mjs` | B4-V 场景，开关打开（`SCRY_HOST_DAEMON=1`）；能对照的场景同时跑开关关闭的对照组 |
| `scripts/b4s-startup-timing.mjs` | App 启动计时：daemon 冷启动、daemon 已在运行、开关关闭对照；不进任何门禁或 ratchet |
| `scripts/b4v/*.mjs` | 共用模块：报告、隔离断言、进程身份、ledger 读取、结果判定、统计；纯函数部分有单测（`scripts/b4v/*.test.mjs`） |

## 准备（macOS）

1. 在要验证的提交上：`npm ci`（或沿用现有依赖），然后 `npm run build`。脚本跑的是 `out/` 里的构建产物，不是源码；preflight 会提示构建早于 HEAD 提交（advisory）。
2. 把 `better-sqlite3` 重建为 Electron ABI：`npx @electron/rebuild -f -w better-sqlite3`。否则 daemon 的 `initDb` 降级、不生成 `scry.db`，隔离断言会失败。preflight 会用 App 自带的 Electron（`ELECTRON_RUN_AS_NODE=1`）实际打开一个内存库来确认，失败就整轮停下、所有场景记 not-run。
   跑完后若要回到 Node 下的单测：`npm rebuild better-sqlite3`。
3. 不需要设 `SCRY_HOST_DAEMON`：脚本给每个 App 显式设置开关（daemon 场景 `1`，对照组 `0`），shell 里的值不影响结果。`SCRY_TEST_APP=1` 下 daemon 模式必须用 `SCRY_DAEMON_CREDENTIAL_PLAINTEXT=1`，否则 `safeStorage` 会卡在钥匙串上；脚本已经带上。
4. 不要求窗口获焦，也不点界面：所有操作都通过 CDP 调用 renderer 里的 `window.scry`（与 `daemon-mode-smoke.mjs` 同一条路径）。
5. 计时脚本必须在计时锁下串行跑，不要和别的毫秒级测量同时跑。

## 运行

```sh
# S0-3：全部场景（11 个场景条目，含 3 个对照；本容器未实测时长），报告默认写到 /tmp/scry-b4v-report-<时间>.json
node scripts/b4v-scenarios.mjs --out /tmp/b4v-report.json

# 只跑部分场景
node scripts/b4v-scenarios.mjs --only sigkill,upgrade --out /tmp/b4v-sigkill.json

# S0-1 的按钮落地后，若自动识别到多个候选，显式指定 window.scry 上的路径
node scripts/b4v-scenarios.mjs --only upgrade,quit-all --restart-api <path> --quit-api <path>

# 用真正的旧构建做升级场景：在另一个 worktree 检出旧提交并 npm run build
node scripts/b4v-scenarios.mjs --only upgrade --old-daemon-entry <旧检出>/out/main/daemon.js

# S0-6：启动计时（每种情况 10 个样本，三种情况按轮交错）
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs b4s-startup -- \
  node scripts/b4s-startup-timing.mjs --samples 10 --out /tmp/b4s-startup.json
```

其他参数：`--no-controls` 不跑对照组（对比步骤随之 not-run）；`--keep` 保留所有临时目录。场景失败或部分未跑时，临时目录自动保留，路径写在报告的 `evidence.tempRoot`。

退出码：`b4v-scenarios` 0 = 全部通过，2 = 有失败，3 = 不完整（有 not-run / partial，或 preflight 失败）；`b4s-startup-timing` 0 = 有效，3 = 本轮作废（void），2 = 出错。

## 安全与隔离

- 每个场景一个新的临时根目录 `/tmp/scry-b4v-<场景>-XXXXXX`，里面放 `userData`、`HOME`（工作区在 `HOME/workspace` 下）和 `logs`。不用 `$TMPDIR`：macOS 的 `$TMPDIR` 太长，daemon 的 unix socket 路径会超限。
- 行动前先断言隔离：静态检查（路径都在临时根下、临时根不在真实 HOME 和真实 Scry userData 里、socket 路径不超平台上限）；App 就绪后的实时检查（临时 userData 里有 `scry.db`；`userData/daemon/daemon.lock` 的持有者身份可验证且存活；`scry-userdata.lock` 由同一个 daemon 持有（role `daemon`）；daemon 进程环境里的 `SCRY_DAEMON_USER_DATA_DIR` 指向临时 userData）。任何一项不成立，场景不再行动。
- 只停止脚本自己启动、并且身份复核通过的进程：daemon 按 `daemon.lock` 记录的身份（Linux 用 `/proc` 的 boot_id + starttime，macOS 用 `LC_ALL=C TZ=UTC` 的 `ps lstart`，与产品一致）；supervisor 必须是已验证 daemon 的父进程；其余只认环境变量里带本场景临时目录的进程。每次发信号前重新读取身份，不按名字匹配，没有 pkill。
- 场景结束时一律清理：结束 App → 停 daemon → 回收场景启动的 shell → 记录残留（`evidence.cleanup`）。

## 场景与预期状态

报告里每个场景先有两步隔离（`isolation-static`、`isolation-live`），再是下表的步骤。

| 场景 | 主要步骤 | 现在预计 not-run 的步骤 |
|---|---|---|
| `close-app` 关闭 App | 优雅退出（SIGTERM → `app.quit`）后 daemon 身份不变；paced run 在 ledger 里于 App 退出之后 `run_settled`；新 App 接入同一 daemon；App 被 SIGKILL 时 run 同样继续、shell 仍在 | `remote-device-visibility`：没有针对 daemon 模式宿主的配对设备夹具 |
| `reopen` 重新打开 | 第二个 App 接入同一 daemon（同 pid、同身份）、只有一个 daemon；接管仍在等问题的 run；第一个 App 已显示的条目在第二个 App 中各出现一次，缺失时必须由流健康（degraded / resyncRequired / skippedEvents）如实标出；从第二个 App 停止 run | — |
| `sigkill` | daemon 冻结（SIGSTOP）后从窗口发出 stop，再 SIGKILL；新 daemon 接管；run 变为 `run_failed`，detail 以 `host_restarted` 开头；一个 fence run 结束后该 run 仍只有一次 `run_dispatched`；未确认的 stop 报 `daemon_outcome_unknown` / `daemon_stop_not_confirmed` / `daemon_submit_unknown` | — |
| `upgrade` | 先直接启动一个宣称旧版本（`0.0.0-b4v-old`）的 daemon，再开新 App：第一次 run 调用报 `daemon_version_mismatch`；旧 daemon 不被悄悄替换 | `restart-action-present`、`recovered-after-restart`：「重启后台服务」由 S0-1 实现，`window.scry` 上还没有 |
| `quit-all` | 有 run 时调用后 5 s 内 App、daemon、run 都还在（需要二次确认）；无 run 时 App 与 daemon 在 30 s 内退出；不留进程、`daemon.lock`、`scry-userdata.lock`、socket、remote lease | 除 `action-present` 外全部：「退出 Scry 与后台服务」由 S0-1 实现。若调用 15 s 不返回（原生确认框），记 not-run，需要人工点一次并记录文案 |
| `mutual-exclusion`（含对照） | 同一 provider/profile/工作区：第二次启动接入第一个 run 的活动 session，必须排队或被拒绝；新 session 的第二次启动只分类；两种分类都要与开关关闭的对照一致 | `auth-versus-run`（smoke Provider 没有登录流程）、`local-plus-remote`（没有设备夹具） |
| `trust-gate`（含对照） | `.codex/config.toml` 里安全的仓库 MCP：run 正常结束；改成 env 带 `NODE_OPTIONS` 的配置：启动被拒、错误点名 `NODE_OPTIONS`、没有 Provider 输出，ledger 里不是 `settled`；再改成另一份安全配置：重新校验后放行；三个结果与对照一致 | — |
| `renderer-isolation`（含对照） | 页面里没有 `require` / `process` / `module` / `Buffer`；`window.scry` 只有类型化方法；被拦下的请求报告的 CSP 含 `connect-src 'none'`、`script-src 'self'` 且无 `unsafe-eval`；`fetch` / XHR / WebSocket 访问 `local.sock` 全部失败；renderer 进程没有 `--no-sandbox`；CSP 文本与 `window.scry` 表面和对照完全相同 | — |

### 已知的规格冲突（需要维护者确认，不是脚本能决定的）

1. **终端在 App 正常退出后是否继续。** B4-V 写「终端继续」；[P3-terminal](../P3-terminal.md) 的决定是 App 正常退出时调用 `terminalFeed.shutdown`，shell 随 App 结束，只有 App 崩溃时才留到约 90 s 的回收。脚本按 B4-V 断言 `terminal-after-quit`，失败时步骤里带有这条说明；`terminal-after-crash` 按两份文档都一致的语义断言。
2. **「指纹变化拒绝执行」。** CLAUDE.md（2026-09-21）规定仓库 MCP / Codex Hook / OpenCode plugin 自动授权，指纹变化后重新校验，只有校验失败才拒绝。脚本按 CLAUDE.md：不安全的变化必须拒绝，安全的变化重新校验后放行（`changed-safe-config-reverified` 带说明）。
3. **「同 profile 互斥」的范围。** 产品的冲突域是 session，不是工作区（`run-admission.ts`：同一 cwd 的不同 session 可以并行）。脚本对「同 session」断言排队或拒绝，对「新 session」只要求与进程内一致。

### 需要产品接口（报告里以 `needsProductHook` 标出）

- `window.scry` 上的「重启后台服务」与「退出 Scry 与后台服务」（S0-1）。脚本按名字识别（含 daemon / background / service / host 字样的 restart、quit / exit / shutdown），多个候选时不猜，要求用 `--restart-api` / `--quit-api` 指定。识别不到时相关步骤 not-run。
- 远程设备相关的两步需要一个能与 daemon 模式宿主配对的设备夹具；当前 `desktop-remote-host-smoke` 只配对进程内宿主。

## 报告字段（`b4v-scenarios`）

- `preflight[]`：`id`、`ok`、`required`、`detail`。`required: false` 的项（如构建早于 HEAD）只提示，不阻断通过；required 项失败则所有场景 not-run，原因写 `preflight failed: …`。
- `scenarios[]`：`id`、`mode`（`daemon` / `switch-off`）、`status`（`pass` / `fail` / `partial` / `not-run` / `n/a`）、`abortReason`、`steps[]`、`evidence`。
  - `steps[]`：`id`、`status`（`pass` / `fail` / `not-run` / `n/a`）、`expected`（预期，来自场景计划）、`actual`（观测值）、`reason`（not-run 的原因）、`note`（规格冲突说明）、`needsProductHook`、`evidence`（如 ledger 路径）。
  - 计划里的步骤没有记录时，结束时自动补成 not-run（`step not reached` 或 `scenario aborted before this step: …`），场景不会因为提前结束而显得更短更绿。
  - `evidence`：`tempRoot`、`logs`（每个 App 实例的 stdout/stderr）、`daemonLog`（`userData/logs/daemon.log`；supervisor 会丢弃 daemon 的 stdout）、`apps`、`cleanup`（结束 App、停 daemon、回收 shell 的结果，`leftovers` 列出残留文件与进程）、`error`（脚本异常的堆栈）。
- `summary`：`overall`（`pass` 仅当所有计入的场景都 pass 且 required preflight 全部通过；有 fail 为 `fail`；否则 `incomplete`）、场景与步骤计数、`exitCode`。
- `n/a` 只允许出现在开关关闭的对照里，且必须有原因；不计入总评。

## 报告字段（`b4s-startup-timing`）

- 每个样本：`case`、`valid`、`invalidReason`、`precondition`（冷启动要求没有 daemon；已运行要求恰好一个可验证的 daemon）、`metrics`：
  - `navigationStartMs`：spawn → renderer 导航开始（renderer 的 `performance.timeOrigin`）；
  - `runSurfaceReadyMs`：spawn → `window.scry.activeRuns()` 第一次成功（daemon 模式包括 App 找到或拉起 daemon 并入网的时间；daemon 尚未就绪时 App 自己会报不可用，脚本每 20 ms 再问一次，这是用户路径上的等待）；
  - `readyAfterNavigationMs`：上面两者之差；
  - `coarse.cdpTargetMs`：CDP 轮询到窗口的时间，约 100 ms 粒度，只作参考；
  - `appStartup`：App 主进程自己的 `app.startup` trace（`SCRY_PERF_LOG=1`）。
- `timingLock`：本进程或其祖先是否持有 `/tmp/scry-performance-timing.lock`。
- `load`：每个样本前后的 1 分钟负载 / 核数；任何一次超过 `--max-load`（默认 0.5）或读不到，本轮作废。
- `summary`：`void`、`reasons`（`load_exceeded`、`load_unavailable`、`not_under_timing_lock`、`invalid_samples`、`round_error`）和各情况各指标的 P50/P95（与 `daemon-mode-timing.mjs` 同一种最近秩百分位）。作废的轮次只保留原始样本，不给 P50/P95。
- 冷启动样本之间会停掉 daemon（身份复核后 SIGTERM），已运行样本要求 daemon 在样本前后是同一个身份，否则样本无效。

## 在本容器里做过的验证

- `scripts/b4v/*.test.mjs` 共 57 个单测（vitest）。每个守卫都做了对照实验：故意改坏实现（如 not-run 不再算 partial、身份不比较就当已验证、停止 daemon 时不复核身份），对应测试失败；恢复后通过。
- 用 Node 直接运行构建出的 `out/main/daemon.js`（本容器的 better-sqlite3 是 Node ABI，Electron 下无法打开），验证了：隔离实时断言、按身份 SIGKILL 后新 daemon 接管、优雅停止后无残留文件和进程；通过 `local.sock` 提交 run 后 SIGKILL，ledger 里该 run 为 `run_failed`（`host_restarted`）且只有一次 `run_dispatched`；`.codex/config.toml` 三种配置的结果分别为 settled / failed（detail 点名 `NODE_OPTIONS`）/ settled。
- 未验证：任何需要 Electron 窗口的步骤（本容器以 root 运行，Electron 需要 `--no-sandbox` 才能启动，这与 renderer 隔离断言相矛盾，所以没有在这里跑 App）。这些步骤只能在 macOS 上由验证 agent 跑出结果。
