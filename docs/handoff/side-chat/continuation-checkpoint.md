# 侧边会话续作检查点

状态（最新）：侧边会话已实现、发布门禁通过，其构建当前安装在 `/Applications/Scry.app`（App `0.2.235` / 私有 CLI `0.2.53`，`app.asar` `74fcedb9…`，版本提交 `e586a165`，源码冻结 `747b5676`）。这些提交父级已在真实 main 工作树快进到 `main`（未 push），其他分组的 `/IdeaProjects/vibecoding/scry` 检出仍留在它自己的分支上。CLI 的 Node `20.20.2` / `22.22.1` / `24.18.0` 三个分位 smoke 都已实际执行并通过（Node 20 用官方临时运行时，校验后用完即删）。安装保留上一份为 `/Applications/.Scry.app.backup`（`0.2.227`）。日常实例需要用户自己重启才加载这一版。当前版本、证据、首次失败与实际限制见 **[large-history-delivery.md](./large-history-delivery.md)**；更早的 `0.2.231` 安装与轮转记录（08:38:40 首装 → 08:44:55 被另一份 worktree 构建替换 → 08:57:49 用户批准重装恢复）保留在 [final-delivery.md](./final-delivery.md)，不再代表当前版本。以后别人再安装仍会覆盖这份 bundle，安装器不提供跨会话保留保证。下面各节是历次续作轮的当时状态（最早一条写于 2026-10-28），保留作为过程记录，不再代表当前进度。此文件不代替最终验收报告。

## 执行者与阻碍现状

原 D1（`f66844a6`）到达轮次预算后，恢复任务 `9b0687e9` 报 `Qoder: request_failed`；新上下文 `2ee8074e` 与恢复 `5a8eaa9e` 均在任何工具调用前失败（`http_502` → `request_failed`）。用户确认 Qoder 服务恢复后，本次续作轮**已真实执行并产出结果**；执行者服务不再是阻碍。

续作轮完成的是「五目标真实发送 + 真实窗口尺寸」这个第一验收里程碑，其余条目仍未完成，见 [d1-interaction-acceptance.md](d1-interaction-acceptance.md) 第七节。

## 已保留状态

- 分支 `scry/88d17fe3`，HEAD `06a69a74`；工作区为本功能 WIP，暂存区为空。
- 没有功能提交、push、版本升级或 App 安装。不要宣称正在运行的日常 App 已更新。
- 本轮实际跑通（`--dev-side-chat-only`，隔离临时 HOME/userData/工作区，退出码 0）：五 Provider 各两次发送/续接、子会话独立原生身份、父会话不变、真实窗口 1400/1100/860/1200×600 尺寸、浅色深色、键盘页签、IME、不可信文本、201 子会话分页 40×5+1、关闭页签不删除、重启恢复同一子会话且无重放。
- 统一对话模式（`--dev-unified-conversation-only`）与结构模式（`--dev-structure-only`）本轮重跑通过；统一对话里一条早于持久回执合同的旧断言已按新合同改写（见验收记录第六节，需复核者确认）。
- 证据文件：每次运行的临时目录里 `scry-electron-smoke-*/side-chat-verification.json`（含 `out/main`、`out/preload`、`out/renderer` 实际产物 sha256），截图在各模块自己的 `scry-app-driver-*` 目录；`scripts/electron-security-smoke.mjs` 的 side-chat 分支现在会打印这两个路径。

## 下一个执行者的顺序

1. 先读当前工作区，不要重放旧写入；不要恢复 `conversationTarget()` 的三 Provider 限制（负控已证明它会让五目标验收失败）。
2. 补齐未验证项：归档/删除指纹预览、父会话删除后子会话可发现性与冻结正文、来源在持有预览/创建/历史查询期间切换的挂载态竞态、长历史滚动锚点（不要声称旧偏移精确）、快照查看器 Unicode 分页与 ModalFrame 焦点归还、未发送文字/图片与 pending 回执的跨重启读回。
3. 复核本轮改写的统一对话断言是否符合想要的用户体验（输入框清空、原文与图片留在持久回执）。
4. 源码稳定后按仓库文档执行性能、完整测试/打包/CLI 检查；只提交本次改动，不 push；通过既有 `install:mac:dev` 安装并报告哈希、产物版本及日常实例待重启。

## 约束

仅一个 writer。所有 App 自动化都用临时 HOME/userData/workspace 与独立隐藏实例，不占用用户窗口/剪贴板，不探测真实付费 Provider 账号。fixture、真实 App 事件与真账号验证必须分开报告。所有手写文件 ≤ 20,000 字节。

## D2 status

Also landed in this round: current-scope child ownership, child-owned main view for orphaned
side chats, ordinal-based anchor restore, header provenance de-duplication, and the
`side-chat-smoke` / `side-chat-scroll-checks` / `side-chat-orphan-checks` split.

### D2 closure round（Node 22.22.1）

`npm run test:side-chat:ui`（build + snapshot 组件夹具 + 工作台竞态组件夹具 + `--dev-side-chat-only`）退出码 0，
每一步的自身断言通过：`execution`、`runtime`、`history`、`scroll`、`orphan`、`orphan reader`、`orphan paging`、
`restore`、`layout`、`drafts`、`restart`、`drafts restored`、`adoption`。restore 不再依赖关闭页签：历史动作在有
页签时走 `+` 菜单、无页签时走 chooser 底部，两者都不关闭任何页签（实测动作前页签仍在，1 → 2）。

本轮新增证据：

- 多页签（显式需求）：退出前 1 个工具页签（纵览）+ 3 个子会话页签（未发送草稿、未决回执、普通），`localStorage`
  保存行的顺序与激活页签、页签条顺序在重启前后一致；重启后的读取发生在任何修复/重开动作之前。
- 挂载态竞态：`scripts/side-chat-workspace-races-smoke.mjs` + `scripts/fixtures/side-chat-workspace-races.tsx`
  在 sandboxed 隔离窗口挂载生产 `useSideChatWorkspace`，覆盖 preview / create 结果 / 页签校验 / 历史页 / 窄化 /
  丢失回执在切换父会话后才作答；把 `fenceHolds` 改成恒真时第一项立即失败。自称组件夹具证据。
- 父会话被用户显式切换 Provider 后收养成统一对话：子会话 id/runId/页签存活、只有 1 个 body 与 1 个 composer，
  新对话 scope 的 `listSideChats({ids})` 与真实历史对话框都能列出切换前冻结的子会话。`conversation-side-chat.ts`
  的规范来源匹配按精确 provider/profile/cwd/session 双向扩展（`nativeIdentity` 同一拼写），并有双向别名回归与负控。
- 子会话自身文件证据（`side-chat-pi2.txt`）只出现在子会话正文，父正文不含；子输入框无工作区选择器。
- 快照多页仍只有组件夹具证据；App 内只证明单页可读、Unicode 完整、`data-snapshot-state`、Escape 焦点归还。
- `docs/handoff/side-chat/implementation-report.md` 的「D2 最终验收缺口轮」一节记录本轮全部实测数值与负控。

仍未验证 / 不宣称：真实付费 Provider 账号；完整发布 gate、打包、性能测量本轮未跑；未提交、未推送、未升版本、
未安装（源码 0.2.227，日常实例仍 0.2.229）；App 证据来自隔离隐藏临时实例，不代表用户当前实例已更新。

## D3 status（最新，D2 之后）

D2 之后的 UI 工序是 D3：未决发送原文/图片可在只读回执里查看（`PendingSubmissionDialog`），孤儿侧聊标题与元数据
分两行。已在隔离真实 App 内验证（`npm run test:side-chat:ui` 退出码 0、`npm test` 446 files / 4651 tests
通过、4 skipped），实测表格与截图路径见 [d3-ui-polish.md](d3-ui-polish.md)。上面对 D2 的结论以该文件为准。

D3 之后还有两处集成前源码修正（未重跑 App UI 与全量 `npm test`）：来源匹配不再对每个子会话遍历全部 owner
（改为只解析被请求的那一侧，并留有“未读无关 owner”的计数负控）；孤儿行的行页码表每次更新只保留当前页面的组。
两项均记录在 [d3-ui-polish.md](d3-ui-polish.md) 末节。

## 发布前门禁（最新，D3 之后）

源码冻结候选。集成分支 `cf25a103` 上新增 `107a9208`（终端 capability 断言改读 durable 工作台命名空间）与
`72ec35cc`（虚拟化历史锚定与精确视图恢复各自保留）；完整 `npm run test:renderer:ui`、`npm run check:cli-release`、
`performance:measure --compare beac4da8…` 均通过。首次失败、重跑结论、性能 worse 的逐项判定、证据与产物路径见
[release-verification.md](release-verification.md)。仍未升版本、未打包安装、未 push；下一个执行者先读该文件。

## 最终交付（最新，发布前门禁之后）

上一节的“未升版本、未打包安装、未 push”已被后续轮次接管：App 升到 `0.2.231`、私有 CLI 升到 `0.2.53`，
在升版后的树上重跑了 `check:cli-release`（Node 20/22/24）、`npm run test:renderer:ui`、`npm test`，
并用既有 `install:mac:dev` 原子安装到 `/Applications/Scry.app`（`app.asar` SHA-256 `5711c059…` 与构建产物相同）。
该安装已在 08:44:55 被另一份构建替换；08:57:49 用户批准用既有原子安装器（Node `22.22.1`）把同一份已验证产物重新装回，装后校验 App `0.2.231` / `com.scry.app` / CLI `0.2.53` / `app.asar` `5711c059…` 等于 `dist/`。逐项时间、哈希、备份轮转位置与“未来覆盖未被阻止”的边界见 final-delivery.md 的“交付后复核”一节。
仍未 push、未 `npm publish`、未安装全局 CLI；日常实例需要用户重启才会加载新版本。
当前版本、证据、门禁计数、首次失败与未验证项集中在 **[final-delivery.md](./final-delivery.md)**；
安装前的门禁轮记录与本轮证据表述校订在 [release-verification.md](release-verification.md)。
