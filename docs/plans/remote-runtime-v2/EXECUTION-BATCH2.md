# 执行任务书 · Batch 2（Batch 1 修复 + P3 第一段）

给执行 agent。先读 [REVIEW-BATCH1.md](REVIEW-BATCH1.md)、[P3-daemon-design.md](P3-daemon-design.md)，再按本文一次做完。工作约定、停止条件、提交与 STATUS 规则与 [EXECUTION.md](EXECUTION.md) 第 0、1 节相同，不再重复。进度写到新文件 `STATUS-BATCH2.md`（同样的总览表 + `status/b2-*.md` 分文件）。

## 已采用的决策（维护者可推翻，推翻前按此执行）

- P3 本机通道：mTLS over unix socket，与远程同一协议、同一鉴权；本机设备是 `scope: local` 的 grant。
- daemon 不随 App 空闲退出；只有显式「退出 Scry 与后台服务」才停止，有运行中 run 时二次确认。
- daemon 与 App 版本不一致：硬失败（`protocol_mismatch`），不做只读降级。
- Linux 托管只做 `systemd --user`；无 systemd 时明确提示手动启动。
- 打包：electron-builder `extraResources`，与 App 同一产物。
- 批准拆分 `scripts/performance-paths.json`（按 path 组拆文件，并同步 `performance-report.mjs`、`performance-native.mjs`、`.github/workflows/performance.yml`）。测量代码与优化代码分开提交。
- 测量夹具双重 stringify：保持不改。

## 设计稿缺口（先补设计，再写代码）

P3 设计稿只覆盖了**远程宿主**（`src/main/remote`、`src/main/providers`）。但已定决策是「纯本机使用也走 daemon」，而本机会话的运行管线在 `src/main/bootstrap/`：`run-execution.ts`、`run-provider.ts`、`run-admission.ts`、`run-completion.ts`、`run-recovery.ts`、`run-live-state.ts`、`app-agent.ts`、`agent-runtime-ipc.ts`、`conversation.ts`，以及 `src/main/agent-runner.ts`、`app-store.ts`（SQLite）、trace ingestion、managed recorder 两阶段提交。设计稿 §6.4 写「main 里出现 Provider spawn 即为缺陷」，与这些现有路径直接冲突。

因此本批 P3 只做**远程宿主进 daemon**；本机运行管线迁移放到 Batch 3，本批只出它的设计。

## 任务

### B2-F1 · 修复：取消排队请求误断连接
按 REVIEW-BATCH1 F1。`state.current` 记录当前交换的 call，只有自己的交换才 drop。测试：A 在途、B 排队，取消 B，A 正常返回且宿主只握手一次；取消在途的 A 仍按原语义拆 lane。

### B2-F2 · 修复：写操作 notSent 判定
按 REVIEW-BATCH1 F2，对齐 `Lane.swift`：只有发送前检查到通道已关闭才算 notSent；`write` 回调报错对不可重放请求按 lost 处理。测试：写请求在 write 回调报错时不重发（宿主收到 ≤ 1 次，客户端报 unknown）；读请求同情况仍可重放一次。

### B2-F3 · 修复：长轮询 tick
按 REVIEW-BATCH1 F3。首选给 `MacRunSource` 加变更通知（Mac run 增删、状态、提问变化时 `notify()`），`LIVE_RUNS_TICK_MS` 恢复 1000 ms。做不到时，`historyVersion` 单独按 1000 ms 节流。先提交计数测试（一次 20 s 空等窗口内 `readHistoryVersion` 次数有上限）并证明它在当前实现上失败，再提交修复。保留「Mac 侧变化 1 s 内到达」的测试。

### B2-F4 · 修复：预热范围
按 REVIEW-BATCH1 F4。只对声明了热池的 Provider 预热：在 adapter 上加显式能力（例如 `catalogWarmPool: true`，当前只有 Pi），不按 providerId 字符串判断。测试：Claude 会话打开不触发预热读；Pi 仍触发。

### B2-S1 · 测量 trace 读取频率
在 `scripts/` 的远程 trace profile 或新 workload 中，对一个持续产出 ledger 事件的 run，统计 60 s 内 `traceDelta` 次数，分别在 `aada148`（基线）与当前代码上采集。若当前 > 基线 1.5 倍，把 trace 读取合并到 ≥ 500 ms 并再测一次。测量与优化分开提交，结果写进 STATUS，标明 L1。

### B2-P3a · 抽出宿主组装层（P3 设计 §9 第 1 步）
把 `src/main/bootstrap/remote-host.ts`（及 `remote-relay.ts`、`remote-connections.ts` 中属于宿主的部分）的依赖组装移到不依赖 Electron 的 `createHostRuntime(deps)`，放在 `src/host-runtime/`（或设计稿认可的位置）。Electron 相关输入（userData 路径、safeStorage 加解密、通知回调）以接口注入。main 仍在本进程内调用它，**行为不变**。
验收：import 图断言 `createHostRuntime` 及其传递依赖不 import `electron`；现有 `src/main/remote`、`src/main/bootstrap` 测试与 `node scripts/desktop-remote-ui-smoke.mjs` 全部通过。

### B2-P3b · daemon 进程与本机通道（P3 设计 §9 第 2 步，影子模式）
- `src/daemon/main.ts`：入口。启动时执行与 App 相同的环境清洗，写进程登记与单实例锁（`<userData>/daemon/daemon.lock`、`processes.json`），装配 `createHostRuntime`，监听 `<userData>/daemon/local.sock`（目录 `0700`、socket `0600`，Linux 加 `SO_PEERCRED` uid 校验，macOS 用 `LOCAL_PEERCRED`）。不监听任何 TCP。
- 本机通道：mTLS over unix socket，复用 `InnerMtlsHost.serve()`；本机设备证书由 daemon 首次启动签发（沿用 enrollment 链路），私钥由 main 用现有加密存储保存；grant `scope: local`。
- `src/main/daemon-supervisor.ts`：App 启动先探活 `local.sock`（带协议版本），无响应则拉起 daemon 并等待就绪（≤ 10 s，超时为 `daemon_unavailable` 并在 UI 显示可操作错误）。
- 单写者：影子期由**台账锁**决定谁是宿主——daemon 持锁时 main 不装配进程内宿主，改用 `daemon-client`（复用 `desktop-lane.ts` 与同一协议）；daemon 不存在或拉起失败时 main 用进程内宿主。两者绝不同时持有台账。用环境变量 `SCRY_HOST_DAEMON=1` 开启影子模式，默认关闭。
- 打包：daemon 入口进 electron-builder `extraResources`，加入 package resource allowlist；私有 CLI 仍用 `process.resourcesPath` 绝对路径。
- 本批**不做**：默认走 daemon、删除进程内宿主、launchd/systemd 安装、本机会话运行管线迁移。
验收测试：
- 本机通道：本机 grant 撤销后 `device_not_authorized`；协议版本不一致拒绝；socket/目录权限断言；不存在 TCP 监听（断言 daemon 进程无 listen 端口）。
- 单实例锁冲突时第二个 daemon 退出且不碰台账；进程身份重验失败时不停止进程（`process_identity_changed`）。
- 影子模式下 `desktop-lane-real-host.test.ts` 的同等场景在 unix socket 上通过。
- 生命周期：`SCRY_HOST_DAEMON=1` 时关闭 App（测试实例）后，远程设备对 daemon 的长轮询与运行中的 stub run 继续；daemon 被 SIGKILL 后重启，离开 `dispatched` 的 run 变 `failed(host_restarted)`，未确认的写为 unknown 不重放。
- 安全：renderer 能力不变（现有 electron-security smoke 通过）。

### B2-D · 本机运行管线迁移设计（只写文档）
`docs/plans/remote-runtime-v2/P3b-local-runtime-design.md`：把上面「设计稿缺口」列出的本机运行管线迁入 daemon 的方案。至少覆盖：哪些模块迁、SQLite（`app-store.ts`）谁持有、trace ingestion 与 renderer 流式推送怎么走本机通道、managed recorder 两阶段提交在 daemon 内如何保持证据收敛、终端（`terminal`）与 source-control 是否迁、auth 与同 provider/profile 互斥锁、迁移步骤与回滚、测试计划、与 CLAUDE.md 五条的关系、需要维护者决定的问题。逐项引用现有文件路径。

## 交付前全局验证

```bash
npx vitest run src/main src/renderer/components scripts/performance-counters
npm run typecheck
npm run build
npm run build:cli
npm run performance:inventory
npm run performance:measure -- --compare a0b2355
npm run test:desktop-remote
node scripts/electron-security-smoke.mjs
npm run pack:artifact          # 改了打包与 resource allowlist，macOS 必跑
swift test --package-path experiments/remote-g0/swift --filter 'WireTests|LaneHandlerTests'   # 有完整 Xcode 时
git diff --check
```

Linux 目标机检查（`docs/agent/verification.md#linux-验证与交付`）无法执行就标 `not-run`。不能运行的写 `not-run` + 原因。

## 完成定义

- B2-F1…F4、S1、P3a、P3b、D 全部提交并 push，或在 STATUS-BATCH2.md 写明未完成原因。
- F1–F3 的回归测试在修复前的代码上失败过一次（写进 STATUS）。
- 默认路径（未设 `SCRY_HOST_DAEMON`）行为与 Batch 1 完全一致。
