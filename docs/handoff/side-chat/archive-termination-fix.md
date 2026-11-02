# 侧边会话 · 归档终止证据修复（App `0.2.238` / CLI `0.2.56`）

状态：修复已并入本地 `main`、完成门禁、打包并安装到 `/Applications/Scry.app`。本文记录当前事实与证据边界；日常运行中的实例需要用户自己重启才会加载新版本。

## 1. 用户看到的失败与真实归档形态

用户在右侧栏选一个 Pi 原生会话创建侧聊时报：

```text
TraceArchiveCaptureError / Error: 原生会话前缀包含没有终止证据的轮次，不能创建侧聊
```

只读核对聚合元数据（不读正文、不改 `userData`）后的事实：

| 项 | 实际值 |
| --- | --- |
| 该会话的归档分片数 | 13（sidecar） |
| 其中 `done:true` 的分片数 | 13（**全部**） |
| ordinal 11 | `status: interrupted`，但 `done:true` |
| ordinal 12、13 | `done:true` 且 `status: completed` |

也就是说，被旧实现称为「没有终止证据」的那一轮，recorder 其实写了终止，只是它没有完成。本文不记录该会话的标题、Profile 标识、cwd 或任何消息正文。

## 2. 根因：一个布尔值承担了两个事实

`src/main/conversation-side-chat-stream.ts` 旧代码把两件事压进同一个字段：

```ts
// 旧
status, settled: entry.done && status === 'completed', messages
```

`settled` 同时被用来回答两个不同的问题：**recorder 有没有写终止**（证据是否收敛）与**这一轮是不是 completed**（能否充当冻结边界）。于是：

- `conversation-side-chat-source.ts` 用 `!turn.settled` 判断「没有终止证据」，`done:true / interrupted` 被误判成证据缺失；
- 一旦前面的轮次被判为缺失，后面出现 terminal 轮次就抛出上面的错误，整个前缀被拒；
- 另一个方向同样错：`done:false`（recorder 未写终止）的轮次在旧代码里也照样 `assembleTurn`，为每个未终止分段留下输出副本与 spill 文件。

## 3. 修复：`terminal` 与 `settled` 分成两个事实

`StreamedTurn` 现在有两个字段（`conversation-side-chat-stream.ts`）：

| 字段 | 含义 |
| --- | --- |
| `terminal` | recorder 已经写了终止（Scry 归档为 `done === true`；原生 transcript 为 Provider 自己的终止标记）。只说明「结束了」，不说明「成功了」 |
| `settled` | `terminal && status === 'completed'`。**只有它能结束默认冻结前缀** |

捕获规则（`captureArchivePrefix`）：

1. 没有 terminal 的轮次：不在任何位置被捕获，正文也不读。它后面若还有 terminal 轮次，这是未经证明的前缀，仍然抛「没有终止证据」；若它是尾部，则按尾部丢弃。
2. 有 terminal 但不是 completed（`failed` / `interrupted`）：**捕获**，带自己的 `status` 进入较早前缀，但**不能**充当默认边界；捕获之后 `continue`，不改 `through`。
3. 默认前缀在最后一个 completed 轮次结束：`items.length = captured` 丢掉尾部的 interrupted/failed 轮次。
4. 显式请求的边界必须落在 completed 轮次上，否则抛「侧聊边界不是已完成的轮次，请重新预览；本次未创建侧聊」。
5. `done:false` 的中间轮次仍然拒绝，不产生部分快照，也不发布任何 child。

`streamTurns` 也改成先判定终止再装配：非 terminal 轮次 `yield` 时 `terminal: false`、`messages: []`，不再 seal 输出 spool；输入 spool 仍在同一个 `finally` 里释放。`settleTurn`（原生 transcript 路径）每条轮次只有一个终止，因此在那里写 `terminal: true`，语义不变。

## 4. 回归测试

| 测试 | 断言 |
| --- | --- |
| `src/main/conversation-side-chat-archive-termination.test.ts`（5） | ① completed → interrupted → completed：`throughOrdinal 3`，`statuses` 为 `completed, interrupted, completed`，interrupted 正文被捕获且不冒充完成；② 尾部 interrupted 被排除，`throughOrdinal 1`、标题与 `bodyBytes` 只描述冻结前缀；③ 中间 `done:false` 仍抛「没有终止证据」，且没有 child、没有发布的 history 目录变化；④ 只有 interrupted 的归档报「没有已完成轮次」，不是「没有终止证据」；⑤ 显式边界指向 interrupted 时拒绝，前一 completed 轮次仍是可用边界 |
| `src/main/conversation-side-chat-stream.test.ts`（4） | 非 terminal 轮次 `terminal:false`、不产出消息；预算与每个 spill 释放仍成立；调用方放弃 / 归档流抛错时 in-flight 轮次仍被释放 |
| `src/main/conversation-side-chat-source-profile.test.ts`（6） | 命名 Profile 传递、跨 Profile 拒绝（本单元未改动，作为相邻路径回归） |
| `src/renderer/constants/side-chat-copy.test.ts`（4） | 侧聊文案仍集中在 `src/renderer/constants/side-chat-copy.ts`，没有散落到组件 |

这些用例走生产 seam：`sideChatFixture` + 真实 recorder writer（`upsertTraceArchiveTurn`）+ 生产 `captureNativePrefix`，只有 catalog 是假的。Profile 与 session 都是合成值。

修复前的真实形态由「done/status 序列」证明，而不是靠对用户数据执行：用例用 3 轮完整复现了决定性边界（`done:true + interrupted` 在前，后面还有 completed 轮次）。真实归档是 13 片、第 11 片 interrupted，两者是同一条判定路径上的同一形态，但用例本身没有复制用户的 13 片归档或正文。

## 5. 旧实现 / 新实现负控（真实运行）

把 `conversation-side-chat-stream.ts` 与 `conversation-side-chat-source.ts` 临时回退到基线 `547ad016` 的版本、其余不动，再跑新测试：

| 目标 | 旧实现结果 | 失败信息 |
| --- | --- | --- |
| `conversation-side-chat-archive-termination.test.ts` | **2 failed / 3 passed** | `Error: 原生会话前缀包含没有终止证据的轮次，不能创建侧聊`（`captureArchivePrefix` 旧第 181 行）；显式边界用例拿到同一条错误，而不是「边界不是已完成轮次」 |
| `conversation-side-chat-stream.test.ts` | **1 failed / 3 passed** | `AssertionError: expected undefined to be false`（非 terminal 轮次仍在被装配并 yield） |

恢复当前实现后两个文件 **9/9 通过**。负控只在工作区做、用完立即还原，`git status` 干净，没有 stash、amend 或改写历史。日志：`/tmp/scry-238-gates/neg-control/old-impl-termination.log`、`old-impl-stream.log`。

## 6. 已经在内、本次未改的部分

- **Profile 传播修复已在主线**：`captureArgs` 从被验证过的 `native` 身份派生并随行 `agentProfileId`，跨 Profile 归档仍 fail closed。背景与当时的负控见 [profile-capture-fix.md](./profile-capture-fix.md)；本单元只做回归运行，没有重写。
- **用户可见文案集中管理**：本轮没有新增或修改用户可见文案，`src/renderer/constants/side-chat-copy.ts` 未动。
- 跨 Profile 拒绝、指纹与 `expectedThroughOrdinal/RunId` 校验、`done:false` 拒绝都是既有合同，本次没有放宽。

## 7. 提交

| 提交 | 内容 |
| --- | --- |
| `0c317954` | `fix(side-chat): separate recorder terminal from completed boundary`（`terminal`/`settled` 拆分 + 捕获规则 + fixture + 新测试） |
| `0fb364be` | `test(side-chat): pin the frozen title, bytes and empty-prefix refusal` |
| `8033c10a` | `fix(side-chat): never seal a turn the recorder did not terminate`（`streamTurns` 先判定终止；stream 测试） |
| `3b92bb5e` | `chore(release): scry 0.2.238`（根 `package.json` + `package-lock.json` 两个根字段；CLI 保持 `0.2.56`） |

本文档单独提交。基线为 `547ad016`；`main` 未 push。

## 8. 门禁（0.2.238 当前工作树，macOS 27.2 / arm64 / Node 22.22.1）

| 命令 | 实际结果 |
| --- | --- |
| `npx vitest run` 4 个 focused 文件 | exit 0，4 files / **19 passed** |
| `npm run typecheck` | exit 0（node + web） |
| `npm run check:cli-release` | exit 0：`src/cli`、recorder core、shared、normalize/danger/claude-locate/managed-turn-commit 共 **66 files / 848 tests**；tarball smoke `version 0.2.56` |
| `node scripts/cli-package-smoke.mjs`（Node 24.18.0） | exit 0，CLI `0.2.56` |
| 临时 Node 20 官方运行时 smoke | exit 0，CLI `0.2.56`。清单 `SHASUMS256.txt` 取 `node-v20.20.2-darwin-arm64.tar.gz`，校验 `466e05f3477c20dfb723054dfebffe55bc74660ee77f612166fca121dacb65b6` 通过后解压到临时目录；用完删除运行时与 tarball，未做全局安装 |
| `npm run test:renderer:ui` | exit 0（11m25s）：side-chat 大历史对话框 **181 页**（2005 轮 / 4010 消息 / 22.3 MB 归档）、side-chat 执行 **5 个目标 Provider**（codex / claude / qoder / opencode / `pi:` Profile）各两次发送共 **10 条回执**、快照 viewer 与游标 oracle 对照、workspace races、Credits、conversation IPC、Pi 原生历史（命名 Profile 恢复、混合/未知 Profile、55 轮分页） |
| `npm run performance:measure -- --compare 547ad016` | 首次即 exit 0：**135/135 measured，0 worse，Ratchet passed**；workload / ratchet / timeout 未改 |

日志：`/tmp/scry-238-gates/{cli-release,cli-smoke-node20,cli-smoke-node24,renderer-ui,perf-measure,pack,install,installed-security-smoke}.log`。本单元门禁没有出现需要修复的失败；`npm run pack` 与 `performance:measure` 都是首次通过，没有把任何失败标成 flake。

**L1 口径**：性能结论只有计数层。本次改动没有新增热路径工作，计数器也不覆盖原生归档捕获路径，因此不作 L2/L3 提速声明。

## 9. 产物与安装

| 项 | 值 |
| --- | --- |
| `npm run pack` | exit 0（10m47s）：552 files passed / 4 skipped（556），**5319 passed / 4 skipped**（5323），shell 测试 PASS；bundle 299,457,025 B（上限 346,030,080），`runtimeDependencies 312`，`scryCliVersion 0.2.56`，packaged security / files / remote-host smoke 全部通过 |
| 构建产物 | `dist/mac-arm64/Scry.app`，App `0.2.238`，`app.asar` SHA-256 `aeab87b8ae6bf74a8c9ab38d80dc1c6218ed8767383bcae5896a19ddf2a69a2c` |
| 安装方式 | 打包前只读检查点确认 `/Applications/Scry.app` 仍是 App `0.2.237` / asar `33104c06…` / CLI `0.2.56`，随后 `node scripts/install-macos.mjs`（即 `install:mac:dev` 的第二半）exit 0 |
| 安装结果 | App `0.2.238`，`com.scry.app`，`CFBundleVersion 0.2.238`，私有 CLI（`Resources/bin/scry` 与 `Resources/scry-cli`）都是 `0.2.56` |
| 字节一致 | 构建与安装的 `app.asar` SHA-256 都是 `aeab87b8ae6bf74a8c9ab38d80dc1c6218ed8767383bcae5896a19ddf2a69a2c` |
| 备份 | `/Applications/.Scry.app.backup`（仍是 `0.2.237`），未手工替换 bundle |
| 签名/公证 | `codesign -dv`：`Apple Development: baobingjiang@icloud.com (8Y6KR78CP7)`；`spctl -a -t exec` 结果为 rejected；`xcrun stapler validate`：「does not have a ticket stapled to it」。**没有 Developer ID 签名，也没有公证**，这是开发安装 |

安装后复核：

- 从安装后的 `app.asar` 抽出 `out/main/index.js`（2,742,783 B，SHA-256 `17ec3c47…`）与构建产物逐字节相同，并在其中确认：`terminal` 字段、`settled: terminal2 && status === "completed"`、非 terminal 不装配（`terminal2 ? await assembleTurn(...) : []`）、`sawUnterminated`、`items2.length = captured`、显式边界 `!turn.settled` 拒绝、`agentProfileId: native.agentProfileId`。
- 对 `/Applications/Scry.app` 直接跑隐藏隔离 security fixture（`node scripts/electron-security-smoke.mjs /Applications/Scry.app`，临时 `userData`/HOME，无真实账号）：exit 0，`terminal:true`、`rendererReloadTerminal`、`surfaces` 全项、`recording` 生命周期、`historyReload` / `historyRestart`、`popupDenied` / `navigationDenied` 都成立。
- 没有停止、重启或干扰用户正在运行的实例（既有 `Scry` 进程保持运行，未停止或重启），也没有写用户 `userData`。

## 10. 仍然存在的限制

- 用户日常运行的实例仍是升级前的进程；重新打开 App 后才会加载 `0.2.238`。
- 没有用真实 Provider 付费探针验证；`test:renderer:ui` 里的五个 Provider 是五个**目标**，不等于五个 Profile 原生来源——Profile 只对 Pi 合法，本次修复的终止语义来自隔离归档用例。
- 真实归档的 13 片形态只有聚合元数据，正文未读；修复由同一 done/status 序列的隔离用例证明，不是对用户归档的执行结果。
- 性能证据是 L1 计数，不是毫秒级提速结论。
- 本地通过不等于远端 CI/PR 通过；本轮未 push。
