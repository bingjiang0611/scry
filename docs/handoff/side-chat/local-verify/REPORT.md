# 侧聊 · 本地验证报告

> 截图与 `verification-summary.json` 是本 PR 的验证素材，按 PR 模板不进入 main。它们保存在分支 `claude/gracious-feynman-nlrtdp` 的提交 `8173a086` 中：`git show 8173a086:docs/handoff/side-chat/local-verify/evidence/<文件名>`。

- 结论：13 个场景里 12 个通过（11 修好后通过），1 个未执行（12，原生弹窗无法截图）。
  自动化检查 8 项通过，2 项失败，失败项在未改动的 `origin/main` 上同样失败（既有问题）。
- 本次修复 1 处：删除统一对话时，被一个刚发出首条消息、尚未收敛的侧聊挡住时，拒绝信息不点名侧聊。

## 1. 环境

| 项 | 值 |
|---|---|
| 验证 revision | `ab8ea74dcc5e87fea41e6e669ac19a61c1526c00`（`claude/gracious-feynman-nlrtdp`） |
| 修复后 revision | `dc213c0013c2c4cf612f8f6339659fb11b32ff58` |
| 系统 | macOS 27.3（Build 26C5035r），Darwin 27.3.0 arm64（Apple T6020） |
| Node / npm | v24.18.0 / 12.2.0 |
| 主基线 worktree | `../scry-main-baseline`，`origin/main` = `f708285a` |
| 依赖 | `npm ci`；Electron 42.10.1 的二进制由 `node node_modules/electron/install.js` 单独下载（该版本没有 `postinstall`，`npm ci` 不会拉二进制） |

**机器负载说明**：验证开始时这台机器负载极高（10 核，`load average` 60–240，swap 已用 15.9/17.4 GB，
user 自己的 App 与安全客户端占了大部分 CPU）。前 3 小时的所有超时类失败都出现在这个窗口内。
第 5 节末尾按低负载（`load average` 9–14）重跑了受影响的检查，两段结果都记录在下面，不混用。

## 2. 自动化检查

日志在 `/tmp/lv/`（本机临时目录，未提交）。`A*` 是分支，`B*/C*` 是 `origin/main` 对照。

| # | 命令 | 退出码 | 耗时 | 日志 | 结论 | main 对照 |
|---|---|---|---|---|---|---|
| A1 | `npx vitest run <任务书列出的 11 个文件>` | 0 | 13s | `vitest-side-chat-files.log` | 通过（11 files / 103 tests） | — |
| A2 | `npm run test:unit`（load 60–75） | 1 | 1539s | `test-unit.log` | 失败：21 files / 50 tests，全部 `Test timed out in 5000ms`，另有 2 个 `[vitest-worker] Timeout calling "onTaskUpdate"` | `B2-main-test-unit.log`：main 同样失败（62 个 5s 超时，load 100–237），失败集合随负载漂移 |
| A2′ | 同上 21 个失败文件，分支先跑、main 后跑 | 1 / 1 | 126s / 228s | `C-branch-failed21b.meta` / `C-main-failed21.meta` | 分支 7 failed / 145 passed；main 21 failed / 131 passed，同一批文件 | 两边都失败，是环境不是代码 |
| A2″ | `npm run test:unit`（低负载 load 9–14，含修复） | 1 | 730s | `A2b-unit-after-fix.meta` | 失败：2 files / 5 tests（`check-pacman-package` 4 个、`concurrency-trace-launcher` 1 个），仍全部 5s 超时 | main 单独跑这两个文件同样失败同样 4 个用例（`3 failed` × 2 次） |
| A3 | `npm run check:harness-bindings` | 0 | 5s | `check-harness-bindings.log` | 通过 | — |
| A4 | `node scripts/side-chat-workspace-races-smoke.mjs` | 0 | 2s | `side-chat-workspace-races-smoke.log` | 通过 | — |
| A5 | `node scripts/electron-security-smoke.mjs --dev-side-chat-only` | 0 | 183s | `electron-security-smoke-dev-side-chat-only.log` | 通过：execution / runtime / history / scroll / source deleted / restore / large history refusal / layout / drafts / restart / drafts restored / adoption 全部走完 | 任务书说容器里停在 `layout` 的 “Provider text was not shown verbatim”；macOS 本机没有复现（main 未跑此项，本项在分支通过即可） |
| A5′ | 同上（修复后） | 0 | 121s | `electron-smoke-side-chat-after-fix.log` | 通过 | — |
| A6 | `node scripts/electron-security-smoke.mjs --dev-side-chat-large-history-only` | 0 | 73s | `electron-security-smoke-large-history-only.log` | 通过：4010 条消息、22MB 归档、删除源后子记录 `complete` 且正文 `refused` | — |
| A7 | `node scripts/electron-security-smoke.mjs --dev-structure-only` | 1 | 6s | `electron-security-smoke-structure-only.log` | 失败：`Modal DOM exit exceeded the Step03 limit: 339.2ms`（上限 250ms） | 既有问题。main 同样失败：`B7-main-...log` 327.8ms（load 46）；低负载复跑 `A7b` 309.9ms vs `B7b` 309.0ms（load 8.7–8.9），不是负载 |
| A8 | `npm run test:conversation:ipc:prebuilt` | 0 | 59s | `test-conversation-ipc-prebuilt.log` | 通过（ownership + unified conversation 两段） | — |
| A9 | `npm run performance:measure -- --layer ui` | 0 | 166s | `performance-measure-ui.log` | 通过，`Ratchet: passed` | — |
| A10 | `npm run performance:measure -- --layer main` | 0 | 150s | `performance-measure-main.log` | 通过，`Ratchet: passed` | — |
| A11 | `npm run performance:measure -- --layer ipc` | 1 | 132s | `performance-measure-ipc.log` | 失败：`runtime-evidence.counters.test.ts` 1 个 5s 超时 | 既有问题。main 同样失败（`B11-main-performance-measure-ipc.log`，同文件 3 个超时） |
| A9′/A10′/A11′ | 上面三层（修复后，低负载 load 10–14） | 0/0/0 | 87s/88s/88s | `perf-ui-after-fix.log` / `perf-main-after-fix.log` / `perf-ipc-after-fix.log` | 全部通过，`Ratchet: passed` | — |

- `--dev-side-chat-only` 的产物：`captures` = `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-app-driver-NX0SKI`，
  `verification.json` 在同目录。侧栏/侧聊相关的 4 张截图和一份裁剪后的 `verification-summary.json`（15 KB，
  只保留 firstRender/runtime/history/scroll/sourceDeleted/restore/layout/largeRefusal/drafts/workbench/adoption/restart/isolation）
  复制到了 `evidence/auto/`。
- A7 失败同时导致 `structure-side-chat-checks.mjs`（侧聊的结构检查）没有跑到；见第 6 节。

## 3. 手动场景

独立 test 实例：`docs/handoff/side-chat/local-verify/test-instance.mjs`，临时 HOME / userData / 工作区，
Provider 是内置 fixture，未加 `--no-sandbox`。

| 编号 | 结论 | 截图 | DOM 读数摘要 |
|---|---|---|---|
| 01 | 通过 | `01-main-reply.png` | 主会话有 `codex side chat reply: parent`；侧栏 `.sb-list` 只有 `side chat reply parent`、`seed session` 两行；`侧聊` 出现 0 次；`[data-conversation-id]` 0 个 |
| 02 | 通过 | `02-side-chat-created.png` | 页签 `侧边会话`；面板空态 `开始侧聊 / 已带入主会话最近完成的消息`；侧栏无 `侧聊`/`侧边会话` 字样，行数仍 2 |
| 03 | 通过 | `03-side-chat-running.png` | 页签 `side chat hold v1|运行中`；侧栏文本仍只有两行，不含 `侧聊`，不含 `side chat hold v1` |
| 04 | 通过 | `04-activity-running.png` | 动态页签 1 行：`data-activity-group=working`、行文本 `side chat reply parent`（主会话行），没有侧聊自己的行 |
| 05 | 通过 | `05-activity-after-stop.png`、`05b-projects-after-stop.png` | 停止后页签回到 `side chat hold v1`（无状态词）；动态 1 行 `completed|side chat reply parent`（仍是主会话行，数量没增加）；项目页签 2 行，`[data-conversation-id]` 0 个 |
| 06 | 通过 | `06-history-dialog.png`、`06b-reopened-tab.png` | 历史对话框 `共 2 个侧边会话`，列出 `side chat reply second`、`side chat hold v1`；点回后页签恢复，面板内含 `codex side chat reply: second` |
| 07 | 通过 | `07-after-restart.png` | 重启后页签 `side chat hold v1`、`side chat reply second` 原样恢复；侧栏 2 行无 `侧聊`；再发 `side chat reply after restart` 收到 `codex side chat reply: after restart` |
| 08 | 通过 | `08-unified-with-side-chats.png` | 统一对话 1 行（`对话 d96b08b5/1 轮`）；两个侧聊页签 `side chat reply child`、`侧边会话`；侧栏 `侧聊` 出现 0 次，`[data-conversation-id]` 1 个 |
| 09 | 通过 | `09-delete-dialog.png` | `[data-delete-side-chats="2"]`，文案 `同时删除这个对话的 2 个侧边会话`；范围 1 个原生标识 |
| 10 | 通过 | `10-delete-result.png` | 结果 `逻辑入口已删除`；两个子会话 `read(id).summary.deletion.status = complete`，`readSideChatSnapshot(id)` 被拒绝 |
| 11 | 修复后通过 | `11-refused-delete.png` | 修复前：`Error: …同一 Provider 的物理存储仍有未确认投递，不能证明删除范围安全`（不点名）。修复后：`…侧边会话「side chat hold busy」不能随主会话删除：对话仍有运行或证据保存未收敛，不能删除。请先在主会话的右侧面板处理它`；两边 `deletion.status` 都是 `null`，子会话仍在运行 |
| 12 | 未执行 | — | 见第 5 节：系统原生 sheet 截不到，也没有脚本化回答它的合法入口 |
| 13 | 通过 | `13-light-theme-running.png`、`13-narrow-running.png` | 浅色主题下页签 `side chat reply second|运行中`，侧栏 2 行无 `侧聊`，`scrollWidth == clientWidth`（无横向溢出）；窗口宽 900px（`window.resizeTo`，真实窗口，非 deviceMetrics 模拟）时 `innerWidth=900`，侧栏 230 / 右侧 662 / 主区 0（单列布局），无横向溢出，侧栏仍干净 |

补充：场景 03 的侧聊在首条消息运行期间，面板正文显示“首条消息的发送结果还没有确认”，看不到正在生成的这一轮；
停止后才显示该轮。合规性不在本任务书的产品规则里，只记录现象（见第 6 节）。

## 4. 本次修复

| SHA | 内容 |
|---|---|
| `dc213c00` | `fix(side-chat): name the side chat that holds a parent delete` |

- **现象**：统一对话有一个刚发出首条消息、`delivery=pending` 且还没有 native session id 的侧聊时，
  删除预览被拒绝，但信息是 `同一 Provider 的物理存储仍有未确认投递，不能证明删除范围安全`，没有点名侧聊。
  产品规则要求“整个删除被拒绝并指出是哪一个”。
- **根因**：`previewWithSideChats` 先算父会话自己的计划。`planConversationDeletion` 会遍历同工作区的兄弟会话，
  这个刚发首条的侧聊正好命中那条“同一 Provider 仍有未确认投递”的守卫（该守卫早于本分支存在），
  于是 `planSideChats` 里那段会点名侧聊的拒绝永远没有机会执行。
- **修复**：先规划子侧聊，再规划父会话（`src/main/bootstrap/conversation-delete.ts`，10 行）。
  仍然是整个删除被拒绝、什么都不删，只是保留了点名的那条信息。
- **回归测试**：`src/main/bootstrap/conversation-delete.test.ts` 新增
  `names a side chat whose first send has not settled instead of the parent scope guard`。
  用 `current.pending = true` 造出“首条消息已派发但没收敛”的子会话。
  修复前用旧顺序跑会拿到那句通用信息（实测：`expected … but got '同一 Provider 的物理存储仍有未确认投递，不能证明删除范围安全'`），
  修复后通过。
- **跑过的检查**：`vitest` 11 个侧聊相关文件（104 pass）、`npm run typecheck`、`npm run build`、
  `performance:measure` 的 main/ui/ipc 三层（`Ratchet: passed`）、`--dev-side-chat-only`（含 source deleted/adoption）。
  真实 App 上按场景 11 重放，修复前后的信息差异见场景表。

## 5. 未验证项

1. **场景 12（原生会话的级联删除确认框）未执行。**
   这条路径的确认框是 `dialog.showMessageBox` 的原生 sheet。本机上 `screencapture -x -R…` 返回
   `could not create image from rect`，`observe_ui` 对该窗口也返回 `Failed to start stream due to audio/video capture failure`
   —— 都没有屏幕录制/捕获权限；同一权限下也没有脚本化点“删除”的合法入口（不做 OS 级鼠标键盘），
   所以既截不到图也无法可靠回答它。替代证据（不是 App 级证明）：
   `src/main/bootstrap/session-deletion-side-chats.test.ts` 4 个用例通过，
   `--dev-side-chat-only` 的 `source deleted` 步骤覆盖了删除源之后子记录 `complete`、正文 `refused`。
2. **`--dev-structure-only` 没通过，因此 `scripts/structure-side-chat-checks.mjs`（侧聊的结构检查）没有跑到。**
   该脚本挂在 `structure-app-checks.mjs` 的流程里，在第 4 步之前就被 Step03 的 250ms 上限挡下。
   即使 `origin/main` 也一样，所以没有去改测试或上限。
3. **Linux 未验证**：本次只在 macOS 宿主上跑，没有 Linux 目标机。
4. **`test:unit` 未全绿**：低负载下仍有 2 个文件 5 个用例 5s 超时（`check-pacman-package`、
   `concurrency-trace-launcher`），这两个文件本分支没有改过，未改动的 main 同样失败；没有调大超时也没有 skip。
   其余 616 个文件 / 5719 个用例通过。
5. **场景 13 的窄窗口**用页面内 `window.resizeTo(900,1000)` 改变真实窗口宽度（`innerWidth` 从 1280 变 900），
   不是拖动标题栏；窗口高度受系统限制为 886。布局结论只对 900×886 成立。

## 6. 需要维护者/云端 Agent 决定的问题

1. **Step03 的 250ms 模态退出上限在这台机器上稳定超标**（309–339ms，load 8.9 与 46 都一样，main 也超标）。
   这台机器上 `--dev-structure-only` 永远失败，连带侧聊结构检查无法验证。需要决定是放宽上限、
   还是先查明这台机器上动画/合成器为什么慢。证据：`/tmp/lv/electron-security-smoke-structure-only.log`、
   `/tmp/lv/B7b-main-structure-lowload.log`。
2. **删除对话框把 IPC 包装层暴露给用户**：场景 11 的报错前带有
   `Error: Error invoking remote method 'conversation:previewDeletion': Error:` 前缀。
   `ConversationDeleteDialog` 直接 `${String(error)}`（该行不是本分支新加的），而侧聊入口那边有
   `SIDE_CHAT_COPY.reasonOf` 会剥掉包装层。属于范围外，未改。需要决定是否统一走 `reasonOf`。
3. **侧聊首条消息运行期间正文显示“发送结果还没有确认”，看不到正在生成的一轮**（场景 03）。
   页签和 Composer 都显示“运行中”，正文却是未确认提示；停止后才显示该轮。
   不清楚这是刻意的（回执优先）还是渲染顺序问题，且不在本任务书的产品规则内，未改。
4. **`test:unit` 里 `check-pacman-package` / `concurrency-trace-launcher` 两个文件的 5s 上限**：
   main 与分支同样超标，属于既有问题，按范围外只记录。

## 7. 安装（`npm run install:mac:dev`）

**失败，未安装。** 退出码 1，耗时 717s（`/tmp/lv/06-install-mac.meta`）。

`install:mac:dev` = `npm run pack && node scripts/install-macos.mjs`，而 `pack` = `typecheck && npm test && pack:artifact`。
typecheck 通过，停在 `npm test`：仍然只有 `scripts/check-pacman-package.test.mjs`（4 个）和
`scripts/concurrency-trace-launcher.test.ts`（1 个）这 5 个 5s 超时（`2 failed | 616 passed`，`5719` 个用例通过），
与第 2 节 A2″ 同两个文件、同 5 个用例。按规矩没有绕过打包校验去单独跑 `pack:artifact`，
所以这次没有产出安装包，`/Applications/Scry.app` 没有被这次验证更新。
“已安装，需用户自行重启才会加载”不成立：用户当前运行的 Scry 仍是旧版本。

## 8. 现场

- test 实例临时目录（保留）：
  - 场景 01–13 首次：`/private/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-local-verify-gjCAvr`
  - 修复后重放场景 11：`/private/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-local-verify-oGxkcd`
  - 均已 `stop`；未停止、未重启用户正在使用的 Scry。
- 冒烟 captures：`…/T/scry-app-driver-NX0SKI`（修复后）、`…/T/scry-app-driver-HwZ5qX`（修复前）。
- main 对照 worktree：`../scry-main-baseline`（用完未删除，留给需要复跑的人；`git worktree remove ../scry-main-baseline` 可清掉）。
