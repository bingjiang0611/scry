# Batch 2 核验结论

核验对象：`a0b2355..577995b`（17 个提交，author/committer 均为 `bingjiang0611` noreply）。核验人只读代码与复跑测试，没有改实现。

## 总结

F1、F2、F3、F4、P3a、本机通道可以接受。S1 引入一个尾沿问题，需要在 Batch 3 修。P3b 的阻塞判断成立：远程宿主依赖本机运行管线，这正是 Batch 2 任务书已识别的设计缺口，不能先出一个只会握手的空壳 daemon。B2-D 设计方向正确，但有三处需要更正后才能照着实现。

## 复跑（Linux 容器，Node 22，非目标机）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npx vitest run src/main/remote src/daemon src/host-runtime src/main/bootstrap src/main/run-registry src/renderer/components/RemoteChatShared.test.ts` | 92 files，621/622 通过 |
| 唯一失败 `desktop-directory-picker.test.ts › rejects unreadable directories` | 环境问题：容器以 root 运行，`chmod 0` 对 root 无效（Batch 1 已记录同一现象），与本批无关 |
| `electron-security-smoke` | 未复跑：容器没有可运行的 Electron。归属仍未知，转为 Batch 3 任务 B3-V1 |

## 逐项

### F1 取消排队请求（`2d6b0f5`）：接受
`state.current` 只在自己的交换里设置和清除，`onAbort` 只在 `state.current === call` 时 drop，`closeConnection` 不在有在途交换时 drop。语义与 REVIEW-BATCH1 一致。

### F2 notSent 判定（`7f5f111`）：接受
只有写之前检查到通道已关闭才打上不可枚举的 `desktopLaneNotSent` 标记；写回调报错不再算 notSent，不可重放请求报 unknown。与 `Lane.swift` 对齐。

### F3 长轮询 tick（`f1527c5`）：接受，一个小遗留
`RunRegistry.subscribe/notifyChanged`，注册、移除、停止、提问开关都发信号，`LiveWatchers.close()` 在 `closeReadResources` 中退订，tick 回到 1000 ms。测试先失败（79 次对上限 25）后通过，`desktop-long-poll.test.ts` 的 `<= 1100` 调整理由成立（那条走的是无信号兜底路径）。
小遗留（不阻塞）：Mac run 的 `externalSessionId` 稍后才绑定时没有显式 `notifyChanged()`，设备要等 1 s 兜底 tick 才看到会话归属。Batch 3 顺手补一行即可（B3-F2）。

### F4 预热范围（`bf79591`）：接受
`catalogWarmPool` 是 adapter 声明的能力，registry 查询，不按 providerId 判断；未注入能力查询时不预热（fail closed 到「不多起进程」）。

### S1 trace 读取合并（`a334c20` 测量、`77dd703` 优化）：需要修
测量与优化分开提交，L1 标注正确，240 → 60 次/分钟的结论可信。
**问题：只有节流，没有尾沿读取。** 自己发起的 run 走 `runStatus`，它是 `watch output:false`，宿主在有新 ledger 事件时返回（`host-controller-watch.ts` 的 `#watch`），客户端随即把 cursor 推过这批事件，下一次请求带 `waitMs: 15000` 停在宿主上。现在 `needsTraceRead` 在节流窗口内一律返回 false（`RemoteChatShared.ts`），于是：

1. t=0 一批事件，读 trace，`lastTraceRead = 0`。
2. t=300ms 又一批事件（例如工具开始），长轮询返回，节流内跳过读取，cursor 已越过这批事件。
3. run 接下来 15 s 没有新事件（长工具调用、等待模型首 token），下一次长轮询要停满 15 s。

结果：t=300ms 那批内容在屏幕上最多晚 15 s 才出现，而优化前（`changed` 强制读）和基线（1.5 s 短轮询）都没有这个问题。修法是在跳过时安排一次尾沿读取：节流窗口到期时如果期间有被跳过的变化，就单独读一次 `traceDelta`，不依赖下一次长轮询返回。见 B3-F1。

**同类的既有问题（Batch 1 T3 引入，不是 S1）：** 跟随别处发起的 run（Mac 或其他设备）走 `liveRun`，`liveRuns` 的 revision 只反映 run 集合与状态，不反映内容；客户端带 `waitMs: 15000` 停住（`desktop-client-run.ts` 的 `liveRun`）。因此被跟随 run 的内容只在集合变化或 15 s 窗口到期时刷新，基线是 1.5 s。B3-F1 一并修：被跟随的 run 在屏幕上且仍 live 时，内容读取按节流节奏独立进行，不挂在 `liveRuns` 长轮询上。

### P3a 宿主组装层（`3d48307`）：接受
`createHostRuntime` 抽出后 `remote-host.ts` 只剩 Electron 侧职责；值导入图检查带自检（对 `remote-host.ts` 必须命中），可以复用到 daemon 入口。

### P3b 本机通道（`6571ce2`）：接受；daemon 未交付的判断成立
本机通道复用 `InnerMtlsHost.serve`，`0700` 目录、`0600` socket、只绑 unix socket、路径长度检查、协议版本硬拒、撤销后拒绝、非本机签发证书被拒，测试用真实 TLS。
不交付空壳 daemon 是对的：它回答不了任何真实请求，交付它只会让「完成」名不副实。

### B2-D 本机运行管线设计（`148d59d`）：方向接受，三处更正
迁移顺序（先去 Electron，再让 daemon 承载宿主）、SQLite 单写者、trace 推送、recorder 在 daemon 内独立做 trust 判定、`ProviderOperationGate` 单一持有者，这些都对。需要更正：

1. **§7 凭据描述与代码不符。** `safeStorage` 现在只用于桌面端连接远程宿主时的本地凭据（`remote-connections.ts` 的 `DesktopRemoteClient`），不是 Provider 认证；Provider 认证由各 Provider CLI 自己管理。宿主身份私钥是 `0600` 文件（`host-identity.ts`），daemon 可直接读。删掉「daemon 通过本机通道拿短时凭据」一段，改为如实列出：宿主身份文件随 daemon 走；`DesktopRemoteClient`（桌面连别的宿主）留在 App；Provider 认证不经 Scry 存储。
2. **缺 daemon 运行时选择。** `better-sqlite3` 按 Electron ABI 编译（`asarUnpack`），普通 Node 加载不了同一个 `.node`。设计要写明 daemon 用什么跑。建议：用 App 自带的 Electron 可执行文件加 `ELECTRON_RUN_AS_NODE=1` 启动（同一个已签名二进制、同一 ABI、不需要第二份原生构建）；`utilityProcess` 会随 App 退出，不满足「关闭 App 后 run 继续」。同时写明：启动环境清洗与私有 CLI 绝对路径对 daemon 同样适用；RunAsNode 需要保持可用，这是有意的取舍，要在设计里说明而不是默认。
3. **§11 第 4 条（新旧两条路径共存一个版本）不需要。** Scry 未对外发布，维护者已决定不保留兼容。开发期可以用 `SCRY_HOST_DAEMON` 开关回滚，合入前删除进程内宿主与 App 直连 SQLite，不留兼容版本。

## 对 status/b2-p3b.md 三个决定、B2-D §11 的答复（按建议执行，维护者可推翻）

| 问题 | 决定 |
|---|---|
| 先做运行管线去 Electron 化，再做 daemon 进程 | 同意 |
| `scope: local` grant | 保留 Batch 2 已定的方向，但等 App 真正经本机通道连 daemon 时（Batch 4）再实现；Batch 3 的 daemon 只服务远程设备，不需要它 |
| unix socket peer uid | 接受 `0700` 目录 + `0600` socket + 属主校验 + mTLS 身份，不引入原生模块。CLAUDE.md 已明确同一 macOS 用户下的并发攻击者不在信任模型保证范围内 |
| daemon 独占 SQLite | 同意 |
| 登录/重认证经本机通道排队 | 同意，Batch 4 实现 |
| 新旧路径共存一个版本 | 不需要，见上面更正 3 |
| daemon 崩溃自动重启 | 同意：supervisor 退避重启，有次数上限，失败如实显示，不掩盖 |

下一步：[EXECUTION-BATCH3.md](EXECUTION-BATCH3.md)。
