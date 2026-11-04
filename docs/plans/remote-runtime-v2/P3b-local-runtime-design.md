# P3b · 本机运行管线迁移设计（只设计，不含实现）

状态：设计稿，配合 [P3-daemon-design.md](P3-daemon-design.md) 阅读。P3 设计只覆盖远程宿主；本文补上它缺的那一半：**本机会话的运行管线**（App 自己开始的那些 run）如何迁进 daemon。B2-P3b 的实现被这件事阻塞，证据见 [status/b2-p3b.md](status/b2-p3b.md)。

## 1. 为什么必须先做这件事

`createHostRuntime` 需要的东西不是可以跨进程传的配置，而是进程内的运行时：

| 宿主要的能力 | 现在住在哪 | 依赖 Electron 的方式 |
|---|---|---|
| 远程提交后真正跑 Provider | `src/main/bootstrap/run-execution.ts`、`run-provider.ts`、`run-admission.ts`、`run-completion.ts`、`run-recovery.ts`、`run-live-state.ts` | 通过 `trace-runtime.ts`、`run-live-state.ts` 里的 `app`、`BrowserWindow`、`webContents.send` |
| 会话列表与元数据 | `src/main/app-store.ts` → `src/main/db.ts` | `db.ts:7` 顶层 `import { app } from 'electron'`，默认路径取自 `app.getPath('userData')` |
| Provider 目录与控制 | `src/main/providers/registry.ts` 及各 adapter | 本身不 import `electron`，但 `pi-catalog` / 热池的上下文来自 App 配置 |
| 工作区 source-control | `src/main/source-control/service.ts` | `service.ts` 经 `ipc.ts`、`git.ts` 间接 import `electron` |
| 历史与工具面板 | `src/main/bootstrap/remote-history.ts`、`db.ts`、`mcp-execution-trust.ts` | 直接 import `electron` |

结论：daemon 要回答任何真实请求，就必须先拥有运行管线；而运行管线现在与 Electron 的 `app` / `BrowserWindow` / `webContents` 绑在一起。所以顺序只能是「运行管线去 Electron 化 → daemon 承载宿主」，不能反过来。

## 2. 迁哪些模块

**迁入 daemon（成为运行管线的唯一持有者）**

- `src/main/bootstrap/run-*.ts`（execution / provider / admission / completion / recovery / live-state）、`conversation.ts`、`app-agent.ts`、`agent-runner.ts`。
- `src/main/app-store.ts`、`src/main/db.ts`（SQLite 与 turn outbox）、`src/main/run-registry.ts`、`src/main/user-question.ts`。
- `src/main/remote/*` 全部（宿主、lane、ledger、pairing、workbench、provider discovery）。
- `src/core/turn-recorder/*` 的调用侧（`src/core/turn-recorder` 本身保持不变：无 Electron / SQLite / Provider SDK）。

**留在 Electron main（只做 UI 与 IPC）**

- renderer 桥接：`src/main/bootstrap/*-ipc.ts`、`privacy`、窗口与托盘、dock badge、通知。
- `src/main/bootstrap/trace-runtime.ts` 的**渲染转发部分**（`webContents.send`、`TraceOutputBridge`）；事件源改成 daemon 推送。
- `src/main/bootstrap/remote-host.ts`（113 行：env 判定、userData 路径、IPC handler）与 `src/host-runtime/host-runtime.ts`（B2-P3a 已抽出，可直接被 daemon 复用）。

**边界靠接口注入**：daemon 需要而只有 App 知道的东西，用显式接口传：`userDataDir`、`openPath`、`trashItem`、`notify`（dock/通知）、`rendererSink`（事件流）。

## 3. SQLite 谁持有

- daemon 独占写者。App 通过本机通道读 projection，不再直接打开数据库文件。
- 理由：SQLite 单写者模型与「台账锁」一致；两个进程写同一 WAL 会带来 `SQLITE_BUSY` 重试与不可解释的洞。
- 迁移步骤：先让 `db.ts` 接受注入的 `dbFilePath` 与 `outboxDir`（去掉顶层 `app` 默认值），App 里的调用先不变；再让 daemon 打开它，App 改为读 projection。WAL 文件与 outbox 目录搬到 `<userData>/daemon/`。
- 回滚：daemon 不启动时 App 仍按现有路径直接打开数据库（迁移期保留，Batch 4 删除）。

## 4. trace ingestion 与 renderer 流式推送

- Provider 事件在 daemon 内进入 `RunTraceRouter` 与 `TraceOutputBridge`（现在就在非 Electron 模块里），由 daemon 通过本机通道向 App 推 `run.trace` 事件；App 的原 `webContents.send` 变成「转发 daemon 事件」，合批与背压策略不变（16 ms 合批、high-water 等 ACK）。
- 权威证据仍在 daemon：`.scry` records、ledger、trace archive。App 只持有可丢的 projection。
- 断线语义：App 重连后按 cursor 续读，缺口如实上报（现有 `traceDelta`/`reset` 已实现），不静默补零。

## 5. managed recorder 两阶段提交

- recorder 的执行仍在 daemon（run 在 daemon 里跑），两阶段提交的等待条件不变：Provider result、hook 生命周期、diff 收敛。
- commit callback 的 trust 判定必须在 daemon 内独立完成（canonical cwd + 内容/可执行指纹），不能因为「同一个用户」而跳过。这与 CLAUDE.md 第 3 条一致：`full_access` 不替代仓库 trust。
- hook 的 private CLI 仍用 `process.resourcesPath` 下的绝对路径；daemon 打包后该路径由 daemon 自己的 resources 决定，必须显式注入而不是从 `app` 推导。

## 6. 终端与 source-control

- **终端（`desktop-workbench` PTY）**：迁。它属于 run/workbench 能力，宿主在 daemon 才能「关闭 App 后终端继续」。
- **source-control**：迁读写实现，但 `git` 调用与 workspace 授权必须仍在同一授权函数下（`authorizeWorkspace`）。App 侧只保留 UI 与 diff 展示。
- 两者都不新增绕过 authorization 的入口。

## 7. auth、凭据与同 provider/profile 互斥锁

- `ProviderOperationGate` 现在在 main 进程内保证「同 provider/profile 操作互斥」。迁入 daemon 后锁必须跟着走，否则本机 App 与远程设备会同时在同一个 profile 上启动 Provider。
- 结论：**锁只能有一个持有者**。daemon 持有；App 的登录/重认证也经本机通道排队，不再直接在 main 里启动 Provider 进程。

凭据的实际分布（按代码更正，之前写的「daemon 通过本机通道拿短时凭据」是错的）：

| 凭据 | 现在在哪 | 迁移后 |
|---|---|---|
| 宿主身份私钥与证书 | `host-identity.ts` 写的 `0600` 文件，路径在 userData | 随 daemon 走：daemon 直接读同一份 `0600` 文件，不经 App |
| 桌面端连**别的**宿主的配对凭据 | `src/main/bootstrap/remote-connections.ts` 的 `DesktopRemoteClient`，`safeStorage` 加密 | 留在 App：这是「本机作为客户端」的能力，与 daemon 无关 |
| Provider 认证（登录、token、订阅） | 各 Provider CLI/SDK 自己管理的文件 | **不经 Scry 存储**，daemon 只负责以同一用户身份启动 Provider，不搬运、不缓存、不落第二份 |

`safeStorage` 不参与 Provider 认证，因此 daemon 不需要任何「凭据通道」：它需要的一切要么是它自己 userData 里的 `0600` 文件，要么由 Provider 自己读取。

## 8. 迁移步骤与进度

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | `db.ts` / `app-store.ts` / `remote-history.ts` / `mcp-execution-trust.ts` 的 userData 注入化（不动行为） | Batch 3 · B3-M1 |
| 2 | `trace-runtime.ts` 拆成「事件源」与「renderer 转发」；run 管线对 `app`/`BrowserWindow`/`webContents` 的依赖改为注入 | Batch 3 · B3-M2 |
| 3 | daemon 进程承载宿主（`SCRY_HOST_DAEMON=1` 只是开发期开关，台账锁决定单写者） | Batch 3 · B3-P1 |
| 4 | 本机通道成为 App 的唯一运行入口；main 不再组装宿主 | Batch 4 |
| 5 | 删除进程内宿主与 App 直连 SQLite | Batch 4 |

本批（Batch 3）做到第 3 步，且只验证「daemon 能承载远程宿主并真跑 run」；App 仍用进程内宿主，两者不共存于同一 userData（`SCRY_HOST_DAEMON` 决定启动哪一条，默认关闭）。

回滚：Batch 3 之后关掉 `SCRY_HOST_DAEMON` 即回到进程内宿主；Batch 4 合入前删除进程内宿主与 App 直连 SQLite，**不保留兼容版本**（Scry 未对外发布，见 REVIEW-BATCH2 更正 3）。

## 8.1 daemon 用什么运行时（REVIEW-BATCH2 更正 2 要求的补充）

`better-sqlite3` 按 **Electron ABI** 编译并在打包产物里 `asarUnpack`，普通 Node 加载不了同一个 `.node`。可选方案：

| 方案 | 结论 |
|---|---|
| 系统 Node + 第二份原生构建 | 否：要维护两套 ABI 的 `better-sqlite3`，且 Node 版本由用户机器决定 |
| `utilityProcess.fork` | 否：Electron 的 utility 进程随 App 退出，不满足「关闭 App 后 run 继续」 |
| **App 自带 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1`** | **采用**：同一个已签名二进制、同一 ABI、同一 Node 版本，不需要第二份原生构建；进程独立于 App 主进程，App 退出后仍活着。开发期用 `node_modules/.bin/electron` |

采用 RunAsNode 有意的取舍：它让 Electron 可执行文件以纯 Node 运行（无 `app`、无窗口、无 GPU），所以 daemon 代码路径**不得**依赖任何 Electron API——这正是 B3-M1/M2 的目标，也由导入图测试守住。若将来 Electron 收紧 RunAsNode，替代路径是用同一二进制的独立入口重新评估，而不是退回系统 Node。

启动环境同样适用 App 的规则：清洗后的环境（不继承调用者的任意外部变量）、私有 CLI 用**绝对路径**（`process.resourcesPath` 下）、`runAsNode` 子进程不得把 Electron 相关变量当成可信输入。

## 9. 测试计划

| 目标 | 方法 |
|---|---|
| 导入图去 Electron | 复用 B2-P3a 的 `host-runtime-imports.test.ts` 检查器，入口改为 daemon 的组装模块 |
| 单写者 | 两个 daemon 竞争台账锁：第二个退出且不改台账；`process_identity_changed` 时不停止进程 |
| 无 TCP | 断言 daemon 进程只有 unix socket（`lsof`/`netstat` 或进程内 `server.address()`） |
| 关闭 App 后 run 继续 | 独立 test 实例 + `SCRY_HOST_DAEMON=1`，关闭 App 后远程设备仍能长轮询到同一 run |
| daemon 被 SIGKILL | 重启后 `dispatched` 的 run 变 `failed(host_restarted)`，未确认的写为 unknown 且不重放 |
| 证据收敛 | recorder 两阶段提交在 daemon 内仍等 Provider result / hook / diff；不因进程拆分提前提交 |
| renderer 能力不变 | 现有 `scripts/electron-security-smoke.mjs` + `test:desktop-remote` |

## 10. 与 CLAUDE.md 五条的关系

1. **证据不说谎**：projection 变客户端缓存，权威仍在 daemon；缺口按 `unavailable`/`unknown` 上报，不因跨进程而补零。
2. **Provider 差异显式存在**：adapter 能力随 daemon 走，App 只展示 daemon 给出的能力 envelope。
3. **权限与 trust 分离**：`full_access` 仍只是「以本机权限运行」；仓库 trust 与 fingerprint 在 daemon 内每次重验。
4. **renderer 不可信且无特权**：本机通道是新入口，App 的 renderer 仍只能经 typed preload 调用 main handler，main 再经 daemon-client 调 daemon；renderer 不直接连 socket。
5. **Recorder Core 独立**：`src/core/turn-recorder` 不因迁移引入 Electron/SQLite/Provider SDK 依赖。

## 11. 需要维护者决定

1. daemon 是否独占 SQLite（本文建议独占），还是 App 保留只读连接（会有 WAL 语义与「读到半截」的风险）。
2. 本机通道是否需要 `scope: local` grant 字段（现有 `DeviceGrant` 没有 scope）。
3. `ProviderOperationGate` 由 daemon 独占后，App 的登录/重认证是否接受经过本机通道排队（会增加一次进程跳转）。
4. daemon 崩溃后是否自动重启（本文建议由 supervisor 兜底，但要有退避与次数上限，且不掩盖失败）。

已决定、不再列为待定的：迁移期**不保留**两条路径共存的兼容版本（REVIEW-BATCH2 明确）；`scope: local` grant 留到 Batch 4；unix socket 用 `0700` 目录 + `0600` socket + 属主 + mTLS，不引原生模块。
