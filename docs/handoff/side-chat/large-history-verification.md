# 侧聊大历史：验证范围与证据（HEAD `66fc489a` 起）

本文只写“哪一层被证明了、证据在哪、还剩什么”，不重复实现说明。实现与取舍见
[large-history-fix.md](large-history-fix.md)。

## 1. 一个容易误读的范围：`--dev-*` 不是打包产物

`scripts/electron-security-smoke.mjs` 的 `--dev-side-chat-only` /
`--dev-side-chat-large-history-only` 走 `devApp = true`：启动
`node_modules/electron/dist/Electron.app`，再用 `structureEntry` 加载当前工作区的
`out/`。

所以它们的真实身份是 **当前代码构建出来的完整隔离开发 App**：

- 是真的 main 进程、真的生产 IPC handler、真的 renderer/preload、真的 sandbox 与
  security wrapper；
- 数据在临时 `userData` 与临时工作区里；
- **不是** 打包后的 `.app`／签名产物，也**不是** 安装版本。

`out/main/index.js`、`out/preload/index.cjs`、`out/renderer/index.html` 的 sha256 记录在
每次冒烟输出的 `artifactHashes` 里，用来对齐“这份证据对应哪次构建”，不能把
`devApp` 的通过当成打包验证。打包产物的验证是独立的 gate，见第 5 节。

## 2. 大历史正向路径证明了什么

`{"test":"side-chat large history"}` 这一行是同一棵代码树上的真实 App 证据：

| 断言 | 值 |
|---|---|
| 父会话规模 | `parentTurns 2005`，`messageCount 4010` |
| 归档字节 | `archiveBytes 22361185`（> 16 MiB） |
| 单条可见正文 | `hugeMessageBytes 4259859`（> 4 MiB，整条冻结） |
| 预览不拒绝 | `firstSendBlockedReason` 为空，`readerAvailable true` |
| 子会话记录 | 格式 4 描述符，`< 20 KB`，`messageCount` 与预览一致 |
| 发送计划 | `planItems 400`（≤400 的内联窗口，不枚举全部） |
| Provider 真读取 | `providerReads 3`：经 loopback MCP JSON-RPC 按页取回最早／中间／最新三整条 |
| 查看器全文 | `viewerRows 4010`，`viewerElapsedMs ~500`，`complete true` |
| 删除父会话后 | `readsAfterDelete 4010`，同一批正文仍可读 |

读取的**内容**不只比长度：

- `smoke-history-reader.ts` 把条目的 `[runId, itemId, contentHash]` 第三项当作期望值，
  自己重算的 sha256 与它不等就抛错——“长度对、内容错”的读取无法通过；
- seed fixture 自己写入每条消息的 hash（`seed.itemHashes`），检查要求
  `read.hash ∈ seed.itemHashes`，所以读者不是拿同一份 authority 自我循环证明；
- 查看器侧用 renderer 的 `crypto.subtle` 对重组后的正文做 sha256，要求与读者给的 hash
  相等；删除父会话后再算一次，逐条比 hash（不再只比长度）；
- 单测 `src/main/providers/smoke-history-reader.test.ts` 用真实 HTTP JSON-RPC 读者演示
  “同长度不同正文”会被拒绝。

## 3. 大历史对话框（真实 DOM）

`scripts/side-chat-large-history-ui.mjs` 在同一个子会话上真的打开对话框，全部输入都是
原生指针／键盘事件（带命中测试，不调用程序化 `.click()`）：

1. 父会话删除后，子会话作为孤儿分组出现在侧栏，点它挂载真实的 `main` 侧聊 surface；
2. 点标题栏的“查看来源快照”，等待真实列表渲染；
3. 断言第一页 40 行、provenance 写明 4010 条、首行文本就是父会话的第一条消息；
4. 点“更新”翻到相邻页，断言整页指纹（轮次号 + 文本长度 + 首尾字符）变化；
5. 连续翻到第 4 页（`walkedCursor 120:0`），断言这一页真的渲染了后续消息文本；
6. `Escape` 关闭，断言焦点回到打开它的那个按钮；
7. 期间 `conversation:readSideChatSnapshot` 的 IPC 次数 ≥ 翻过的页数——对话框走的就是
   产线读取入口，不是另一条捷径。

**范围说明**：指针翻页验证到第 4 页（`dialogPages 4`）。走完全部 ~101 页的指针遍历没有
做，末页与整链完整性由同一 IPC 的全量遍历证明（`viewerRows 4010`、`complete true`）。
不把 IPC 遍历称作 UI 翻页。

截图：`large-history-snapshot-first-page`、`large-history-snapshot-walked-page`，与本次
`artifactHashes` 一起保存。

**观察到的事实**：在一次早期尝试中，指针翻到一条 >4 MiB 消息的续页后，再点“更新”页面
内容不再变化（`state partial`、按钮未禁用、行内容不变）。**根因未知**——没有决定性证据
能说明是虚页与续页共用同一 `（轮次号, 切片长度）`、按钮被遮挡，还是真实缺陷。因此指针
遍历改为有界（第 4 页），没有跳过任何断言，也没有把它称作 flake；记录在这里待后续核对。

## 4. 已移除的硬上限与仍然存在的边界

移除（被大历史正向路径覆盖）：

- 侧聊来源读取的 16 MiB 归档字节上限、4 MiB 单条消息上限、2000 轮／4000 条消息上限；
- 冻结与交接共用一套字节预算导致的“迁移归档超过读取预算”拒绝；
- 描述符里逐条消息的 ref 数组（改为格式 4 清单引用 + 连续前缀闭区间）；
- Claude 与 Pi 原生 transcript 的整行 `JSON.parse`（改为 tokenizer 逐记录投影）；
- 原生来源必须整文件 identity 校验（改为转录自述身份 + inode/dev/字节数校验）。

仍然存在（如实保留，不是新造的数据上限）：

| 边界 | 现在的行为 |
|---|---|
| 非侧聊的共享交接路径（`conversation-history-source.ts`） | 仍按 16 MiB / 4 MiB / 2000 轮工作；本次未改 |
| 交接内联窗口 | 16,000 B / 64,000 B；超出的正文只经读取器按需取，不进 IPC |
| 无 reader 的 Provider（qoder/opencode 原生来源） | 明确能力拒绝，命名“历史检索工具”，不出现尺寸措辞 |
| 侧聊标签数 / 列表 / 查看器分页 | `MAX_SIDE_CHAT_TABS 8`、`listSideChats ≤ 100`、查看器每页 40 项 / 256 KiB |
| `transcript-archive.ts` | 97,927 B，早于本次任务就超过 20 KB 指引；非侧聊调用方仍走整文件 identity |
| Pi 身份 | 只认 session header（`type/version/id/cwd`），与 Claude 逐条 `sessionId` 的差别在模块里写明 |

所以：**不是“整个 App 不再有上限”**。被证明的是“侧聊大历史来源与冻结路径不再有隐藏的
数据尺寸上限，超出交接预算的部分按需读取，缺失能力时如实拒绝”。

## 5. 本轮观察到的首次失败（不改写为 flake）

同一次验证里记录到的、同一代码重跑通过的第一轮失败。**根因未知**，没有把任何一步标成
skip，也没有通过延迟断言、加 sleep 或换断言来让它变绿：

- `npm run test:renderer:ui` 第一次停在 `Side-chat drafts restart state:
  .pending-submission-modal` 等待超时；同一棵树重跑 `RENDERER_UI_EXIT=0`。同一条
  `--dev-side-chat-only` 步骤在同一次的 `npm run test:side-chat:ui` 里是通过的。
- 大历史对话框的指针翻页在一条 >4 MiB 消息的续页上出现过“点更新内容不变”（见第 3 节），
  指针遍历因此有界到第 4 页，末页改由 IPC 全量遍历证明。
- 未观察到的：`npm test`（510 files / 5122 passed / 4 skipped）、`npm run build`、
  `npm run typecheck`、`npm run test:side-chat:ui`、`npm run test:conversation:ipc`、
  `npm run check:cli-release`、`npm run performance:measure -- --compare d824c609`
  （135 行对照、0 worse、`Ratchet: passed`）本轮均为一次通过。

## 6. 复现命令与产物

```
npm run build
node scripts/electron-security-smoke.mjs --dev-side-chat-large-history-only
node scripts/electron-security-smoke.mjs --dev-side-chat-only
npm test
```

- 大历史正向：`/tmp/p5-lh13.log`（`LH_EXIT=0`，机器行同上表）
- 带 reader 的 App 冒烟与负向用例：`npm run test:side-chat:ui`
- 证据目录在每次运行的 `captures`／`verification` 路径下；`artifactHashes` 与截图必须
  和报告里的构建 hash 对上
- 打包产物：`npm run install:mac:dev` 之后安装版验证由发布 gate 单独执行，不在此文件
  宣称
