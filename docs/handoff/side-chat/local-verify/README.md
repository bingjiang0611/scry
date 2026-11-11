# 侧聊 · 本地验证任务书（交给本地 Agent）

- 分支：验证用的任务分支（交接时指定）。修复提交和报告推到这个分支；截图不推送，见下文。不自行开 PR，不合入 main。
- 协作方式：你（本地 Agent）尽量一次做完全部验证和范围内修复，自己判定通过或失败，把修复和报告推上来，截图作为 PR 附件。云端 Agent 只读你推上来的提交和报告做核验。不要中途停下来问“要不要继续”；只有遇到下文“必须停下”的情况才停。
- 先读仓库根目录的 `CLAUDE.md`，再读本文件。两者冲突时以 `CLAUDE.md` 为准。
- **截图一律不提交进仓库**：写到本地 `docs/handoff/side-chat/local-verify/evidence/`（已加入 `.gitignore`），作为附件上传到 PR，报告里写文件名。下文所有“截图放进 `evidence/…`”都指这个本地目录。前两轮的截图是在这条规则之前提交的，只保留在分支提交 `8173a086` 里。

## 1. 这个分支改了什么

| 提交 | 内容 |
|---|---|
| `195ca18` | 侧栏不再列出侧聊（删掉“来源不在当前项目列表中的侧边会话”分组和动态页签里的侧聊行）；宿主拒绝的创建不再把入口卡成“只能核对旧命令” |
| `21aa559` | 删除主会话时级联删除它的侧聊（统一对话和原生会话两条路径）；去掉主会话行上的 `N 侧聊` 计数 |
| `d4a5527` | 合入 `scry/612438d3`：统一对话的 Dock/未读提醒，以及侧聊界面简化（去掉快照阅读器和重复的关闭/刷新按钮） |
| `ab8ea74` | 侧聊首轮运行期间，它的 Provider 会话行漏进侧栏（实测发现，已修）；新增本任务书和测试实例工具 |
| `dc213c0`（第一轮本地验证） | 删除被首条消息未收敛的侧聊挡住时，拒绝信息改为点名该侧聊 |
| 第二轮修复 | ① 运行中的一轮在实时流还没接上时（窗口隐藏、还在连接）不再显示成“首条消息的发送结果还没有确认 / 历史正文需从其权威归档读取”，而是显示“运行中”和用户发出的原文——第一轮报告 6.3 的现象，也是用户说“用不了”的来源之一；② 删除对话框的报错去掉 `Error invoking remote method …` 前缀（第一轮报告 6.2） |

产品规则（已由维护者确认，验证时以此为准，不要“修回去”）：

1. 侧栏（项目页签、动态页签）里不出现任何侧聊：没有行、没有分组、没有计数，也不出现“侧聊”二字。
2. 侧聊运行中或等待回答时，动态页签把它的**主会话行**放进“进行中 / 需要回复”；已结束的侧聊不产生任何行。
3. 侧聊只能从主会话右侧面板进入：页签栏、`+` 菜单里的“侧边会话”和“历史侧边会话”。
4. 删除主会话会一并删除它的侧聊。统一对话的删除对话框要列出侧聊数量；原生会话的确认框写明数量。有侧聊正在运行或投递未收敛时，整个删除被拒绝并指出是哪一个，什么都不删。
5. 主会话只是存档时，侧聊保留。

## 2. 规矩（违反任何一条都算任务失败）

- 只用**独立 test 实例**：临时 HOME、临时 userData、临时工作区。不要停止、重启或操作用户正在用的 Scry，不要读写真实的 `.scry`、transcript、数据库。
- 不用真实 Provider（不花钱、不用账号）。测试实例里的 Provider 是仓库自带的 fixture。
- 不加 `--no-sandbox`，不放宽 CSP，不删断言，不 skip，不加 sleep 或调大超时来“变绿”。确实需要改测试，在提交说明里写依据。
- 提交身份固定为 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`：`git -c user.name=bingjiang0611 -c user.email=307659028+bingjiang0611@users.noreply.github.com commit ...`。不要改全局 `user.email`。
- 推送前 `git fetch origin claude/gracious-feynman-nlrtdp && git rebase origin/claude/gracious-feynman-nlrtdp`，不 force push。
- 单个文件不超过 20,000 字节（`npm run check:staged-file-size` 会拦）。截图 PNG 不受这个限制，但每张控制在 1 MB 以内。

**第二轮重点**：场景 03、11、14，以及第 4 节的自动化检查（`--dev-side-chat-only`、`test:conversation:ipc:prebuilt`、三层 `performance:measure`）。第一轮已通过且这次没有改到的场景可以只抽查 01、07、09、10。第一轮报告里的既有问题（Step03 的 250ms 上限、`check-pacman-package`、`concurrency-trace-launcher`）不要再花时间排查，只记录结果是否与 main 一致。

**必须停下并在报告里说明的情况**：需要真实 Provider 或花钱；需要改上面第 1 节的产品规则；需要改权限、trust、删除范围这类安全边界；同一个失败两次修复后仍不明。

## 3. 第一步：准备

```bash
git fetch origin claude/gracious-feynman-nlrtdp
git checkout claude/gracious-feynman-nlrtdp
git pull --ff-only
npm ci
npm run typecheck
npm run build
```

记录 `git rev-parse HEAD`、`sw_vers`（或 `uname -a`）、`node -v`。报告里所有结论都对应这个 revision。

## 4. 第二步：自动化检查（全部跑，逐条记录）

每条记录：命令、退出码、耗时、完整日志的本地路径、失败时的第一条报错。毫秒类测量串行跑，不要和别的重任务同时跑（并发负载会造成假超时）。

```bash
npx vitest run src/main/bootstrap/conversation-delete.test.ts src/main/bootstrap/session-deletion-side-chats.test.ts \
  src/main/conversation-catalog-ownership.test.ts src/main/conversation-deletion.test.ts \
  src/renderer/sidebar-activity.test.ts src/renderer/side-chat-index.test.ts src/renderer/side-chat-create.test.ts \
  src/renderer/side-chat-surface.test.tsx src/renderer/hooks/useConversationAttention.test.ts \
  src/main/bootstrap/conversation-attention.test.ts src/main/dock-badge.test.ts
npm run test:unit
npm run check:harness-bindings
node scripts/side-chat-workspace-races-smoke.mjs
node scripts/electron-security-smoke.mjs --dev-side-chat-only
node scripts/electron-security-smoke.mjs --dev-side-chat-large-history-only
node scripts/electron-security-smoke.mjs --dev-structure-only
npm run test:conversation:ipc:prebuilt
npm run performance:measure -- --layer ui
npm run performance:measure -- --layer main
npm run performance:measure -- --layer ipc
```

- `--dev-side-chat-only` 会打印 `captures` 目录和 `verification.json`。把其中与侧栏、侧聊相关的截图复制到 `docs/handoff/side-chat/local-verify/evidence/auto/`。
- 云端 Linux 容器里已知的情况，供你对照，不代表 macOS 上也该失败：
  - `--dev-side-chat-only` 在容器里通过了 `execution`、`runtime`、`history`、`scroll`、`source deleted`、`restore`、`large history refusal`，停在 `layout` 的 “Provider text was not shown verbatim”。未改动的 main 在同一容器里停在同一步、同样的报错。
  - `--dev-side-chat-large-history-only` 在容器里因 300 秒内翻不完 4006 条快照而超时，未改动的 main 也一样。注意：合入 `scry/612438d3` 后快照阅读器和这段翻页检查已经删掉，所以现在这一项只检查大历史的发送、读取，以及删除主会话后侧聊被一并删除。
  - 以 root 运行时，`MarkdownLayout`、`SessionRename` 等 Electron 夹具测试会因 sandbox 拒绝 root 而失败；`scripts/owned-app-processes.test.mjs` 在未改动的 main 上同样失败。
- 任何失败，先用未改动的 main 做对照再下结论：

  ```bash
  git worktree add ../scry-main-baseline origin/main
  cd ../scry-main-baseline && npm ci && npm run build
  ```

  在里面跑同一条命令。main 也失败的记为“既有问题”；只在本分支失败的才是回归，必须修或者说明原因。用完删除这个 worktree：`git worktree remove ../scry-main-baseline`。

## 5. 第三步：在独立 test 实例上手动验证并截图

工具：`docs/handoff/side-chat/local-verify/test-instance.mjs`。它用 `out/` 里的构建启动一个可见窗口的实例，HOME、userData、工作区都是临时目录，Provider 是 fixture，并开一个 CDP 端口用来截图和点击。用之前先 `npm run build`。

```bash
V=docs/handoff/side-chat/local-verify/test-instance.mjs
node $V start                      # 打印临时目录、端口、pid
node $V shot 01-start              # 截图写入 docs/handoff/side-chat/local-verify/evidence/01-start.png
node $V eval 'document.title'      # 在页面里求值，打印 JSON
node $V click '<css 选择器>'        # 在元素中心做真实点击；被遮挡会报错
node $V type '文字'                 # 往当前焦点输入
node $V key Enter                  # Enter / Escape / Tab / Backspace
node $V restart                    # 同一个 userData 重启进程
node $V stop
```

Fixture Provider 认这几种输入：`side chat reply <文字>` 立即完成；`side chat hold <标记>` 一直运行，直到点“停止本轮”；`side chat write <名字>` 在工作区写一个文件。

常用选择器：

```text
S  = #right-surface-pane [data-session-surface-current="true"]
侧聊面板     $S [data-side-chat-panel]:not([hidden])
侧聊输入框   $S [data-side-chat-panel]:not([hidden]) .runtime-composer textarea
侧聊发送     $S [data-side-chat-panel]:not([hidden]) .send
主输入框     #main-pane .runtime-composer textarea      主发送  #main-pane .send
选择器卡片   $S [data-surface-chooser] [data-side-chat-entry]
关掉工具页签  $S .surface-tab-close                       + 菜单  $S button[aria-label="添加 Surface"]
+ 菜单项     #right-surface-pane .surface-menu [role=menuitem]   （第 1 项“侧边会话”，第 2 项“历史侧边会话”）
侧栏页签     #sidebar-pane [role="tab"]                  动态条目  #sidebar-pane .sb-activity-item[data-activity-group]
右侧面板开关  .panel-pill:not(.summary-pill)
侧栏全文     document.querySelector('#sidebar-pane .sb-list').innerText
```

每个场景都要：截图（名字用下面的编号），并用 `eval` 读一次 DOM 作为文字证据，写进报告。截图只能证明“看起来对”，DOM 读数证明“确实对”，两样都要。

| 编号 | 场景 | 通过标准 |
|---|---|---|
| 01 | 点侧栏里的 `seed session`，点“新建会话”，打开右侧面板，在主输入框发送 `side chat reply parent` | 主会话出现回复；侧栏只有主会话行 |
| 02 | 关掉工具页签露出选择器，点“侧边会话”卡片 | 右侧出现侧聊页签和空态；侧栏全文里没有“侧聊” |
| 03 | 在侧聊里发送 `side chat hold v1` | 页签显示“运行中”；项目页签里**没有** `side chat hold v1` 这一行（这是本轮修掉的 bug）；侧栏全文没有“侧聊” |
| 04 | 切到“动态”页签 | 主会话行在“进行中”分组；没有侧聊自己的行 |
| 05 | 回到侧聊点“停止本轮”，等结束后再看两个侧栏页签 | 两个页签都没有侧聊行；动态里不因侧聊结束新增行 |
| 06 | 用 `+` 菜单再建一个侧聊，发送 `side chat reply second`；关掉这个页签，再从 `+` → “历史侧边会话”打开它 | 历史对话框列出它；点击后页签回来，内容在 |
| 07 | 侧聊空闲时 `node $V restart`，重新点主会话、打开右侧面板 | 侧聊页签按原样恢复；侧栏依旧干净；在侧聊里能再次发送并收到回复（对应用户反馈的“打不开、用不了”） |
| 08 | 统一对话的级联删除，准备：先 `node $V state` 取 `workspace` 路径，再 `node $V eval "window.scry.conversations.create('<workspace 路径>').then(c => c.id)"` 建一个统一对话；在侧栏点它（`[data-conversation-id="<id>"]`），在主输入框发送 `side chat reply cascade parent`；给它建 2 个侧聊，一个发 `side chat reply child`，另一个保持空白 | 侧栏里只有这个统一对话一行 |
| 09 | 在这个统一对话里点 `#main-pane .conversation-options > summary`，等 `#main-pane [aria-label="存档统一对话"]` 可点后点它（按钮文字“存档”），再点 `#main-pane [aria-label="删除统一对话"]`（按钮文字“删除副本…”） | 删除对话框里有 `[data-delete-side-chats]`，值为 2，文案写明一并删除 |
| 10 | 点“确认删除 Scry 副本” | 结果为“逻辑入口已删除”；两个侧聊 `window.scry.conversations.read(id)` 的 `summary.deletion.status` 都是 `complete`，`readSideChatSnapshot(id)` 被拒绝 |
| 11 | 运行中拒绝删除：再建一个统一对话加一个侧聊，侧聊发送 `side chat hold busy`，然后存档并尝试删除主会话 | 删除对话框报错，并指名那个侧聊“不能随主会话删除”；报错文字里**没有** `Error invoking remote method`；停掉侧聊之前，主会话和侧聊都没有被删 |
| 12（可选） | 原生会话的级联删除：对 01 的主会话做存档再删除。确认框是系统原生弹窗，`eval` 截不到 | 有截屏和点击能力（例如 computer use，或已授予屏幕录制权限的 `screencapture -x`）时，截图确认框里有“个侧边会话会一并删除”；做不到就在报告里标“未执行”，不要冒充通过 |
| 13 | 浅色主题和窄窗口各截一张 03 的状态（设置里切主题；窗口宽度拖到约 900px） | 侧栏同样干净，没有布局溢出 |
| 14 | 侧聊运行中窗口被隐藏：侧聊发送 `side chat hold hidden`，确认正文出现 `holding hidden` 后，执行 `node $V eval "(() => { Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); return document.hidden })()"`，等 2 秒截图；再执行 `node $V eval "(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); return document.hidden })()"`，等 2 秒截图。另外真实地把窗口最小化或切到别的 App 再切回来，各截一张 | 隐藏期间：侧聊正文里**没有** `[data-status="pending-first-send"]`、没有“首条消息的发送结果还没有确认”、没有“历史正文需从其权威归档读取”；仍能看到用户原文 `side chat hold hidden` 和“运行中”。恢复后 `holding hidden` 回来。修复前（`git stash` 或用 `e4b5ea9` 构建）同一步会出现上述错误提示，做一次负对照并截图 |

做完 `node $V stop`。临时目录保留，路径写进报告。

## 6. 第四步：发现问题怎么办

- 本分支范围内（侧栏显示侧聊、侧聊入口与创建、级联删除、本分支改过的冒烟脚本）的回归，直接修：
  - 修复配一个最小的回归测试；证明它在修复前失败、修复后通过。
  - 跑受影响的检查。
  - 单独提交，提交说明写清原因、证据、跑过哪些检查。
- 测量代码和优化代码分开提交，不缩小测试负载。
- 范围外的问题只记录，不顺手改。

## 7. 第五步：报告和推送

1. 截图写进本地 `docs/handoff/side-chat/local-verify/evidence/`（自动化截图放 `evidence/auto/`），不提交，上传为 PR 附件。
2. 第二轮把结果写进新文件 `docs/handoff/side-chat/local-verify/REPORT-2.md`（不要改第一轮的 `REPORT.md`），截图写进本地 `evidence/round-N/`，同样不提交。格式与第一轮相同，按顺序写：
   - 环境：revision、系统和版本、Node、机器负载说明。
   - 自动化检查表：命令、退出码、耗时、日志路径、结论（通过 / 失败 / 既有问题，附 main 对照结果）。
   - 手动场景表：编号、结论、截图文件名、DOM 读数摘要。
   - 你做的修复：每个提交的 SHA、原因、证据、跑过的检查。
   - 未验证项和原因。
   - 需要云端 Agent 或维护者决定的问题，每条写清现象和证据。
3. 运行 `git diff --check` 和 `npm run check:staged-file-size`，提交（固定身份），按第 2 节的方式 rebase 后推送。
4. 全部通过后，按 `CLAUDE.md` 的约定在 macOS 上执行 `npm run install:mac:dev`，把结果写进报告。不要重启用户正在运行的 Scry；报告里注明“已安装，需用户自行重启才会加载”。安装失败就如实写。

报告里不要贴会话正文、token 或任何本机私人路径以外的个人信息。
