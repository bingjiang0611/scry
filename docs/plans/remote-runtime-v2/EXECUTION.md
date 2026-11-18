# 执行任务书 · Batch 1（P0 + P1 + P2 代码，P3 + P4 设计）

给执行 agent。目标是一次做完下面全部任务并自行验证，中途不需要等核验方。读完本文件、[PLAN.md](PLAN.md)、[REVIEW.md](REVIEW.md) 后直接开工。

## 0. 工作约定

- 分支：`claude/remote-runtime-v2`。先 `git pull` 拿到最新，所有提交推回这个分支。不开 PR、不合入 main、不改 App 版本号、不安装或重启用户正在用的 App。
- 每个任务（T0…T6）至少一个提交，信息格式 `perf(remote): T2 desktop persistent lanes`。一个提交只做一个任务，方便核验方逐个看。
- 每完成一个任务就更新 [STATUS.md](STATUS.md) 并 push，不要攒到最后。
- 必读并遵守：仓库根 `CLAUDE.md`（五条不妥协项）、`docs/agent/verification.md`、`docs/agent/change-checklists.md` 的「Provider 或 run-control 改动」「IPC / Workspace / Terminal 改动」两节、`docs/performance-loop.md`。仓库的 `scry-performance-climb` skill 可用于测量流程。
- 阻塞时不要停工：写进 STATUS.md「阻塞」，跳到下一个独立任务。T0 → T1、T0 → T2 → T3/T4/T5 有依赖，其余独立。
- 本批**删除旧兼容路径是允许的**（Scry 未对外发布）。例外：配对通道（`pairing-transport.ts`、pair 端口）保持现状；宿主对 one-shot 请求的接受逻辑本批不删，iOS 不受影响。

## 1. 停止条件（只有这些情况停下，写进 STATUS.md「需要决定」后继续其他任务）

1. 需要放宽 CLAUDE.md 任一不妥协项，或改变 trust / 授权 / 权限策略。
2. 需要改变 Provider 能力语义、证据质量标记（exact/estimated/inferred/partial/unavailable）的含义。
3. 需要真实 Provider 额度、真实账号、前台窗口或系统焦点。
4. 测试只能靠删断言、加固定 sleep、放宽超时或把失败改成空成功才能通过。
5. 发现 REVIEW.md 的事实与代码不符，且会改变任务做法。

## 2. 任务

### T0 · 分段测量（P0）

- `desktop-transport.ts`（T2 之后是 lane 实现）：新增 named trace `remote.client.request`，阶段 `connect_started`、`secure_connected`（仅新连接时出现）、`request_written`、`first_byte`、`response_parsed`；属性只记 `op`、`lane`、`reused: true|false`。
- `inner-mtls-host.ts`：`remote.host.dispatch`，属性 `op`，阶段 `authorized`、`dispatched`。
- `pi-catalog.ts`：`pi.catalog.probe` 增加属性 `reuse: cold|warm`，冷/热由是否 spawn 决定。
- 在 `scripts/performance-paths.json` 的 `remote` / `providers` 组登记新 trace，`npm run performance:inventory` 通过。
- 隐私：不记 cwd、路径、提示词、错误正文、证书内容。
- 验收：单测断言阶段序列（新连接与复用连接各一条），失败路径以 `error` 结束 trace。

### T1 · 宿主 Provider 热池（P1）

- 新文件 `src/main/providers/provider-warm-pool.ts`，把 `pi-catalog.ts` 的停放逻辑泛化：key = provider + profile id + canonical cwd + executable（及其 fingerprint，如已有）+ 环境深比较；成功才停放、失败立即关闭；上限 8；空闲 TTL 60 s；`touch(key)` 续期；按 cwd/profile 定向失效；`dispose()` 等待退出。`pi-catalog.ts` 改为使用它。**现有测试原样通过**：`src/main/providers/pi-lifecycle.test.ts`、`catalog-performance.test.ts`、`pi.test.ts`、`scripts/performance-counters/` 下的 pi-probe 计数测试（只允许改测试中引用的模块路径）。
- 预热：远程设备读取会话（history 打开、`providers` 的 `detail: selected`）时，以及本机会话被选中时，对该 Provider/profile/cwd 预热。预热只能在该 cwd 已通过现有工作区授权与 trust/fingerprint 校验后发生；校验失败不预热、不报错给用户。若本机侧找不到合适的 main 进程信号，只做远程侧并在 STATUS 说明。
- 续期：会话存在 live run 或 60 s 内被读取过时 `touch`。
- 宿主单飞：`remote-gateway-catalog.ts` 的 `listProviderControls`、`listCommands` 按 providerId + profileId + cwd 合并**并发中**的请求；完成后不复用结果。每个调用方仍各自先 `authorize(peer)`。
- 调研（只写结论，不改代码）：Claude / Codex / OpenCode / Qoder 的 catalog 与 run-controls 读取是否每次冷启动进程、耗时量级、能否套用热池。
- 验收测试：复用时不 spawn；失败不停放；trust 校验失败时不预热（deny 路径）；定向失效只关匹配项；单飞合并并发但不跨完成复用；撤销设备后单飞中的其他调用方仍被拒绝。

### T2 · Desktop 持久 lane（P2a）

- 新文件 `src/main/remote/desktop-lane.ts`，照 `experiments/remote-g0/swift/Sources/RemoteTransport/Lane.swift` 移植（读懂再写，不逐行翻译）：
  - 四条 lane：control、status、watch、bulk；每个 connection 一组，跟随 SSH tunnel 生命周期，tunnel 关闭则全部失效。
  - 每个请求带 `keepAlive: true`；回包不以 `{"keepAlive":true,` 开头则报 `desktop_protocol_mismatch`，**不退回 one-shot**。
  - notSent（新连接 secureConnect 前，或请求字节未写出时失败）可在新连接重发，最多 2 次；lost（已写出）只对标记为 replayable 的读重放 1 次；写操作 lost 一律抛出，由现有逻辑记为 unknown。
  - 客户端空闲 20 s 主动关闭；响应超时 control/bulk 30 s、watch/status 40 s；`abortOnCancel` control 为 false，其余为 true（取消即拆 lane）。
  - 宿主一问一答：同一 lane 上请求串行排队，绝不并发写入。
- `desktop-client-base.ts` 的 `request()` 改为按 op 路由 lane，映射表写成代码常量并抄进 STATUS。写操作仍经 `serializeWrite`，走 control lane，replayable=false。history、大 trace、附件走 bulk。
- 删除运行通道的 `desktopTlsRequest` one-shot 调用路径（配对保留）。
- 宿主：`InnerMtlsHost` 按证书指纹索引连接；`RemoteHostService.revokeDevice` 撤销后 destroy 该设备指纹的全部连接（包括在途长轮询）。
- 验收测试（沿用 `src/main/remote/desktop-client-real-host.test.ts` 的真实 InnerMtlsHost 方式，不 mock TLS）：
  - N 个连续请求只发生 1 次握手（统计宿主 `secureConnection` 次数）；
  - 宿主空闲断开后下一个请求自动重连成功；
  - notSent 重发成功；写请求 lost 后报 unknown 且宿主只收到一次（断言 ledger 只有一条 intent）；
  - bulk 请求被取消时 control lane 上的请求不受影响；
  - 撤销设备后在途长轮询立即失败，后续请求 `device_not_authorized`；
  - 宿主不回 keepAlive 前缀时报 `desktop_protocol_mismatch`。

### T3 · 长轮询替代短轮询（P2b）

- 宿主：给 `watch` 增加不读 shadow output 的模式（例如 `output: false`，此时不调用 `runOutput`，返回中不含 output）。理由见 `docs/desktop-remote.md`「输出缓存故障」一条；不要让输出缓存故障再次阻塞生命周期。
- Desktop：`runStatus` 改为在 watch lane 上长轮询（`waitMs` 15 s），`liveRun` 改为在 status lane 上用 `liveRuns` 长轮询并带 revision。
- Renderer：`RemoteChatControls.tsx` 去掉 1.5 s 定时轮询，改为「长轮询返回 → 处理 → 立刻发起下一次」；trace delta 只在长轮询报告变化时读取。保留可见性暂停、视图切换时作废旧序列、错误退避。
- 验收：`node scripts/desktop-remote-ui-smoke.mjs` 及其 `--session-parity-only`、`--session-lifecycle-only`、`--unknown-receipt-only`（含 `--negative-unknown-receipt-control` 负对照）全部通过；新增单测：会话空闲 60 s 内 RPC ≤ 6 次；宿主发生变化后 1 s 内客户端拿到更新。

### T4 · catalog 合批（P2c）

- 宿主新增 op `catalogSnapshot`：一次返回 info、projects、providers（metadata）和第一页 sessions，带 `revision`；请求携带已知 revision 且未变化时返回 `{ unchanged: true, revision }`。后续分页仍用 `sessionsPage` + snapshot。
- Desktop `catalog()` 改用它，删除旧的 4 次调用路径；`providerControls` 不再先发 `info`，改用最近一次 catalogSnapshot 的能力（能力过期就重读，不猜）。
- 验收：一次 RPC 完成 catalog；unchanged 路径；授权撤销后拒绝；现有 catalog 相关测试迁移后通过。

### T5 · 协议版本硬校验

- `src/shared/` 定义 `REMOTE_PROTOCOL_VERSION`（从 2 开始）。宿主在 info / catalogSnapshot 中返回；Desktop 每条 lane 的首个请求携带 `protocol`；不一致时宿主返回 `protocol_mismatch`，Desktop UI 显示「宿主与客户端版本不一致，请升级」，并区分是哪一端更旧。
- iOS：在 `G0Transport` / `RelaySession` 的请求中同样携带 `protocol`，并补 Swift 测试。若当前环境无法构建 Swift，标记 `not-run`，不要假装通过。
- 验收：一致 / 不一致 / 缺字段三条路径的测试。

### T6 · P3、P4 设计文档（只写文档，不写实现代码）

- `docs/plans/remote-runtime-v2/P3-daemon-design.md`：进程边界（哪些模块迁出 Electron main，逐一列文件）、本机通道认证、生命周期（按 PLAN.md 已定决策：App 拉起、关闭后继续运行、可选登录自启）、打包与私有 CLI 绝对路径、启动环境清洗、进程身份登记与停止规则、崩溃恢复、macOS/Linux 差异、迁移步骤、测试计划。
- `docs/plans/remote-runtime-v2/P4-event-log-contract.md`：事件 / 命令 / 回执 / outbox 表结构，事务边界，与现有 `session-ledger.ts`、intent 回执的映射，四个 projection，快照 + cursor 协议，证据引用格式与质量标记如何携带，「进程丢失副作用作废」的具体规则，哪些现有轮询被替代，测试（重放、幂等、乱序、崩溃）。
- 可以只读参考 T3 Code 的 `docs/orchestration-v2/` 与 `docs/internals/overview.md`（`git clone --depth 1 https://github.com/pingdotgg/t3code`），不复制代码。
- 两份文档都要逐条说明与 CLAUDE.md 五条不妥协项的关系，并给出「需要维护者决定」清单。

## 3. 交付前全局验证

按顺序运行，结果（通过数 / 失败输出摘要）写进 STATUS.md：

```bash
npx vitest run src/main/remote src/main/providers src/renderer/components scripts/performance-counters
npm run typecheck
npm run build
npm run build:cli
npm run performance:inventory
npm run performance:measure -- --compare 183415b   # 与分支起点比较；ratchet 必须通过
npm run test:desktop-remote                        # 需 macOS；不可用时标记 not-run 并说明
swift test --package-path experiments/remote-g0/swift --filter 'WireTests|LaneHandlerTests'   # T5 改了 Swift 时
git diff --check
```

不能运行的项目写 `not-run` + 原因，不得写成通过。

## 4. 完成定义

- T0–T6 全部提交并 push，或在 STATUS.md 写明未完成原因。
- STATUS.md 每个任务都有：提交 hash、改动文件、测试证据、已知限制。
- 没有任何测试被跳过、删除断言或放宽超时。
