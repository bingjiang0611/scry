## 2. 合成脚本 `run.mjs`（第 0 步）

```sh
node "$K/run.mjs" --uploader "$UP" --old-uploader "<evidence-root>/prefix-old-0.1.0/…/dist/cli.js" \
  --protocol "<evidence-root>/protocol.json" --report "<evidence-root>/rollout-report.json"      # exit 1
```

`{"PASS":17,"KNOWN":1,"FAIL":1,"ERROR":1}`（`<evidence-root>/rollout-report.json`）

| 场景 | 结果 | 说明 |
| --- | --- | --- |
| S01–S17、S20 | PASS ×17 | 与 0.2.7 基线一致；S17 用 `_recover` 50 s 排空 8/8 |
| S15 | KNOWN | 已知脱敏缺口（cookieB、带空格值），与本轮一致 |
| **S18** | **FAIL** | `notify p95 1562 ms (p50 968 ms)`，门限 1500 ms；当时 load 48.7 |
| S18 复测 2 次 | PASS | 1283 ms / 1476 ms（load 40.7 / 54.7）——只在报告里作复测证据，不改首测判定 |
| **S19** | **ERROR** | 用 0.1.0 当 `--old-uploader` 时 `scry-upload: 未知命令：notify`（0.1.x 没有该命令，场景无法执行） |
| S19 用 0.2.0 复跑 | **PASS** | `backlog 4+4 unchanged across upgrade; 4/4 uploaded by new version; old CLI still reads the store`（`rollout-report-s19-0.2.0.json`，exit 0） |

S19 说明：内网 registry 上最老可装版本是 0.1.0，但 0.1.0 没有 `notify`，不能作为 `--old-uploader`；最老**可运行**版本是 0.2.0，已在它上面通过。这一条按"最老版本通过"记 **部分满足**。

## 3. Agent 步骤 0–9：命令、退出码与结论

### 步骤 0 前置检查与备份

- 备份到 `<evidence-root>/before/`：`scheduler-status.json`、`launchctl-print.txt`、**`com.scry.uploader.plist`（原文件）**、**`workspaces.json`（登记列表）**、`pi-settings.json`、`pi-extensions.txt`、`main-workspace-status.json`。
  （清单只列了 `launchctl print`，但第 9 步要按备份恢复 plist，必须备份 plist 文件本身；登记列表同理。）
- Provider 登录（`<evidence-root>/probe`，各 1 轮）：codex `exit 0`、qoder `exit 0`、pi `exit 0`、**opencode `exit 1`**。
  - codex 本机 0.166.0 没有 `--full-auto`，改用清单允许的"以本机 `--help` 为准"：`codex exec --dangerously-bypass-hook-trust -s workspace-write`。
  - opencode：默认模型 `anthropic/claude-opus-4-8` 的 `baseURL={env:OPENCODE_ANTHROPIC_BASE_URL}` 未设置 → `fetch() URL is invalid`；`opencode auth list` = `0 credentials`；换 `-m opencode/beam-free` 挂 240 s 超时。
  - **判定：步骤 0 FAIL（OpenCode）**。按规则继续执行不依赖它的步骤。
- 结论：`<evidence-root>/probe` 里 codex/qoder/pi 各 1 轮通过，OpenCode 无法运行。

### 步骤 1 搭测试仓库（exit 0）

`<evidence-root>/a`、`b`、`c`、`same1`、`same2`、`clash`、`fresh`、`a-wt`（`git worktree`）全部创建，remote 指向 `<internal-git-host>:scry-rollout-test/*`、`scry-rollout-test-2/*`，从不 push。

### 步骤 2 全新安装与 init（PASS，但发现文档缺口）

| 命令 | exit | 结论 |
| --- | --- | --- |
| `npm install --prefix <evidence-root>/prefix <recorder 内部包名>@0.2.57 <uploader 包名>@0.2.10` | 0 | `<evidence-root>/prefix/node_modules/.bin/{scry,scry-upload}` 可用 |
| `scry-upload init --providers codex,qoder,opencode --json`（`<evidence-root>/a`） | 0 | `changedFiles` 4 个文件都存在；`codexTrustRequired: true` |
| 再次 init | 0 | 无重复 hook（`integrations diff` 无 duplicate） |
| `scry integrations diff --workspace <evidence-root>/a` | 0 | 托管事件齐全，`duplicateEvents: []` |
| `mkdir <evidence-root>/a/sub` → 在 sub 里 init | **1** | `请在 Git 项目根目录执行：…/a` ✅ |
| `clash`（预写别人的 commitHook）→ init | **1** | `commitHook` 仍是 `tools/other-hook` ✅（错误文本是 `workspaceId is required`，即把预写配置判为无效，而不是"检测到外部 hook"） |
| `scry integrations install-pi` / `status-pi` | 0 / 0 | 安装到 `~/.pi/agent/extensions/scry-recorder.ts` |
| `scry-upload doctor --workspace <evidence-root>/a --json` | 0 | `healthy: true`；`0.2.57` == 全局 `scry` `0.2.57` ✅ |

**但版本门禁在这里已经失效**：doctor 检查的是 PATH 上的 `scry`，实际写记录的是 hook/Pi 扩展解析到的 CLI。见第 6 节 F2。

### 步骤 3 各 Provider 录制与上传（Codex PASS、Pi PASS、**Qoder FAIL**、OpenCode 未执行）

每轮快照 → 3 轮（tool / text / 中途停止）→ `turns` → `upload` → `scry status`。中途停止轮先等 `.scry/runtime/<provider>/` 出现新 session 目录（0.2.57 没有 `open.json`，清单里写的是旧布局），再 `kill -INT <pid>`；**从未发送 SIGTERM**。

| Provider | turns | upload | 说明 |
| --- | --- | --- | --- |
| Codex | 0 FAIL（17 checks） | 0 FAIL，3/3 `uploaded/inserted`，16.6 s | 中途停止轮 `status=interrupted`，SIGINT 后 provider exit 1，日志 `turn interrupted` |
| Pi | 0 FAIL（17 checks），1 WARN | 0 FAIL，3/3 `uploaded`，0.43 s | WARN = `interrupt: partial evidence marked partialSections []`；中途停止轮有记录 ✅ |
| **Qoder** | **4 FAIL（14 checks）** | **0 FAIL**，2/2 `uploaded/inserted`，0.48 s，死信 0 | 明细见下 |
| OpenCode | 未执行 | 未执行 | 第 0 步已 FAIL（无法登录/无法运行） |

Qoder 明细（`<evidence-root>/turns-qoder.json`、`<evidence-root>/logs/STEP3-FINDINGS.md`）：

| 轮 | 记录 | 应为 |
| --- | --- | --- |
| tool（`rc-qoder-tool-0e0b6e`） | seq 8，**`interrupted`** | completed |
| text（`rc-qoder-text-0e0b6e`） | seq 9，**`interrupted`** | completed |
| 中途停止（`rc-qoder-stop-0e0b6e`，SIGINT，exit 130） | **无记录**（`open.json` 仍 `status:open`，session `17cde7a3`） | interrupted |
| 中途停止复现（`rc-qoder-stop-tree01`，SIGINT 到进程+子进程） | **无记录**（session `b700ec9f`） | interrupted |

- 4 个 FAIL 检查项：`record count matches turns run expected 3 got 2`、`tool: status completed got interrupted`、`text: status completed got interrupted`、`interrupt: exactly one record got 0`。
- 原因证据：Qoder record 的 `termination = {reason:"session_end", source:["lifecycle_hooks"]}`，`hooks` 数组里只有 `UserPromptSubmit/PreToolUse/PostToolUse/SessionEnd`，**没有 `Stop`** → 非交互 `qodercli -p` 不派发 Stop，recorder 只能靠 SessionEnd 收尾，因此把正常完成轮标成 `interrupted`；被 SIGINT 打断时连 SessionEnd 都没有，于是完全没有记录。
- `scry doctor --workspace <evidence-root>/a`（40 分钟后复查）：`status: healthy`、`staleOpenTurns: []`、`health.orphanEvents: 0`、`turns.stale: pass` → **doctor 不暴露这个丢失的已接受轮次**。
- 之后所有 qodercli 调用失败：`Qoder CLI temporarily could not read your saved login (EPERM)`（连续 3 次，`~/.qoder/.auth/user` 的 mtime 在测试窗口内变为 04:51:59）。属外部/凭证问题，需人工重登，Agent 不代做。
- 纯文本轮耗时：codex 23.3 s、qoder 29.8 s、pi 11.8 s；`<evidence-root>/probe` 对照只跑了 1 轮/Provider（不是清单要求的 3 次中位数），**这一项按未完成记录**。

### 步骤 4 多仓库同时使用（PASS，但有替代）

`b/c/same1/same2/a-wt` 全部 init 成功（exit 0）。后台采样 `observe --interval 30 --count 60`（60 个样本）。

| 组 | 计划 | 实际 | 结果 |
| --- | --- | --- | --- |
| a | Codex ×5 | Codex ×5 | turns 0 FAIL（24 checks）、upload 0 FAIL，5/5 |
| b | **OpenCode** ×5 | **Pi** ×5（OpenCode 不可用） | turns 0 FAIL、upload 0 FAIL，5/5（42 s 排空） |
| c | **Qoder/Pi 交替** | **Codex** ×5（Qoder EPERM、OpenCode 不可用） | turns 0 FAIL、upload 0 FAIL，5/5 |

- `record-check report <evidence-root>/obs-multi.jsonl`：**0 FAIL / 1 WARN**（18 checks）。WARN 是 `lock helpers do not accumulate`，样本里恒为 1 —— 那是**用户 <user-workspace> 的长命 lockf**（第 6 节 ENV-1），不是测试仓库产生。
- 同名仓库：`same1 → <internal-git-host>/scry-rollout-test/same`，`same2 → …/scry-rollout-test-2/same`，repo 身份不同 ✅
- worktree：`a-wt` 只有 1 条（自己的标记），`a` 只有 1 条（自己的标记），`a` 中搜不到 `a-wt` 的标记 ✅

### 步骤 5 关闭、开启与放行（PASS）

| 命令 | exit | 结论 |
| --- | --- | --- |
| `scry-upload disable --workspace <evidence-root>/b` → 2 轮 codex | 0 | `disabledHeld` 0→2，两条回执都是 `skipped_disabled`（`upload --expect-held true`：0 FAIL） |
| `enable` → 1 轮 | 0 | 该轮 `uploaded/inserted`（0 FAIL）；关闭期间两条仍 `skipped_disabled` |
| `flush --release-disabled 21aadaa3…` | 0 | 该条从 `skipped_disabled` → `pending`，**再 flush 一次**才变 `uploaded/inserted`；另一条仍 `skipped_disabled` ✅（放行语义正确，但不会在同一次 flush 内完成上传，文档应说明会多一次唤醒） |
| `fresh`：init → 1 轮 → `enable` | 0 | 回执 `uploaded/inserted`，**不是** `skipped_disabled`（0.2.6 修复项 ✅） |

### 步骤 6 定时补传（真实 launchd）（PASS，1 项按 UNAVAILABLE 记）

| 命令 | exit | 结论 |
| --- | --- | --- |
| `scry-upload scheduler-install` | 0 | plist 重写为 `<evidence-root>/prefix/…/cli.js _recover` |
| `scheduler-status --json` | 0 | `activation.state = loaded` |
| `plutil -extract StartInterval/RunAtLoad` | 0 | `60` / `true` |
| `register` a/b/c | 0 | `workspaces` 含三者（实际上 `init` 已自动登记） |
| 只靠 launchd 排空 | — | **前提不成立**：检查瞬间已有 `_worker`（ppid=1，由 launchd `_recover` 拉起，不是 hook）。观察结果：不调用 `wakeup`/`flush`，积压 3 → 0 用 25 s，`runs` 1→3。按清单严格口径记 **UNAVAILABLE（前提未满足）**，实质证据支持补传路径有效 |
| `launchctl bootout` → `bootstrap` | 0 / 0 | `not_loaded` → `loaded`，20 s 内 `runs` 1（RunAtLoad）✅ |

不执行（清单明示）：真实断网、合盖睡眠。

### 步骤 7 登录失效（PASS，向量场说明）

前两次 `flush` 被 `upload worker is already running` 挡下（exit 1，#1、#2 无效果）。原因是登记后的工作区会被后台（launchd 或 App）反复拉起 worker。第三次先 `unregister` 再跑：

```sh
env "$TE=$K/fake-transport.mjs" FAKE_CONTROL="<evidence-root>/logged-out.json" FAKE_PROTOCOL=... \
  node "$UP" flush --workspace "<evidence-root>/c"       # exit 1: uploader authentication failed; run <传输 CLI 登录命令>
```

- 记录留在本地：`outbox 1 + committed 1` 不变，`deadLetterRecords 0` ✅
- 登录问题可见：`lastError.code = transport_auth`、`health.status = deferred`、`lastErrorCode = transport_auth` ✅
- 不带假传输层 `flush` → 该轮 `upload 0 FAIL`，`uploaded/inserted`，**不用等 15 分钟冷却** ✅（`turns-step7.json` 有 1 个 `record count matches turns run expected 1 got 3` 的 FAIL，原因是我在 c 里跑了 3 轮才快照；逐条检查全 PASS，属测试脚手架计数，不是产品问题）

### 步骤 8 升级、卸载与回滚（PASS）

- 带积压升级/回滚由 S19 覆盖（0.2.0 → 0.2.10 PASS）。
- 对 `<evidence-root>` 下 9 个仓库执行 `scry-upload unregister` + `scry integrations uninstall --yes`：全部 exit 0。
- 卸载后 `observe --count 3`：worker 0、`<evidence-root>` 内 lock helper 0 ✅
- 卸载后在 `a` 跑 1 轮 codex：provider exit 0，`.scry/records` 18 → 18 不变 ✅
- Pi：`scry integrations status-pi` 恢复后 **exit 1**（`installed:false, reason:"missing"`）✅，`~/.pi/agent/settings.json` 与备份逐字节一致。
- 残留（非阻塞）：`scry.config.json` 的 `commitHook` 仍指向 `.scry/upload/runtime/record-committed`，而该文件已被卸载删除。

### 步骤 9 收尾与恢复（PASS）

| 项 | 结果 |
| --- | --- |
| launchd plist | 从 `<evidence-root>/before/com.scry.uploader.plist` 还原，与备份**逐字节一致**；`bootout` + `bootstrap` 后 `activation.state = loaded` |
| 登记列表 | 从 `<evidence-root>/before/workspaces.json` 还原，**逐字节一致**（只剩 <user-workspace> 与 另一个 两个工作区） |
| Pi 设置 | 与 `<evidence-root>/before/pi-settings.json` **逐字节一致**；`scry-recorder.ts` 已删除 |
| 主工作区（<user-workspace>） | `enqueuedThrough 2725`、`outbox 0`、`committed 0`、`disabledHeld 0`、`deadLetterRecords 2210`、`deadLetterJobs 0`、`jobsPending 1` —— **全部与备份相同**；`lastError` 仍是 `discovery_blocked`（时间戳更新，是用户自己的 launchd 在重试） |
| `<evidence-root>` | 保留，未删 |

## 4. 实际跑了多少轮

70 条记录 = 70 个被 Provider 接受的轮次：

| Provider | 记录数 |
| --- | --- |
| Codex | 45 |
| Pi | 23 |
| Qoder | 2 |
| OpenCode | 0 |

另有 7 次调用没有产生记录（不计入 70）：Qoder 中断轮 2 次（F1）、OpenCode 2 次（1 次即时失败、1 次 240 s 超时）、Qoder 凭证 EPERM 3 次。
合计调用 77 次。用户授权后于 11.7 节追加 2 轮 Qoder 最小复现（第 78、79 轮），**累计 79 次，未超过 80 轮授权**。

记录被哪个 recorder 写出：**0.2.57 ×43、0.2.56 ×27**（a: 23/5、a-wt: 1/0、b: 0/18、c: 16/4、fresh/same1/same2: 各 1/0）。

## 5. record-check 的 JSON 结论（全部在 `<evidence-root>/`，failed 数）

| 文件 | failed | 说明 |
| --- | --- | --- |
| `turns-codex-N2.json` | 0 | 3 轮 tool/text/interrupted 全部符合 |
| `upload-codex.json` | 0 | 3/3 uploaded |
| `turns-qoder.json` | **4** | 见步骤 3 表 |
| `upload-qoder.json` | 0 | 2/2 uploaded，死信 0 |
| `turns-pi.json` | 0（1 WARN） | interrupted 轮缺 partial 段 |
| `upload-pi.json` | 0 | 3/3 uploaded |
| `turns-multi-{a,b,c}.json` | 0 / 0 / 0 | 各 5 轮 |
| `upload-multi-{a,b,c}.json` | 0 / 0 / 0 | 各 5/5 |
| `turns-id-same1/2.json`、`upload-id-*` | 0 | repo 身份不同 |
| `turns-wt-a.json`、`turns-wt-a-wt.json` | 0 / 0 | worktree 隔离 |
| `turns-step5-held.json`、`upload-step5-held.json` | 0 / 0 | 两条 `skipped_disabled` |
| `upload-step5-after.json`、`turns-step5-fresh.json`、`upload-step5-fresh.json` | 0 | enable 后与 fresh 都 uploaded |
| `turns-step7.json` / `upload-step7.json` | **1** / 0 | 计数型 FAIL，逐条 PASS（见步骤 7） |
| `report-multi.json`（步骤 4 采样） | 0（1 WARN） | worker ≤2、无超 5 分钟 worker、三个仓库结束积压 0、死信恒 0 |
| `report-load.json`（30 轮压测） | 0（1 WARN） | 同上，`health` 结束为 `healthy` |

压测：a/b/c 各 10 轮（Codex/Pi 交替，30 轮全部 exit 0），`observe --interval 60 --count 20`。结束时三个仓库 `outbox 0 / committed 0`、`deadLetterRecords 0`、`health healthy`；无 worker 堆积；`bytesPerRecord ≈ 173–182 KB`（含 diff 与正文，远高于文档里的 8 KB/轮估算，见第 7 节）。

---

返回 [索引](README.md)。
