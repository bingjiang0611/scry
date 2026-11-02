# 侧边会话 · 原生来源 Profile 修复

## 后续集成交付

Profile 修复与 [Recorder 0.2.56 修复](../recorder-content-repair.md) 已一并整合到本地 `main` 的 `74d68038`。本次发布以该提交的完整 Git tree（`e5843a0d68cb83b8927cc33c55bc261c5a8967a1`）为基础，仅本交接文档随后更新状态并省略私人会话标识。运行代码保持一致，不包含本地私有提交历史。

该代码树在 macOS arm64 / Node 22.22.1 上通过 typecheck、harness bindings、全量 coverage（5312 通过、4 跳过）、shell、CLI/App 构建、性能计数门禁与完整隔离 Electron UI 验证。`install:mac:dev` 的包校验、安全与远程宿主冒烟亦通过，已安装 App `0.2.237` / 私有 CLI `0.2.56`；安装归档与构建归档的 SHA-256 均为 `23ce1d403c7a6683cb91e170d15d8a242dcf4c9f3ca4bc4c53130eb3061724d8`。未停止用户实例，不能据此声称当前运行实例已加载修复。

本次未执行 Linux 运行验收或真实 Provider 探针；高负载下的 UI 完成时间不是延迟改善证据。本地验证不替代 PR 的远端必需检查，也不表示 PR 已合并。

## 历史记录：源码候选 `4ea51adf`

以下 §1–§10 保留源码候选当时的事实、验证和未完成项；其中安装状态、版本归属与等待事项不是当前状态。**当时源码修复完成，用户选择只合入源码、不安装。** 当前 `/Applications/Scry.app` 仍是其它来源构建的 App `0.2.237` / 私有 CLI `0.2.56` / `app.asar` `7a5ddc40…`，那份产物**不含**本次修复，用户在跑的应用上这个报错依然存在；本次验证过的构建 `0.2.237` / CLI `0.2.55` / `app.asar` `33931944…` **没有安装**。同号不同物是这里最容易误读的一点，记在 §5。

## 1. 用户看到的失败

右侧栏创建侧聊时报 `没有创建侧边会话：TraceArchiveCaptureError: 来源归档属于其它 Agent Profile，不能作为侧聊来源`。

只读核对真实元数据（未读正文、未改 userData）：来源是使用命名 Profile 的 Pi 会话；用仓库自带 `ownedCwdKey` / `ownedSessionFileStem` 定位到的 10 个 archive 分片全部记录同一 Profile，且不存在 canonical monolithic 归档。此处不公开用户的会话标题或 Profile 标识。**来源与归档其实一致，这是同一 Profile，不是跨 Profile。**

## 2. 精确根因与被丢掉的值

`src/main/conversation-side-chat-source.ts` 的 `captureNativePrefix` 先用带 Profile 的 `native` 身份过了一遍 `assertNativeSource`（所以目录/会话/Profile 都验过了），随后又从第二个、更弱的字面量构造归档读取参数：

```ts
const captureArgs = { userDataDir, cwd: source.cwd, providerId: source.providerId, sessionId: source.nativeSessionId }
```

丢掉的正是 **`agentProfileId`**。`TraceArchiveCaptureArgs` 里它是可选字段，`iterateTraceArchiveCapture` 会对每个分片调用 `assertProfile(args.agentProfileId, segment.agentProfileId)`；分片里记着命名 Profile 标识，比较对象却是 `undefined`，于是任何"归档记录了命名 Profile"的合法来源都被拒绝。默认（无命名 Profile）运行不会触发，因为分片记的是 `null`，而 `(null ?? undefined) === undefined`。

## 3. 修复（源码，2 个文件）

- `captureArchivePrefix` 改用读取器自己的 `TraceArchiveCaptureArgs` 类型，不再手写更弱的四字段形状。
- `captureArgs` 从**刚刚被证明过的 `native` 身份**派生，Profile 存在时随行传递。
- 跨 Profile 仍然拒绝，且不会"跳过归档改用 reader"：分片记录的 Profile 与来源不一致时照样 fail closed。
- `conversation-side-chat.fixture.ts` 按生产写法记录 `request.agentProfileId ?? null`，让 fixture 不再掩盖这一层。
- 兄弟路径核对：`iterateTraceArchiveCapture` 在仓库内只有这一处调用；`streamTraceArchiveTurn`（单轮已记录对话路径）本来就不做 Profile 断言，保持原合同；没有加推测性分支。

测试 Profile 全部是合成值（`pi:0123456789abcdef` / `pi:fedcba9876543210`），**没有复制**用户的 session id、cwd 或正文。

## 4. 回归测试：旧实现失败、新实现通过

新增 `src/main/conversation-side-chat-source-profile.test.ts`（6 个用例，生产 seam `createSideChatSourceDeps` + 真实归档，只有 catalog 是假的）：

| 场景 | 断言 |
| --- | --- |
| 命名 Profile 且归档记录同一 Profile | preview 与 **create 都成功**，`source` 持久化同一 Profile，正文读回 |
| 子会话以另一个 Profile 为目标 | `source` 保持来源 Profile，`initialTarget` 才是目标 Profile |
| 归档显式记 `null`（历史形态） | 无 Profile 来源仍可创建 |
| 归档完全无该字段（legacy） | 同上 |
| 无原生 reader 的 Provider（codex） | 归档仍是权威，可创建 |
| 归档记录另一个 Profile | 先有同归档同 Profile 的**正向对照**，再拒绝 |

失败证据（都是真实运行）：

- 去掉 Profile 传递、其余不动：**3 failed / 3 passed**，失败信息正是截图里的 `来源归档属于其它 Agent Profile，不能作为侧聊来源`（`TraceArchiveCaptureError`），日志 `/tmp/neg-control-profile.log`。恢复后 6/6 通过。
- 归档 Profile 闸门临时停用（仅本地负控，未提交）：外来 Profile 的 **createSideChat 会成功**，"必须拒绝且不留子会话"的断言随即失败（`promise resolved … instead of rejecting`，日志 `/tmp/neg-gate-create.log`）。这证明 `08b826cf` 里新增的"真创建请求 + 正向 preview 指纹"确实依赖该闸门，而不是靠指纹检查兜底。

## 5. 当前安装仍是坏的（用户明确选择不装）

| 项 | 运行中的 App（其它 lane 构建） | 本分支已验证但**未安装**的构建 |
| --- | --- | --- |
| App 版本 | `0.2.237` | `0.2.237` |
| 私有 CLI | `0.2.56` | `0.2.55` |
| `app.asar` | `7a5ddc400f79212da4e5d4077b583d8f61dd88f8d7de0395c43c2d97d7bb596b`（Oct 31 23:26） | `33931944edf52242aad863e6125c7905e7c95ee544de899f00ae0f4db9152858` |
| 是否含本修复 | **否** | 是 |

"不含"是直接读出来的：安装产物的 `out/main/index.js` 仍是四字段 `captureArgs`（`cwd: source.cwd, sessionId: source.nativeSessionId`，没有 `agentProfileId`），渲染层的 `reasonOf` 也还是旧的单次剥离版本。

后果要说清：

- 用户在跑的应用上**这个报错仍然存在**；重启不会修好，因为安装字节里没有这次修复。
- 本次没有执行安装器，没有把 CLI `0.2.56` 降级成 `0.2.55`，也没有再打包。
- 另一份 0.237/CLI 0.56 的来源不在本仓库任何 ref 里（`git log --all -S'0.2.56'` 为空），它的 WIP 属于另一位 owner，本分支不碰、不复制。
- 后续要真正交付给用户，需要等那位 owner 的 CLI 0.56 提交并入主线后做一次新版本构建；那不属于本单元的授权范围，也不是自动授权。

## 6. 版本与集成（源码）

| 项 | 值 |
| --- | --- |
| 源码修复提交 | `80823c6b`（Profile 传递 + fixture + 回归测试） |
| 文案规范化提交 | `34bc6475`（`reasonOf` 去掉内部错误类名 + 单测） |
| 外来 Profile 创建拒绝测试 | `08b826cf` |
| 合并冻结主线 | `682b80da`，merge `f9a01039`（App `0.2.236` / CLI `0.2.55`），主线 65 个文件全部保留，无冲突 |
| 版本提交 | `4ea51adf chore(release): scry 0.2.237`（根 `package.json` + `package-lock.json`；CLI 保持主线 `0.2.55`，没有回退到 `0.2.53`） |
| 基线 | `f9a01039`（`main` 未移动、未 push；由父级 FF） |

## 7. 本次实际跑过的门禁（合并后的 0.237 树）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run check:cli-release` | exit 0，61 文件 / 813 测试；tarball smoke `version 0.2.55` |
| `node scripts/cli-package-smoke.mjs`（Node 24.18.0） | exit 0，CLI `0.2.55` |
| Node 20.20.2 临时官方运行时 smoke | exit 0；manifest sha256 `c6f74825…`、dist sha256 `6375a1d4…` 与清单一致，用完删除（记录 `/tmp/scry-node20-runtime-record-237.txt`） |
| `npm run test:renderer:ui` | exit 0：Credits、conversation IPC、Pi 原生历史、side-chat 181 页快照遍历、五个**目标** Provider 各两次发送、10 条回执 |
| `npm run pack` | 首次即 exit 0：524 文件 / 5192 通过 / 4 skip；bundle 287,081,132 B；`runtimeDependencies 311`；`scryCliVersion 0.2.55`；packaged security fixture 通过 |
| `npm run performance:measure -- --compare f9a01039` | 135 行全部 measured，**0 worse**，Ratchet passed；候选 `4ea51adf`（干净树）。计数器仍不覆盖原生命令正文捕获，本次只新增一个字段，不作 L2 提速声明 |

五个 Provider 是"五个**目标**"，不是"五个命名 Profile 来源"：Profile 只对 Pi 合法（`parseTarget` 强制 Pi 必须选命名 Profile，其它 Provider 只允许默认配置），所以本修复的 Profile 语义只有 Pi 这一条来源路径。

## 8. 首次失败与历史记录（不掩盖）

- 上一单元 `npm run pack` 首次失败过一次：`external-links-smoke.mjs` 断言打印完毕后清理临时 HOME 报 `ENOTEMPTY: rmdir …/home/.qoder`，根因 **UNKNOWN**（没有 writer pid / 写入事件 trace），人工重跑完整链通过，未改 gate、未加自动重试。本单元 `npm run pack` 首次即通过。
- `pack` 日志里有一条 `[scry] failed to discard an unpublished side-chat snapshot: ENOENT … user-data`：来自既有测试用例自己的清理路径（临时 userData 已被删除），测试全部通过，不是门禁失败。
- 本单元没有出现需要修复的本地失败；也没有把任何失败标成 flake 或环境问题。
- 上一单元提交身份笔误（`bipjiang0611`）经父级批准后只对那一个未推送提交 `0f914409` 做过一次 `--amend --reset-author`；本单元所有提交（`08b826cf`、`682b80da`、`4ea51adf` 及本文档提交）author/committer 均为 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。

## 9. 仍然存在的限制

- **没有安装**：`/Applications/Scry.app` 里仍是别处的 0.237/CLI 0.56，用户报的错误在跑的应用里依旧是坏的；重启无效。
- **同号不同物**：App 版本同为 0.237 的两份构建哈希不同（`7a5ddc40…` 与 `33931944…`），不能靠版本号判断哪个含修复。
- **不是跨 Profile 放宽**：跨 Profile 归档仍然拒绝，这是产品合同，不是本次绕过的问题。
- **不承诺更快**：只多带一个可选字段；性能计数器不覆盖原生捕获路径。
- **等待另一位 owner**：CLI 0.56 的提交并入主线后再做新版本构建，才能真正把修复交到用户机器上；这次源码候选由父级 FF 到实际 main 工作树，本分支不 push。

## 10. 相关文档

- [large-history-delivery.md](./large-history-delivery.md)：`0.2.235` 大历史交付记录（历史）。
- [large-history-fix.md](./large-history-fix.md)：大历史实现与边界。
- [large-history-verification.md](./large-history-verification.md)：逐项验证与失败现场。
