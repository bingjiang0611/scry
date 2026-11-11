# 侧聊 · 本地验证报告（第二轮）

> 截图与 `verification-summary.json` 是本 PR 的验证素材，按 PR 模板不进入 main。它们保存在分支 `claude/gracious-feynman-nlrtdp` 的提交 `8173a086` 中：`git show 8173a086:docs/handoff/side-chat/local-verify/evidence/<文件名>`。

- 分支：`claude/gracious-feynman-nlrtdp`
- 本轮验证的提交：`8089195a`（`fix(side-chat): show a running turn as running before its live stream answers`）
- 上一轮报告：`REPORT.md`（未修改）。本轮写入 `REPORT-2.md` 与 `evidence/round-2/`。
- 结论：自动化 10 项通过（含 3 层性能在低负载下复跑）、2 项失败但都与 main 一致；场景 7 项全部通过（01、03、07、09、10、11、14），其中场景 14 含真实最小化、切 App 与 `e4b5ea9` 负对照。**未发现本分支回归，本轮无需修复提交。**
- 本轮**未**运行 `npm run install:mac:dev`（按任务书要求）。

## 1. 环境与基线

| 项 | 值 |
|---|---|
| 机器 | macOS 27.3（26C5035r），arm64 |
| Node / npm | v24.18.0 / 12.2.0 |
| 分支起点 | `e4b5ea91` |
| 本轮 HEAD | `8089195a` |
| main 对照 | worktree `../scry-main-baseline`，`origin/main` = `f708285a` |
| 构建 | `npm run build` 通过，`out/` 为本轮构建产物；test 实例只跑这份构建 |
| Provider | 全部为 `codex Smoke Fixture`，未调用任何真实 Provider |
| 日志目录 | `/tmp/lv2/`（`results.tsv`、每个检查一份完整 `.log`） |

负载：本轮开始时机器 15 分钟平均负载最高 193，1 分钟负载一度到 86；毫秒级检查等到 1 分钟负载降到 20 以下才开始，串行执行，见第 2 节表里的 `load1`。低负载复跑时 1 分钟负载 7.3–10.6。

## 2. 自动化检查

| ID | 检查 | exit | 耗时 | load1 | 日志 | 结论 |
|---|---|---|---|---|---|---|
| R2-1 | `npm run typecheck` | 0 | 28s | 高（>60） | `typecheck.log` | 通过 |
| R2-2 | `npm run build` | 0 | 13s | 高（>60） | `build.log` | 通过 |
| R2-3 | `node scripts/electron-security-smoke.mjs --dev-side-chat-only` | 0 | 200s | 高（>60） | `electron-side-chat-only.log` | 通过，12 个 side-chat step 全走完（`execution`→`runtime`→`history`→`scroll`→`source deleted`→`restore`→`large history refusal`→`layout`→`drafts`→`restart`→`drafts restored`→`adoption`）；产物 `evidence/round-2/auto/`（4 张 PNG + 投影后的 `verification-summary.json`；完整 `verification.json` 72KB 留在临时目录，仓库只存投影） |
| R2-4 | `npm run test:conversation:ipc:prebuilt` | 0 | 105s | 高（>60） | `conversation-ipc-prebuilt.log` | 通过；`orphanRecovery: pending -> unknown`、`ownedEvidenceUnchanged: true`、统一对话 `turns: 3`/`restarts: 2` |
| R2-5 | `npm run performance:measure -- --layer ui` | 0 | 112s | 19.84 | `perf-ui.log` | Ratchet passed |
| R2-6 | `npm run performance:measure -- --layer main` | 0 | 121s | ≈19 | `perf-main.log` | Ratchet passed |
| R2-7 | `npm run performance:measure -- --layer ipc` | 0 | 108s | ≈20 | `perf-ipc.log` | Ratchet passed |
| R2-5b | `--layer ui` 低负载复跑 | 0 | 64.7s | 10.57 | `perf2-ui.log` | Ratchet passed |
| R2-6b | `--layer main` 低负载复跑 | 0 | 71.1s | 8.45 | `perf2-main.log` | Ratchet passed |
| R2-7b | `--layer ipc` 低负载复跑 | 0 | 68.0s | 7.28 | `perf2-ipc.log` | Ratchet passed |
| R2-8 | `--dev-structure-only` | 1 | 6s | ≈20 | `structure-only.log` | 失败：`Modal DOM exit exceeded the Step03 limit: 316.8ms`（上限 250ms） |
| R2-9 | 既有超时两文件（`check-pacman-package.test.mjs`、`concurrency-trace-launcher.test.ts`） | 1 | 38s | ≈20 | `known-two-files-branch.log` | 分支 5 failed / 6 passed（11） |

三个性能层各跑两轮：第一轮在 load1≈20 下串行通过；为拿到真正的低负载证据，在 load1 7–11 下又把三层串行跑了一遍，仍全部 Ratchet passed。两轮都不放宽任何门限。

### 2.1 第一轮遗留问题的现状（只记录，不深挖）

| 问题 | 分支本轮 | main（`f708285a`）本轮 | 判定 |
|---|---|---|---|
| Step03 模态退出 250ms 上限 | 316.8ms，失败 | 311.6ms，失败 | 仍与 main 一致，属既有问题（`structure-only.log` / `B-structure-only.log`） |
| `check-pacman-package.test.mjs` + `concurrency-trace-launcher.test.ts` 5s 超时 | 5 failed / 6 passed | 6 failed / 5 passed | 两边都失败、失败文件相同，仍属既有问题（`known-two-files-*.log`） |

## 3. 场景验证

每个场景都有截图（`evidence/round-2/`）和一次 DOM 读数。

| 场景 | 结果 | 截图 | DOM 读数（要点） |
|---|---|---|---|
| 01（抽查） | 通过 | `01-main-reply.png` | 主会话出现 `codex side chat reply: parent`；侧栏只有会话行（`side chat reply parent`、`seed session`），全文无“侧聊”，无侧聊行 |
| 03（重跑） | 通过 | `03-side-chat-running.png` | 页签 `side chat hold v1 \| 运行中`；正文已显示用户原文 `side chat hold v1` 与“运行中”（第一轮这里是“首条消息的发送结果还没有确认”）；`[data-status="pending-first-send"]` 不存在；项目页签无该行，侧栏无“侧聊” |
| 07（抽查） | 通过 | `07-after-restart.png` | `restart` 后侧聊页签按原样恢复，正文保留被中断的一轮；在恢复的侧聊里再发 `side chat reply after restart` 收到回复；侧栏仍无侧聊行 |
| 09 | 通过 | `09-delete-dialog.png` | `[data-delete-side-chats="2"]`，文案“同时删除这个对话的 2 个侧边会话”，范围 1 个原生标识，无 `Error invoking remote method` |
| 10 | 通过 | `10-delete-result.png` | 结果“逻辑入口已删除”；主对话与两个侧聊 `summary.deletion.status` 都是 `complete`；`readSideChatSnapshot(child)` 被拒（“统一对话正在删除或已删除，正文不可用”）；`conversations.list(workspace)` 返回空 |
| 11 | 通过 | `11-delete-dialog.png` | 删除对话框拒绝并指名：`侧边会话「side chat hold busy」不能随主会话删除：对话仍有运行或证据保存未收敛，不能删除。请先在主会话的右侧面板处理它`；`Error invoking remote method` 出现 0 次；`确认删除` 按钮 disabled；主会话与侧聊都还在（随后读到 `12e2512a` 仍为 archived，侧聊 `fe31ce7f` 仍存在） |
| 14 | 通过 | 见下节 | 见下节 |

场景 09/10 用的是 README 里的统一对话路径：`window.scry.conversations.create(workspace)` 建统一对话 → 主输入框发 `side chat reply cascade parent` → `+` → 第一项“侧边会话”建两个侧聊（一个发 `side chat reply child` 并收到回复，另一个留空只建草稿）→ `#main-pane .conversation-options > summary` → “存档统一对话” → `[aria-label="删除统一对话"]`。侧聊草稿确实会以 0 轮的子对话落账（本轮 `f87b8eb0`），所以计数是 2。

## 4. 场景 14：运行中窗口被隐藏

数据：`docs/handoff/side-chat/local-verify/evidence/round-2/14-*.png`，实例目录 `…/T/scry-local-verify-MgcZFH`（分支构建）、`…/T/scry-local-verify-tcU3FO`（`e4b5ea9` 负对照）。

| 步骤 | 截图 | 判定条件 | 实测 |
|---|---|---|---|
| 可见且在流里 | `14-1-visible-live.png` | 有用户原文、有 `codex holding hidden`、有“运行中” | 全部满足；无 `pending-first-send`、无“首条消息的发送结果还没有确认”、无“历史正文需从其权威归档读取” |
| 伪造 `document.hidden=true` + `visibilitychange`，等 2s | `14-2-document-hidden.png` | 隐藏期间不得出现上述三种提示，仍要有用户原文和“运行中” | 满足：正文 `side chat hold hidden … 运行中`；三个提示都不存在 |
| 删除伪造、派发 `visibilitychange`，等 2s | `14-3-document-visible-again.png` | `holding hidden` 回来 | 满足：`codex holding hidden` 与工具行重新出现，提示仍不存在 |
| 真实最小化（AXMinimized） | `14-4-minimized.png` | 同样三条不得出现 | 满足：截图里侧聊正文明写用户原文与“运行中”，是运行中骨架而不是回执；`document.hidden=true`、三个提示 0 次 |
| 还原窗口 | `14-5-restored-after-minimize.png` | `holding hidden` 回来 | 满足 |
| 切到别的 App（Finder 到前台） | `14-6-other-app-front.png` | 不得出现三条提示 | 满足（此窗口未被完全遮挡，`hidden=false`、`hasFocus=false`） |
| 切回 Scry | `14-7-back-to-scry.png` | `holding hidden` 回来 | 满足 |
| **负对照**：`e4b5ea9` 构建，同样伪造隐藏 | `14-8-negative-control-old-build-hidden.png` | 修复前应出现错误提示 | 复现：正文为“第 1 轮：历史正文需从其权威归档读取”+“首条消息的发送结果还没有确认”，`[data-status="pending-first-send"]` 存在，用户原文消失 |

负对照用 `git worktree add ../scry-round2-old e4b5ea91` 单独构建（`out/main/index.js` 2829055 字节），跑同样步骤后已 `worktree remove`，临时目录保留。

补充事实：这台机器上 Chromium 的遮挡检测会让一个被别的窗口盖住的 Scry 窗口 `document.hidden=true`。本轮一开始没做任何伪造，侧聊就已经处于“隐藏”状态；修复后的构建在这种自然隐藏下同样显示用户原文 + “运行中”，而 `e4b5ea9` 在同一状态下显示的就是那两条错误提示。也就是说场景 14 描述的不只是人工伪造路径。

## 5. 本轮发现（非回归，供维护者判断）

1. **被中断的侧聊运行会异步收敛。** 在 `…/scry-local-verify-nDvoeg` 实例里，`side chat hold busy` 点“停止本轮”后，账本里那一轮先是 `pending` 且没有 native session，于是同 workspace/同 Provider 的删除预览一律被挡住，报的是通用原因“同一 Provider 的物理存储仍有未确认投递，不能证明删除范围安全”（点名侧聊那段仍正确）。约 15 分钟后同一轮读出来是 `accepted` 且有 native session，删除就不挡了。这是“证据没收敛就不删”的诚实实现，不是本分支回归；但“停掉运行后要等多久才能删”值得维护者确认是否可接受。
2. **通用原因仍可能出现。** 挡住删除的原因如果是子侧聊以外的会话（第 1 条那种），对话框会给通用原因；第 1 轮修的“点名侧聊”只在挡住者就是被点名的那个侧聊时生效。两者都发生在同一对话框里，用户看到的是“点名 + 通用原因”组合。
3. **`+` 菜单在右侧面板被隐藏时按钮尺寸为 0。** 需要用 `.panel-pill` 先把面板打开再点，否则点击目标是 0×0。这是操作顺序问题，不影响产品行为，记下来避免下次误判为 bug。

第一轮遗留的两个产品问题（`ConversationDeleteDialog` 未剥 IPC 包装、侧聊首条消息运行期间正文显示回执）本轮都已不存在：前者由 `8089195a` 修掉并在场景 11 验证，后者由同一个提交修掉并在场景 03/14 验证。

## 6. 未验证与限制

| 项 | 状态 | 原因 |
|---|---|---|
| 场景 12（原生会话级联删除的系统确认框） | 未执行 | 与第一轮相同：`screencapture` 无屏幕录制权限，`observe_ui` 抓不到原生确认框，无法截图或应答 |
| `npm run install:mac:dev` | 未运行 | 本轮任务书明确不跑；第一轮记录为失败（被 `test:unit` 两个既有 5s 超时文件阻断），本轮未改变 |
| `npm run test:unit` 全量 | 未跑 | 本轮任务书未列入；只按上一轮范围对比了两个既有超时文件与 main 的一致性 |
| 真实 Provider / 真实用户会话 | 未触及 | 全程 fixture + 临时 HOME/userData/workspace |

## 7. 现场

- 临时实例目录（全部已 `stop`，保留备查）：
  - `…/T/scry-local-verify-MgcZFH`：分支构建，场景 14 人工伪造与真实最小化/切 App
  - `…/T/scry-local-verify-tcU3FO`：`e4b5ea9` 负对照
  - `…/T/scry-local-verify-nDvoeg`：场景 11 与第一版 09/10 尝试（其中有被中断运行的收敛观察）
  - `…/T/scry-local-verify-VsikNN`：场景 09/10 最终取证实例
- 冒烟截图：`evidence/round-2/auto/`（来自 `…/T/scry-app-driver-C4s2zY`；该目录保留完整 `verification.json`，仓库里是 `verification-summary.json` 投影）
- main 对照 worktree `../scry-main-baseline` 与 `e4b5ea9` 对照 worktree（已删除）分别用于既有问题对比与场景 14 负对照。

## 8. 提交与推送

本轮只新增 `REPORT-2.md` 与 `evidence/round-2/`；没有代码改动，因此没有修复提交。
