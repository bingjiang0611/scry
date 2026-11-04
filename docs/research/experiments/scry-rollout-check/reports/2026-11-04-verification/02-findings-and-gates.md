## 6. 所有 FAIL / UNAVAILABLE / 未执行

### FAIL

**F1 — Qoder 已接受的中途停止轮没有记录（0.2.57 重点修复未生效）**
证据：`<evidence-root>/turns-qoder.json`（`interrupt: exactly one record got 0`）、`<evidence-root>/logs/STEP3-FINDINGS.md`、两个 `open.json`（session `17cde7a3`、`b700ec9f` 仍 `status:open`，`turnIndex 1`）。
复现：2 次（`kill -INT <pid>`；再 `kill -INT` 到 pid + 子进程）。从未用 SIGTERM。Provider 原生接受有证据：SIGINT 前 `.scry/runtime/qoder/` 已出现新 session 目录，`qodercli` 退出码 130。
影响：Qoder 用户在会话被 Ctrl-C/退出打断时丢轮次。
**定性已补（第 11.7 节，Qoder 1.1.83 + recorder 0.2.57，第 78/79 轮）**：根因在 Qoder 侧——非交互 `-p` 模式只派发 `UserPromptSubmit` 和 `SessionEnd`，**从不派发 `Stop`**（交互模式会派发）。因此正常完成的一轮被标成 `interrupted`（`session_end`），被 SIGINT 的轮连 `SessionEnd` 也没有，记录整体丢失。所以这不是 0.2.57 能修的缺陷，但**推广前必须在文档里写清 `-p` 模式的这个局限**，否则脚本化 Qoder 用户会得到"全部 interrupted"的假象。

**F2 — 记录由错误的 recorder 版本写出（27/70）**
`~/.pi/agent/extensions/scry-recorder.ts` 的 `executable()` 先试 `SCRY_CLI_PATH`，否则**先看 `$HOME/.local/bin/scry`**，再看 PATH。本机 `~/.local/bin/scry` 是 0.2.53 启动器，会 re-exec `~/.local/lib/.scry-cli-updates/<recorder 内部包名>/0.2.56-JK58P5/…`。结果：
- `b` 全部 18 条、`a` 后 5 条、`c` 4 条记录 `recorderVersion = 0.2.56`；
- 同时 `scry --version`、`scry doctor`、`scry-upload doctor` 都报 0.2.57。
证据：记录 JSON 的 `recorderVersion` 字段；守护进程命令行 `…/.scry-cli-updates/…/0.2.56-JK58P5/…/cli/scry.js recorder serve`；`integrations/pi-scry-recorder.mjs:154-174`。
影响：清单的版本门禁（比较 doctor 与全局 `scry`）**无法证明记录由被测版本写出**；本次 Qoder 判定不受影响（Qoder 记录为 0.2.57）。

**F3 — S18 hook 路径首测超门限**
`notify p95 1562 ms > 1500 ms`（p50 968 ms），机器 load 48.7。复测 1283 / 1476 ms（load 40.7 / 54.7）。按"首测即结论"记 FAIL；需在负载正常的机器上复测才能定性。

**F4 — OpenCode 无法运行（第 0 步 Provider 登录 FAIL）**
`opencode run` → `Error: fetch() URL is invalid`（默认模型的 `baseURL` 取未设置的 env）；`opencode auth list` = `0 credentials`；`-m opencode/beam-free` 240 s 超时。未登录是人工步骤，Agent 未代做。

**F5 — 隐私权限位检查字面不通过**
`find <evidence-root>/*/.scry/upload \( -type d ! -perm 700 \) -o \( -type f ! -perm 600 \)` 输出 14 个文件，全部是 `-rwx------`（0700）的 hook 入口脚本（`runtime/wakeup`、`runtime/record-committed`）。无 group/other 权限，不构成泄露，但严格判定不通过；清单这条对"必须可执行"的文件自相矛盾。

**F8 — 缺失的内容 blob 让导出游标永久卡死（用户 <user-workspace> 工作区实测）**
证据：`<evidence-root>/logs/daily-enqueue-repro.log`（`enqueueSnapshot` 抛 `ENOENT realpath …/content/sha256/11/11c7625e….bin`）、`<evidence-root>/evidence/06-content-blob-gap.json`（90 条 seq>2725 记录的逐条 blob 统计）。
事实：seq>2725 的 90 条记录里，**38 条上传失败的全部记录**，其 12–228 个 `contentRef` **全部缺失**；**52 条上传成功的记录，blob 全部完整**。第一条坏记录 seq 2726（2026-11-02T08:15Z，pi，recorder 0.2.53）。
机制：`enqueueSnapshot` 从 `state.enqueuedThrough = 2725` 顺序导出，遇到缺 blob 的记录即抛错 → `discovery_blocked` → 游标不前进；uploader 只对 `export_rejected_record`（身份被拒）有隔离路径，对"内容文件不存在"没有隔离，也没有跳过或降级。
影响：该工作区每 60 秒报一次错，快照补传/对账永久停摆；只有在 blob 齐全时才上传的 52 条说明"按记录提交事件上传"仍在工作，所以症状是**部分轮次长期不上传 + 常驻错误态**，不是全停。
未定性：blob 是写入失败还是被别处删除。可确定 `listRecords()` 仍引用这些 hash（所以 recorder 自己的维护不会删它们），删除来源无法从现有日志证明（`<evidence-root>N/.scry/logs` 无 maintenance 行）。

**F6 — `doctor` 不暴露丢失的 Qoder open turn**（2026-11-04 用 0.2.57 + Qoder 1.1.83 再次复现，见第 11.7 节）
丢轮 40 分钟后 `scry doctor --workspace <evidence-root>/a` 仍 `staleOpenTurns: []`、`health.orphanEvents 0`、`turns.stale pass`。清单要求用 doctor 的 orphan/stale 计数区分"Provider 没发终态"还是"recorder 没落盘"，这里给不出信号。

### UNAVAILABLE（如实记录，不算通过也不算失败）

| 项 | 原因 |
| --- | --- |
| 步骤 6 "只靠 launchd 排空"的严格前提（无 `_worker`） | 检查瞬间已有 launchd 拉起的 worker（ppid=1）；观察到的排空与 `runs` 增长仍支持该路径有效 |
| 服务端按 `recordId` 去重、请求体上限、限流规则、数据保留期 | 服务方确认项，本轮无人回答 |
| 真实断网、合盖睡眠 | 清单明示不执行 |
| 纯文本轮耗时中位数对比（`<evidence-root>/probe` 跑 3 次） | 只跑了 1 次/Provider |
| S15 的两处脱敏缺口 | 清单已标 KNOWN |
| Qoder 的"下个会话是否恢复上一条 open turn" | 被 EPERM 打断，3 次尝试都没能让 qodercli 起来 |

### 未执行

| 项 | 原因 |
| --- | --- |
| 步骤 3 OpenCode 3 轮 | F4 |
| 步骤 4 b 组 OpenCode 5 轮 | F4（改用 Pi，已在报告标明替代） |
| 步骤 4 c 组 Qoder/Pi 交替 | Qoder EPERM（改用 Codex） |
| 30 轮压测的四 Provider 轮换 | 同上（Codex 15 + Pi 15） |
| 4 个 Provider 各 3 次提示词耗时中位数 | 时间与轮次预算 |

### 环境发现（不是本轮制造，但会影响推广）

- **ENV-1**（已在第 11 节跟进：升级完成，红投不可行）：用户 <user-workspace> 工作区有 **2210 条死信**，`lastError.code = discovery_blocked`（"Scry export was not completed"）、`transportFailures = 120`；另有一个 22 小时以上仍在运行的 `_worker`（0.2.8）和它的 lockf。这正是"uploader 内置 recorder 版本过旧 → 本地导出失败被记成远端拒收 → 假死信"的现场。**恢复后的 plist 仍指向 `~/.local` 的 0.2.8**，所以这些死信不会因本次升级而清理；要让 0.2.10 接管，需要升级 `~/.local` 那份或用 0.2.10 重装定时任务后再 `redrive`。
- **ENV-2**：`~/.local` 的 0.2.8 与 nvm 的 0.2.10 并存，`scry-upload`（PATH）与 launchd 用的是 0.2.8，测试用的是 0.2.10。多前缀并存是 F2 的根因，也会让"升级了但没生效"。
- **ENV-3**：`~/.qoder/.auth/user` 在中断轮之后报 EPERM，需要人工重新登录 qodercli。

## 7. 放行条件逐条

| # | 条件 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | 脚本用真实映射、在推广版本上跑完，0 FAIL / ERROR | **不满足** | S18 首测 FAIL（`rollout-report.json`）、S19 用 0.1.0 时 ERROR（0.2.0 上 PASS） |
| 2 | 步骤 0–9 全部完成且 0 FAIL；UNAVAILABLE/未执行写入报告并被接受；推广文档补齐第 2 步缺口 | **不满足** | Qoder FAIL（F1）、OpenCode 未执行（F4）、记录版本漂移（F2）、文档缺口未补（只能报告不能改文档） |
| 3 | 压测 report 0 FAIL：无进程堆积、结束无积压、死信 0 | **满足** | `report-load.json` 0 FAIL / 1 WARN（WARN 来自用户 <user-workspace> 的常驻 lockf，非测试仓库） |
| 4 | 隐私项全部确认，文档写清上传内容、不宜启用的仓库和关闭方法 | **不满足** | 权限位字面不通过（F5）；文档缺"上传内容清单"和"不可信仓库"两段（见下） |
| 5 | 服务方确认：去重、请求体上限、限流、保留期 | **无法验证** | 无服务方答复 |
| 6 | S19 在最老版本通过；第 8 步卸载后无残留进程和任务 | **部分满足** | 最老可运行版本 0.2.0 上 PASS；0.1.0 无法运行（缺 `notify`）；卸载后 `<evidence-root>` 内 worker/lock 0、记录不再增长 |

## 8. 推广文档需要补的缺口

针对现有文档（`<recorder 内部包名>@0.2.57` 的 README、`<uploader 包名>@0.2.10` 的 README、本地 `docs/cli-team-rollout.md`）：

1. **没有 uploader 的安装与接入段落**。CLI README 的"安装与接入"只装 `<recorder 内部包名>`，并明说"`init` 只开启本地记录，不安装任何 uploader"。照它执行永远不上传。缺：`npm install -g <uploader 包名>@0.2.10`（含内网 registry）、`scry-upload init`、`scheduler-install`、如何核对定时任务里跑的是哪份 CLI。
2. **没有明确写出"会上传什么"**。uploader README 只说 `redactionVersion=none`、保留原始内容。需要一句直白清单：提示词、回复、工具入参、工具输出、文件路径、diff patch，以及 `toolOutput: none` 只关输出、`diff: false` 才关 patch。
3. **没有"哪些仓库不要启用"的警告**。CLI README 讲的是"本地不留代码"的取舍，不是"含密钥/客户数据的仓库不要启用"；也没写 `scry-upload disable` 与 `flush --release-disabled` 的组合用法（本次验证放行后还要再 flush 一次才上传）。
4. **没有"仓库里的 hook/MCP/插件会自动执行"的提醒**。只有 `docs/cli-team-rollout.md` 从设计角度讲指纹门；同事看到的 README 没有"不要在不可信仓库启用"这句。
5. **多前缀风险没有文档**。应写：装完后如何确认 `command -v scry`、`~/.local/bin/scry`、`npm root -g`、Pi 扩展实际用的是同一份；Pi 扩展优先 `~/.local/bin/scry`，留着旧安装会让 Pi 记录由旧 recorder 写出（本次 27/70 条）。
6. **容量估算偏差**。文档按 8 KB/轮估算，实测带 diff 的轮次 `≈173–182 KB/轮`（a/b/c 三个仓库 30 轮的采样）。需要按"是否采集 diff/工具正文"分档重写。
7. **中途停止的验收口径落后于实现**。清单用 `.scry/runtime/<provider>/open.json` 判定"已接受"，0.2.57 已改成 `<sessionId>/session.json`，脚本/文档需要更新，否则按清单做的人会误判。
8. **`integrations diff` 的 `changedFiles` 语义**。重复 `init` 仍报告 4 个 `changedFiles`（内容未变），容易被当成"又改了配置"。
9. **`clash` 场景的报错文本**。预写外部 `commitHook` 时报的是 `workspaceId is required`，看不出"检测到别人的 hook"，建议给出明确原因。
10. **卸载残留**。`integrations uninstall` 后 `scry.config.json` 仍保留 `commitHook` 指向已删除的脚本，文档应说明或清理。

## 9. 复跑建议（按优先级）

1. 先解决 F2：把 `~/.local` 的 CLI 升到 0.2.57（或删掉 `~/.local/lib/.scry-cli-updates/…0.2.56…` 与 `~/.local/bin/scry`），再用 `SCRY_CLI_PATH` 指向被测 CLI 复测；在 `doctor` 里加"记录实际 recorderVersion 分布"的检查，否则版本门禁始终是空的。
2. F1 需要一个能拿到 Qoder `Stop` 事件的路径（或让 recorder 在 SessionEnd 时按"有终态回复"判 completed），并补一条"被 SIGINT 时 SessionEnd 不触发"的回归；同时让 `doctor` 把 `open.json` 里超时未收尾的 turn 计入 `staleOpenTurns`。
3. F3 在空闲机器上重跑 S18（本次 load 40–55，属高负载）。
4. F4：`opencode login` 后重跑步骤 3/4 的 OpenCode 分支。
5. 文档按第 8 节补齐后重跑第 2 步，把缺口逐条核销。

---

返回 [索引](README.md)。
