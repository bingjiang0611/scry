# 侧聊大历史：验证范围与证据（HEAD `66fc489a` 起）

本文只写“哪一层被证明了、证据在哪、还剩什么”，不重复实现说明。实现与取舍见
[large-history-fix.md](large-history-fix.md)。当前版本、安装产物与门禁结果见
[large-history-delivery.md](large-history-delivery.md)；本文保留的是源码冻结时的验证现场。

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

## 3. 大历史对话框（真实 DOM，走完整条链）

`scripts/side-chat-large-history-ui.mjs` 在同一个子会话上真的打开对话框，全部输入都是
原生指针／键盘事件（带命中测试，不调用程序化 `.click()`）：

1. 父会话删除后，子会话作为孤儿分组出现在侧栏，点它挂载真实的 `main` 侧聊 surface；
2. 点标题栏的“查看来源快照”，等对话框自己报告已加载 `0:0` 这一页；
3. 断言第一页 40 行、provenance 写明 4010 条、首行文本就是父会话的第一条消息；
4. **每页只点一次**“更新”，然后等 `data-side-chat-snapshot-loaded-cursor` 等于上一页
   公布的 `data-side-chat-snapshot-next-cursor`——**已加载页的 cursor 是唯一判据**，
   不要求页面文本变化；
5. 一直翻到对话框自己报 `complete`（没有页数上限，只有一个 300 s 总 deadline）；
6. 断言末页停在父会话最后一个轮次（`lastSourceOrdinal 2005`）、`next` 变灰、
   `older` 可用；>4 MiB 那条消息确实跨页（`hugeMessageSeen true`、`continuedRows 81`）；
7. 再点“上一页”→ 断言回到上一页的 cursor，再点“更新”→ 断言回到末页同一 cursor；
8. `Escape` 关闭，断言焦点回到打开它的那个按钮；
9. 期间 `conversation:readSideChatSnapshot` 的 IPC 次数 ≥ 翻过的页数——对话框走的就是
   产线读取入口，不是另一条捷径。

本次实测（两次独立运行）：`dialogPages 181`、`walkedMs 18960 / 20664`、
`lastCursor 4008:4194051`、`dialogReads 184`、`lastSourceOrdinal 2005`、
`continuedRows 81`；末页截图里“下一页”已变灰、“上一页”可用。截图：`large-history-snapshot-first-page`、
`large-history-snapshot-huge-message-page`、`large-history-snapshot-last-page`，与本次
`artifactHashes` 一起保存。

### 早期“续页不动”的结论是测试判据错了

上一轮记录过“指针翻到 >4 MiB 消息的续页后内容不再变化”，并把指针遍历降成 4 页。这次
查清了：正文是重复字符，一条 4 MiB 消息在 256 KiB 分页下会产生多个**内容完全相同、只有
cursor 不同**的合法页；旧判据（轮次号 + 长度 + 首尾字符）本来就把它们判成“同一页”，
所以“不动”是**测试 oracle 错误**，不是 UI 缺陷。修正后同一棵树的真实遍历一次走完 181 页。

为了让这个判据可被独立检验，加了组件级反向对照
（`node scripts/side-chat-snapshot-ui-smoke.mjs --identical-text-only`）：fixture 故意让
相邻两页轮次号与文本完全相同、只有 cursor 不同，旧指纹判据在这一对上返回“同一页”
（`fingerprintStuckPages 1`），cursor 判据仍走完全部 4 页并在测试中断言
`fingerprintStuckPages === 1`——判据一旦退回文本比较，这条测试立即失败。

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

## 4.5 原生读取器（Claude 与 Pi）：前缀一致性与驻留上界

Pi 侧聊读取走 `pi-native-stream.ts` 的两遍投影（结构一遍、正文一遍），本轮关掉两个实际缺口：

两个 Provider 的原生读取现在是同一份合同，而不是只有 Pi 正确：

| 合同 | 怎么证明 | Claude | Pi |
|---|---|---|---|
| 驻留内存不随历史增长 | 正文 spool 共用一份 `SpoolBudget`（`captureSpools`），轮次在记录边界关闭，调用方消费后立即释放（`settleAndRelease`） | 60 轮 × 64 KiB，预算 2 MiB：峰值驻留 98,338 B，文件 3,951,330 B | 60 轮 × 64 KiB，预算 2 MiB：峰值驻留 98,338 B，文件 3,952,528 B |
| 不是先读完整个文件再给第一轮 | 第一轮交付时读到的位置 | 1,048,576 B（一个 1 MiB 读块） | 1,048,576 B（同上） |
| 解析过的前缀没有被同大小改写 | Claude：解析时对读到的字节累计 sha256，读完再对**同一固定区间**重读一遍比对；Pi：两遍各自对同一字节段累计 sha256 后比对 | 同大小改写（`answer one`→`ANSWER ONE`）确定性拒绝；追加成功 | 同大小改写（`pi answer`→`PI ANSWER`）确定性拒绝；追加成功 |
| 追加仍然合法 | 两边都只比较“已量前缀”，区间之后的新字节不参与 | 通过（并断言文件变长） | 通过 |

反向对照都成立：去掉“每轮释放/按记录边界 drain”后，两边的驻留检查都失败（峰值 2,065,058 B > 524,288 B 上限）；去掉 digest 比较后，两边的同大小改写检查都失败。

成本要说清：Claude 是单遍读取，前缀证明因此**多一次同区间读取 + 哈希**（证据工作，不是免费）；Pi 的两遍本来就要读两次，只增加哈希。两者都**没有**增加第三遍解析，也没有把正文重新解析成对象。

Pi 的文件身份仍是**头部自证**（`type`/`version`/`id`/`cwd`），与 Claude 的逐条 `sessionId` 不同，写在模块注释里；已放弃的分支不会被压平。inode/dev/size 这类同 fd 身份仍保留，但只作为“文件被替换/截断”的判据，不再是前缀内容的权威。

## 4.6 归档来源（conversation 源）的输入 spool 生命周期

原生读取器修好后，同一资源生命周期在归档来源（`conversation-side-chat-stream.ts` 的 `streamTurns`）里还漏一处：
每轮的输入 spool（prompt 与各事件）是 `new TextSpool(…, budget)` 直接建的，`SpoolRegistry` 只登记 `sealBody`
产出的输出 spool；`reset()` 把 `parts`/`userSpool` 置空而不 `discard`，于是这些输入 spool 的预算占用、
临时文件与句柄就丢了引用——小来源看不出来，几万条 5 KB 消息会把预算耗尽并让后面的 spool 全落盘。

现在：一个被 `yield` 出去的轮次被 sink 消费后（`try/finally` 覆盖正常恢复、`return` 与 throw），按本轮的输入
spool 集合（`Set` 去重 prompt 与 parts 指向同一 spool）显式 `discard`，然后才 `reset()`；外层 `finally` 仍收
“当前未消费的 parts + registry”，输出 spool 仍由读取消息的 `finally` 释放（合同不变）。

证据（`conversation-side-chat-stream.test.ts`，3 个测试）：60 轮 × 2 条 5 KB 正文、8 KiB 共享预算——
① 消费完 `budget.available` 完整回到 8,192，且本次运行真正发生过 spill（记录到的 `mkdtemp` 目录）在结束后全部不存在；
② 消费两轮后 `iterator.return()`：预算同样完整归还、无残留目录；
③ 归档流中途抛错：同上。
反向对照：去掉按轮 `discard` 后，三条都失败在 `budget.available` 只剩 3,061（预算不归还），说明这不是 GC 或等待问题。

## 5. 本轮观察到的首次失败（不改写为 flake）

同一次验证里记录到的、同一代码重跑通过的第一轮失败。**根因未知**，没有把任何一步标成
skip，也没有通过延迟断言、加 sleep 或换断言来让它变绿：

- （已查清，见第 3 节）早期“指针翻到续页后内容不变”是测试判据用文本比较造成的假失败，
  不是 UI 缺陷；改成比较已加载 cursor 后，指针遍历一次走完全部 181 页。
- `test:renderer:ui`（全量 UI gate）曾停在
  `Side-chat drafts restart state: .pending-submission-modal` 等待超时，同一棵树重跑通过。
  根因**未知**：没有决定性证据，所以没有写成 fixture 竞态，也没有加 sleep/重试。为下次
  能定性，已把“查看回执”的点击从全局 `[data-pending-inspect]` 收窄到子会话面板内，并在
  该步记录全部候选（所属 pane／子会话、disabled、bbox），指针驱动也改为必须
  “可见 + 未禁用 + 连续两帧同一 rect + `elementFromPoint` 命中”才发点击，失败时抛出
  含候选与命中栈的证据。
- `npm test` 第一轮有 1 个失败：`conversation-side-chat.test.ts > refuses corrupt archives
  and over-budget bodies` 在默认 5 s 上超时；单文件跑 9 tests / 3.01 s 通过。原因可查：
  这条用例现在要真的冻结并回读一个 >16 MiB 正文（旧实现到预算就直接拒绝），工作量本身
  变大了，断言一条没改。按“测试预算需对应真实工作量”给它显式 30 s，并在用例里写明理由；
  随后整轮 `npm test` 510 files / 5122 passed / 4 skipped 一次通过。
- 本轮我自己引入过一次真实回归：把指针驱动改成“必须可点”后，孤儿读者用例的
  `.climenu [data-agent-id]` 因为等待上限从 20 s 变成 2 s 而报 `Unclickable target`。
  修的是前提条件本身（候选等待恢复 20 s，稳定性/命中/未禁用照旧，仍只发一次点击），
  不是重跑或加 sleep；之后 `--dev-side-chat-only` 与整条 `test:renderer:ui` 一次通过。
- 未观察到失败的：`npm run build`、`npm run typecheck`、`npm run test:side-chat:ui`、
  `npm run test:renderer:ui`（含 181 页指针遍历）、`npm run test:conversation:ipc`、
  `npm run check:cli-release`、`npm run performance:measure -- --compare d824c609`
  （135 行对照、0 worse、`Ratchet: passed`，本轮只有 DOM 属性与测试改动，未重测）。

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

## 7. 性能来源分类

`scripts/performance-paths.json` 的 side-chat 路径 `sources` 补入本轮引入/改动的真实热路径模块：
`conversation-side-chat-streamed.ts`、`conversation-side-chat-native-stream.ts`、`claude-jsonl-projector.ts`、
`pi-native-stream.ts`、`pi-jsonl-projector.ts`、`jsonl-record-scanner.ts`、`conversation-side-chat-snapshot.ts`、
`content-manifest.ts`（顺带修了该数组里已有的缩进错位）。这只是 IPC 来源分类维护，没有新增计数器或 workload。

**诚实说明**：collector 的 `navigation.catalog` 并不驱动真实正文捕获，所以把新文件登记进 `sources` 不等于有了
benchmark 覆盖；改这些模块仍必须另跑 `performance:measure`。本轮实测 135 行、0 worse、`Ratchet: passed`
（`/tmp/scry-perf-claude-jqHAWg`），唯一变化的 5 个字节级计数器都是 trace/hash workload 的既有主分支漂移
（`io.read.payload.bytes` −9 B、`other.hash-update-bytes` +2 B、`other.stringify-bytes` −12 B 等），
不来自本轮改动；原生正文捕获的额外前缀读取不在这些计数器里——它是本轮新增的证据成本，如实记为“有意新增”，
不用“0 worse”掩盖。
