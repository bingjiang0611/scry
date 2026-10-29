# 侧边会话最终交付（App 0.2.231 / 私有 CLI 0.2.53）

状态：功能实现完成、全量门禁通过、开发版已原子安装到 `/Applications/Scry.app`。
未 push、未 `npm publish`、未安装全局 CLI、未重启用户日常实例。

## 分发身份

- 源码冻结 `72ec35cc`（代码）；其后的提交只改版本与文档。
- 本文件之前的两个提交：`1a5340c7`（证据表述校订，纯文档）、`18326f4c`（版本）。
- **安装产物的构建提交是 `18326f4c`**（工作区干净，`dist/`、`out/` 均为 gitignore 产物）。
- App `0.2.231`，bundle id `com.scry.app`；私有 CLI `0.2.53`（`RECORDER_VERSION` 与 CLI 包版本由 `version.test.ts` 锁定）。
- 已安装 `Contents/Resources/app.asar` SHA-256 `5711c0599fcb925fc33a48077ccfb8770eb1d6a25310849b8a74019e73a2ae1c`，与本次构建产物 `dist/mac-arm64/Scry.app/Contents/Resources/app.asar` 相同。
- 签名：Apple Development `baobingjiang@icloud.com (8Y6KR78CP7)`，`TeamIdentifier=7USHN8Q8JL`。**未公证**：`install:mac:dev` 是开发安装路径（`verifyReleaseBundle` 仅在 `--require-release` 下执行），不是签名/公证正式发布。

版本决策：CLI 升 `0.2.53` 不是形式动作——`normalizeTurnDiffSnapshot` 现在保留 `workspaceOverlap`，属于内置 CLI 对外可见的运行合同；App 只升一次 `0.2.231`。根 README 的两行 npm 安装示例与 CLI README 的安装行已同步到 `0.2.53`（此前分别停留在 `0.2.51`、`0.2.52`）。

## 本轮功能覆盖

侧边会话（side chat）在现有会话旁并行运行，主会话不被替换：

- 主会话保持原 Provider 原生 session 与轮次；切换主会话 Provider 后，子会话记录、标签与运行仍可访问。
- 子会话自己的 Provider 运行、工具调用、文件写入与标签页（`right-surface-storage` durable 命名空间）独立。
- 来源快照只读：冻结来源的 prefix 指纹固定，来源被删除后仍可读，不自动重放、不自动重发。
- 历史与滚动：200 个子会话分页（每页 40）与 130 轮长 transcript 的精确位置恢复。
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
| 子会话历史 | `seededChildren=200`、`共 201 个侧边会话`、13 页 × 每页 40 的分页读取 |
| 长 transcript 滚动 | `scroll.seeded=130`、恢复后 `anchorOffset=-80`（切换后仍 -80）、`turns=40` |
| 精确标签 + 纵览重启 | `restart.tabs` 恰为 3 个登记 id、`composerValue="side chat unsent 草稿文字"`、`workbench.openIds=["overview"]` |
| 未发送草稿 + 未知回执 | `drafts.draft={value:"side chat unsent 草稿文字",images:1}`、`receipt.state="unresolved"`、`newerDraft.resend=false` |
| 只读回执查看器 | `orphanReader.snapshot.rows=26`（= 期望消息数）、`complete`、Escape 后焦点与草稿复原 |
| 主会话 Provider 切换 | `adoption.tabs` 3 个不变，子会话 `childTurns` 保留 |

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

- 安装前复核：`/Applications/Scry.app` 仍为 `0.2.230`、`app.asar` `05c088c9…`，与开工时一致，未被并行安装覆盖。
- 安装后复核：`CFBundleShortVersionString=0.2.231`、`CFBundleIdentifier=com.scry.app`、私有 CLI `Contents/Resources/bin/scry --version` → `0.2.53`（安装器自身在 `validateBundle` 里也校验了这一项）、`app.asar` SHA-256 等于构建产物。
- 备份：既有安装器把上一份 bundle 移到 `/Applications/.Scry.app.backup`（现为 `0.2.230`）；6 个更早的 `preserved` 备份目录未被删除。
- 未做：没有 push、没有 `npm publish`、没有安装/升级全局 `scry` CLI、没有用真实付费 Provider 账号、没有读写系统剪贴板、没有前台窗口弹窗（全部为隐藏隔离 fixture）。
- 日常实例：用户当前运行的 App 进程可能是旧构建的内存镜像；**重启后**才会加载 `0.2.231`。本轮没有启动、退出或重启它。

## 版本-源码对应

- 安装产物构建自 `18326f4c`（`0.2.231` / `0.2.53`，代码与 `72ec35cc` 相同，只多版本常量与 README 安装示例）。
- 本文件与截图所在的最终文档 HEAD 相对 `18326f4c` 只增加文档（本文件 + 截图），**源码逐字节相同**。因此“已安装构建”与“最终 HEAD 的代码面”一致，差异仅文档。

## 相关文档

- 能力与设计：[`technical-plan.md`](technical-plan.md)、[`implementation-report.md`](implementation-report.md)（历史报告，未改写）
- 交互验收：[`d1-interaction-acceptance.md`](d1-interaction-acceptance.md)、界面设计：[`d3-ui-polish.md`](d3-ui-polish.md)
- 门禁与首次失败台账：[`release-verification.md`](release-verification.md)（本轮已校订证据表述）
- 续作状态：[`continuation-checkpoint.md`](continuation-checkpoint.md)
- 用户向安装/合同说明：仓库根 [`README.md`](../../../README.md)、[`packages/turn-recorder-cli/README.md`](../../../packages/turn-recorder-cli/README.md)
