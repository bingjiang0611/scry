# 侧边会话最终交付（App 0.2.231 / 私有 CLI 0.2.53）

状态：功能实现完成、全量门禁通过，本功能的构建**当前安装在 `/Applications/Scry.app` 并通过校验**（2026-10-29 08:57:49，用户批准的恢复重装）：App `0.2.231`、bundle id `com.scry.app`、私有 CLI `0.2.53`、`Contents/Resources/app.asar` SHA-256 `5711c0599fcb925fc33a48077ccfb8770eb1d6a25310849b8a74019e73a2ae1c`，与构建产物 `dist/mac-arm64/Scry.app` 相同。时间线：08:38:40 首次安装 → 08:44:55 被另一份 worktree 构建替换 → 08:57:49 重装恢复；前两次的实测事实保留在“交付后复核”。未 push、未 `npm publish`、未安装全局 CLI、未升版本；未启动、退出或重启任何 App 实例。

## 分发身份

- 源码冻结 `72ec35cc`（代码）；其后的提交只改版本与文档。
- 本文件之前的两个提交：`1a5340c7`（证据表述校订，纯文档）、`18326f4c`（版本）。
- **安装产物的构建提交是 `18326f4c`**（工作区干净，`dist/`、`out/` 均为 gitignore 产物）。
- App `0.2.231`，bundle id `com.scry.app`；私有 CLI `0.2.53`（`RECORDER_VERSION` 与 CLI 包版本由 `version.test.ts` 锁定）。
- `Contents/Resources/app.asar` SHA-256 `5711c0599fcb925fc33a48077ccfb8770eb1d6a25310849b8a74019e73a2ae1c`，与本次构建产物 `dist/mac-arm64/Scry.app/Contents/Resources/app.asar` 相同；08:57:49 重装后这个文件就在 `/Applications/Scry.app` 里（08:44:55 曾被另一份构建替换，见下节）。
- 签名：Apple Development `baobingjiang@icloud.com (8Y6KR78CP7)`，`TeamIdentifier=7USHN8Q8JL`。**未公证**：`install:mac:dev` 是开发安装路径（`verifyReleaseBundle` 仅在 `--require-release` 下执行），不是签名/公证正式发布。

版本决策：CLI 升 `0.2.53` 不是形式动作——`normalizeTurnDiffSnapshot` 现在保留 `workspaceOverlap`，属于内置 CLI 对外可见的运行合同；App 只升一次 `0.2.231`。根 README 的两行 npm 安装示例与 CLI README 的安装行已同步到 `0.2.53`（此前分别停留在 `0.2.51`、`0.2.52`）。

## 交付后复核：安装被替换，以及用户批准的重装恢复

交付后再次检查发现磁盘状态被外部改变；随后用户明确批准把本功能的已验证产物装回 `/Applications`。只记录实测事实，不推断其他会话的意图：

| 时间（2026-10-29） | 实测事实 |
|---|---|
| 08:38:40 | 本轮 `install:mac:dev` 安装完成：App `0.2.231`、bundle id `com.scry.app`、`app.asar` `5711c0599fcb925fc33a48077ccfb8770eb1d6a25310849b8a74019e73a2ae1c`、私有 CLI `Contents/Resources/bin/scry --version` → `0.2.53`（父会话当时也独立复核过这一组值） |
| 08:43:03 | 交付文档提交 `81f2b822`（上面那组值当时仍成立） |
| 08:44:55 | `/Applications/Scry.app` 被另一份构建替换：App 仍为 `0.2.231`、`com.scry.app`，但 `app.asar` 为 `e50300589afaccc8121cd9bb7aad27eb0bb9246d255200304a4a13b11582edd8`，内置 CLI 为 `0.2.52` |
| 复核时 | `e5030058…` 与并行 worktree `…/909f5f8b-f156-4d0e-8c61-c95102bc1a55/dist/mac-arm64/Scry.app` 的 `app.asar` 哈希相同（只做只读哈希对比） |
| 08:57:40（重装前复核） | `/Applications/Scry.app` 仍是 `e5030058…`、CLI `0.2.52`；`/Applications/.Scry.app.backup` 是 `5711c059…`、CLI `0.2.53`；`dist/mac-arm64/Scry.app/Contents/Resources/app.asar` 仍是 `5711c059…`；`/Applications` 下无 `.scry-install.lock`、无 journal、无 staging 残留 |
| 08:57:49（用户批准重装） | 在仓库根用 Node `22.22.1` 执行既有原子安装器 `node scripts/install-macos.mjs`（使用既有 `dist/` 产物，非手工复制），退出码 0，输出 `/Applications/Scry.app` 与 `backup: /Applications/.Scry.app.backup` |
| 08:57:54（重装后复核） | `/Applications/Scry.app`：App `0.2.231`、`com.scry.app`、`app.asar` `5711c059…`（等于 `dist/`）、内置 CLI `0.2.53`；`codesign --verify --deep --strict` → `valid on disk` / `satisfies its Designated Requirement`；`/Applications/.Scry.app.backup` 变为被替换出的 `e5030058…`（CLI `0.2.52`）；无 lock/journal/staging 残留 |

备份与仍可取得的产物：

- `/Applications/.Scry.app.backup` 现在是**被替换出去的那份**（`e5030058…`、CLI `0.2.52`，目录时间 `08:44:55`）。这是既有安装器的固定轮转：重装时先删除旧备份目录，再把当时的 `/Applications/Scry.app` 移入。因此 08:38 那份本功能产物已不在备份集里，它的权威位置现在是 `/Applications/Scry.app` 本身与 `dist/mac-arm64/Scry.app`。本轮按用户要求**没有**手工搬动备份目录。
- 6 个更早的 `preserved` 备份目录未被删除或改写（`0.2.182` ×2、`0.2.186`、`0.2.190`、`0.2.191`、`0.2.196`；重装前后只比 metadata：mtime/uid/gid 全部相同）。
- 本功能构建产物仍在 worktree `…/ef59bc16-f36d-4742-8e96-e8bf919c3a70/dist/mac-arm64/Scry.app`（`app.asar` `5711c059…`，gitignore 产物），重装未改变它。

结论与边界：本文档的功能证据来自冻结源码（`72ec35cc`）的隔离隐藏实例，与安装轮转无关；当前 `/Applications/Scry.app` 的字节内容已等于本功能的已验证产物。这次重装只替换 `/Applications/Scry.app` 这一个 App bundle，没有合并其它 worktree 的代码、没有改动它们的 WIP、没有停止其它会话的进程。

## 本轮功能覆盖

侧边会话（side chat）在现有会话旁并行运行，主会话不被替换：

- 主会话保持原 Provider 原生 session 与轮次；用户显式选择后，父会话的原生 session 被纳入一个 logical conversation（adoption），绑定仍是同一个原生 session（实测 codex `smoke-session-run-mvtoau68-0`），子会话记录、3 个标签与正在运行的 run 都不变。
  这条证据只覆盖**显式 adoption** 这一条路径；没有测过“把主会话换成另一个 Provider 的普通会话”那种更宽的含义，因此不据此宣称 Provider 切换的通用结论。
- 子会话自己的 Provider 运行、工具调用、文件写入与标签页（`right-surface-storage` durable 命名空间）独立。
- 来源快照只读：冻结来源的 prefix 指纹固定，来源被删除后仍可读，不自动重放、不自动重发。
- 历史与滚动：200 个种子子会话的历史分页（实际 6 页，计数 `[40,40,40,40,40,1]`，共 201 条）与 130 轮长 transcript 的精确位置恢复。
- 未发送草稿：Unicode 文本 + 图片保留；未知回执进入“待核对”状态，禁止隐式重发。
- 两个修复：`107a9208`（workbench 命名空间断言改读 durable v2）；`72ec35cc`（`chat-scroll.ts` 新增 `transcriptGrowthAboveEdge`，普通行仍补偿，唯一豁免刚被精确恢复定位的锚点行）。

## 证据（当前构建实测）

来源：本轮 `npm run test:renderer:ui` 内的 `scripts/side-chat-smoke.mjs`，隔离临时 HOME/userData/workspace 隐藏实例。
fixture 证据：`$TMPDIR/scry-app-driver-MyCVxV/verification.json`（08:05）。

| 合同 | 实测值 |
|---|---|
| Provider 覆盖 | 10 条真实 fixture 回执 = 5 Provider × 2 轮：`codex`、`claude`、`qoder`、`opencode`、`pi:0123456789abcdef` |
| 主会话不变 / 子会话独立 | `isolation.childShowsOwnFile=true`、`parentShowsChildFile=false`、`childWorkspacePicker=false` |
| 冻结来源 | `frozenSource.throughRunId=run-mvtoau68-0`、`prefixFingerprint=d39b8853…`，来源删除后仍可读 |
| 子会话历史 | `seededChildren=200`、`historyTotal=共 201 个侧边会话`、`history.pages` 计数为 `[40,40,40,40,40,1]`（6 页，合计 201） |
| 长 transcript 滚动 | `scroll.seeded=130`、恢复后 `anchorOffset=-80`（切换后仍 -80）、`turns=40` |
| 精确标签 + 纵览重启 | `restart.tabs` 恰为 3 个登记 id、`composerValue="side chat unsent 草稿文字"`、`workbench.openIds=["overview"]` |
| 未发送草稿 + 未知回执 | `drafts.draft={value:"side chat unsent 草稿文字",images:1}`、`receipt.state="unresolved"`、`newerDraft.resend=false` |
| 来源快照查看器（只读） | `orphanReader.snapshot`：`rows=26` 等于 `expectedMessages=26`、`state=complete`、`olderDisabled/newerDisabled=true`、`reads=1`；Escape 后焦点回到「查看来源快照」、草稿 `孤儿草稿草稿` 复原 |
| 待核对回执查看器（pending 回执） | `drafts.content`：精确原文 `side chat pending 待核对原文🙂🀄️ *原样显示*`、`image=side-chat-pending.png`、`imageReady=true`、`lightbox=side-chat-pending.png`、`focusReturned=true`；配套 `drafts.receipt.state="unresolved"`、`sendDisabled=true`、`drafts.newerDraft.state="unresolved"`、`newerDraft.resend=false` |
| 父会话显式 adoption | 同一步只发生 1 次 `conversation:previewAdoption` 与 1 次 `conversation:adopt`；`adoption.binding={providerId:"codex",nativeSessionId:"smoke-session-run-mvtoau68-0"}` 与 `parentNativeSession` 相同；`tabs` 与 `active` 前后不变；子会话 `childTurns` 保留、`runId` 继续、`bodies=1`、子会话订阅 ≤2 |

当前界面截图：[`side-chat-0.2.231-restored.png`](side-chat-0.2.231-restored.png)，SHA-256 `cbdd24dc6858548a216283e074e9a4492606d9d60103f1fae19bb6c43e771250`。
它来自本轮 08:05 的 `electron-security-smoke.mjs --dev-side-chat-only` 采集（源文件 `$TMPDIR/scry-app-driver-Cq6qHy/side-chat-restored.png`），画面是侧边会话在重启后恢复到主会话旁的状态：来源快照按钮、关闭侧聊、未发送草稿与图片。**不是** `d3-ui-polish.md` 时期的设计稿截图。

## 门禁与命令（全部在升版后的当前树上执行）

| 门禁 | 命令 | 实际结果 |
|---|---|---|
| CLI 发布检查（Node 22.22.1，CI App 版本） | `npm run check:cli-release` | `typecheck` 通过；57 文件 / 788 用例通过；`build:cli`；包冒烟 `{"version":"0.2.53","bin":"ok","init":"idempotent","hook":"recorded","doctor":"healthy","concurrentNotifications":"isolated","legacyCursor":"preserved"}` |
| CLI 兼容 Node 20 | 同上，`node v20.20.2` | 57 文件 / 788 用例通过；包冒烟 `0.2.53` 全项通过 |
| CLI 兼容 Node 24 | 同上，`node v24.18.0` | 57 文件 / 788 用例通过；包冒烟 `0.2.53` 全项通过 |
| 完整 renderer UI 矩阵 | `npm run test:renderer:ui` | 退出码 0，完整既有矩阵（含 Credits、side-chat、conversation IPC、source-control、workspace、pi-native-history） |
| 单元 + shell | `npm test` | 500 文件（496 通过 + 4 跳过）；5036 用例（5032 通过 + 4 跳过） |
| 打包与安装 | `npm run install:mac:dev` | `typecheck` + `npm test` + `build` + `build:cli` + electron-builder + `check:packaged-app` + `smoke:electron` + 原子安装，退出码 0 |

`npm test` 相对合入前的对照（计数由父会话按原始 `9a130` 输出核准）：合入前 495 通过 + 4 跳过 = 499 文件、5028 通过 + 4 跳过 = 5032 用例；本轮 496 通过 + 4 跳过 = 500 文件、5032 通过 + 4 跳过 = 5036 用例。差值恰好是 **1 个文件 / 4 个用例**，即新增的 `src/renderer/chat-scroll.test.ts`（4 个用例）；没有无法归因的文件数差额。

Node 20 的取得方式：官方 `https://nodejs.org/dist/v20.20.2/node-v20.20.2-darwin-arm64.tar.gz`，与官方 `SHASUMS256.txt` 的 `466e05f3477c20dfb723054dfebffe55bc74660ee77f612166fca121dacb65b6` 一致，只解包到 `$TMPDIR/scry-release-gates-0jw8gcKN/final/`；未改 nvm default/全局、未新增项目依赖。

日志（`$TMPDIR/scry-release-gates-0jw8gcKN/final/`）：`cli-release-node22.log`、`cli-release-node20.log`、`cli-release-node24.log`、`renderer-ui-final.log`、`npm-test-run2.log`、`install-mac-dev-run2.log`。
打包校验摘要（`check:packaged-app`）：`bytes=286939755`（上限 346030080）、`preload=cjs`、`scryCliVersion=0.2.53`、`scryCliBundled=true`。
性能：`72ec35cc` 之后只改版本常量和文档，`git diff --name-only 72ec35cc..HEAD -- scripts/performance-counters scripts/performance-ratchet.json scripts/performance-ratchet scripts/performance-paths.json scripts/performance-measure.mjs scripts/performance-compare.mjs` 为空，未改 workload / 计数器 / 基线 / ratchet，也没有为此重跑 perf。

## 首次失败与未知（不抹掉）

1. **`npm test`（`install:mac:dev` 第一次运行）**：`scripts/check-staged-file-size.test.ts`、`scripts/performance-counters/main-ipc.counters.test.ts`、`src/main/source-control/workspace-choices.test.ts` 三个文件 `Test timed out in 5000ms`（日志 `install-mac-dev.log`，退出码 1，安装未执行）。
   观察到的并发条件：当时另一个 worktree（`…/909f5f8b-…`）在同一台机器跑它自己的完整 renderer UI 矩阵，日常 App 也在运行，`load average` 14–18。
   检查：三个文件单独跑全部通过（10 / 2 / 7 用例）；并发压力消失后同一条 `npm test` 命令复跑通过（`npm-test-run2.log`，5032 通过 + 4 跳过）。
   不宣称：没有把超时归因证据做成实验（没有做“同一负载下必现”的对照），默认 5000ms 对 `main-ipc.counters` 余量很小（单独跑约 5.0 s）是事实观察，**未** 上调任何超时、未 skip、未弱化断言。
2. `release-verification.md` 里的两个**原因 UNKNOWN** 未因本轮改变：首次 `--session-opening-only` 超时与 06:33 的 `CDP WebSocket 已关闭`。本轮没有再观测到这两种失败（UI 矩阵与安装内 `smoke:electron` 全绿），但没有新增能判定原因的证据，两者仍是 UNKNOWN。

## 安装、备份与未做的发布动作

- 安装前复核（08:38 那次）：`/Applications/Scry.app` 仍为 `0.2.230`、`app.asar` `05c088c9…`，与开工时一致，未被并行安装覆盖。
- 安装后复核（08:38 那次）：`CFBundleShortVersionString=0.2.231`、`CFBundleIdentifier=com.scry.app`、私有 CLI `Contents/Resources/bin/scry --version` → `0.2.53`（安装器自身在 `validateBundle` 里也校验了这一项）、`app.asar` SHA-256 等于构建产物。这个状态在 08:44:55 被外部替换，见上面“交付后复核”。
- 重装（08:57:49）：没有重建、没有重跑门禁、没有升版本——安装的仍是 08:38 那份通过全量门禁的产物。安装器自身的校验在这次重装里同样执行：staged 副本与安装后目标都检查 `Contents/MacOS/Scry` 可执行、`Contents/Resources/app.asar` 存在、内置 CLI 版本等于 `0.2.53`、bundle id 与 App 版本匹配。
- 备份：安装器把被替换的 bundle 轮转到 `/Applications/.Scry.app.backup`（当前为 `e5030058…`），删除的是它自己上一轮的备份目录；6 个更早的 `preserved` 备份未被删除。日志在 `$TMPDIR/scry-sidechat-reinstall/`（`prestate.txt`、`install-macos.log`、`poststate.txt`、`prestate-entries.json`、`poststate-entries.json`）。
- 未做：没有 push、没有 `npm publish`、没有安装/升级全局 `scry` CLI、没有用真实付费 Provider 账号、没有读写系统剪贴板、没有前台窗口弹窗（全部为隐藏隔离 fixture）。
- 日常实例：用户当前运行的 App 进程（pid `44207`，2026-10-28 启动）仍是旧构建的内存镜像；重启后加载的是当时磁盘上的构建（现在是 08:57:49 重装的这一份）。本轮没有启动、退出或重启任何 App。
- 未来冲突没有被阻止：安装器只用 `/Applications/.scry-install.lock` 保证**同一时刻**只有一个安装器在跑（stale lock 通过 hard-link tombstone 回收）。它不持有“这份产物必须留在 `/Applications`”的保留权——另一个 worktree 之后再次执行安装，仍会把这一个 App bundle 替换掉，正如 08:44:55 发生过的那样。要避免，需要在多个会话之间序列化安装并约定最后一次安装由谁负责，这不是本仓库安装器能提供的保证。

## 版本-源码对应

- 安装产物构建自 `18326f4c`（`0.2.231` / `0.2.53`，代码与 `72ec35cc` 相同，只多版本常量与 README 安装示例）。
- 本文件所在的最终文档 HEAD 相对 `18326f4c` 只改文档，runtime 与打包产物的输入保持相同：`git diff --name-status 18326f4c..HEAD -- src scripts packages electron-builder.yml package.json package-lock.json tsconfig.node.json tsconfig.web.json tsconfig.cli.json tsconfig.recorder.json` 为空。因此“已安装构建”与“最终 HEAD 的代码面”一致。
- 相对 `18326f4c` 的文档改动（全部为 `.md`，截图已在 `81f2b822` 加入）：`docs/handoff/side-chat/final-delivery.md`（本文件）、`docs/handoff/side-chat/README.md`、`docs/handoff/side-chat/continuation-checkpoint.md`、`docs/handoff/side-chat/release-verification.md`。

## 过程记录：上一阶段的流程偏差

如实记录，不改写历史：上一阶段（本交付之前）的执行者对自己**新建且未推送**的同一份文档提交做了两次 `--amend`：`a2fdcebe` → `55341ef6` → `8588264a`（内容均为 `docs/handoff/side-chat/release-verification.md`）。

- 影响范围：只有那一个本轮新建的文档提交；功能提交 `fcd40cf4`、测试修复 `107a9208`、渲染修复 `72ec35cc`、合并 `cf25a103` 与用户既有提交都没有被改写。
- 全程没有 push，因此不存在“远端一个已被改写的分支被覆盖”的问题；本地分支未推送。
- 其后的版本提交 `18326f4c`、交付文档 `81f2b822` 与本轮修正提交都是**新提交**，没有 `amend`/`rebase`/`reset`/`stash`。
- 本节只作记录，不用重写或重建历史去“修复”它。

## 相关文档

- 能力与设计：[`technical-plan.md`](technical-plan.md)、[`implementation-report.md`](implementation-report.md)（历史报告，未改写）
- 交互验收：[`d1-interaction-acceptance.md`](d1-interaction-acceptance.md)、界面设计：[`d3-ui-polish.md`](d3-ui-polish.md)
- 门禁与首次失败台账：[`release-verification.md`](release-verification.md)（本轮已校订证据表述）
- 续作状态：[`continuation-checkpoint.md`](continuation-checkpoint.md)
- 用户向安装/合同说明：仓库根 [`README.md`](../../../README.md)、[`packages/turn-recorder-cli/README.md`](../../../packages/turn-recorder-cli/README.md)
