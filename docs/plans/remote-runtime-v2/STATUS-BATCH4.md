# Batch 4 状态

分支 `claude/remote-runtime-v2`。任务书：[EXECUTION-BATCH4.md](EXECUTION-BATCH4.md)；起点 `66225f1`（Batch 3 收尾）。
工作约定、停止条件、提交与 STATUS 规则沿用 [EXECUTION.md](EXECUTION.md) 第 0、1 节。

## 总览

| 任务 | 状态 | 提交 | 备注 |
|---|---|---|---|
| B4-F1 renderer UI 门禁 | 完成 | `见 status` | [b4-f1](status/b4-f1.md)：失败原因是 fixture 控件条自身吞掉点击，非产品遮挡；`test:renderer:ui` 已全绿 |
| B4-F2 supervisor 余项 | 完成 | `见 status` | [b4-f2](status/b4-f2.md)：确定性启动失败改为 exit 4 且不重试；reason 接受 `remote_` 前缀，正文不落盘 |
| B4-F3 macOS 兜底收窄 | 完成 | `见 status` | [b4-f3](status/b4-f3.md)：按「身份格式能否比较」判定，可比较差异直接接管；旧格式仍拒绝 |
| B4-D 设计补全 | 完成（含 D1–D4 补审） | `见 status` | [b4-d](status/b4-d.md)：P3 §13 移到 [P3-batch4-design](P3-batch4-design.md)；矩阵 119 channel：main 24 / split 3 / forward 39 / new-op 53；D1 `scopes` 默认 `local`、D2 每条 forward 写明语义差异、D3 `chooseFolder`/`recentFolders` 改判 split、D4 secret 生命周期与重新入网 |
| B4-L1 本机入网与 `scope: local` | 完成 | `见 status` | [b4-l1](status/b4-l1.md)：grant 带 `scope`，local grant 只在 unix socket 传输有效；一次性 0600 secret 不按时间过期；首次入网/复用拒绝/撤销不重入均有测试 |
| B4-L2 main 侧 daemon 客户端与 supervisor | 完成 | `见 status` | [b4-l2](status/b4-l2.md)：`DaemonClient` 入网/探活/版本硬失败/撤销不重入、`ensureDaemon` 探活→接入→拉起→就绪；新 op `daemonInfo` 仅 local |
| B4-L3 run 经 daemon | 功能部分完成，等核验（G1 已修：admission 的无上限等待改为有界并带原因；首 token 仍 +41…+58 ms P50，S1 未达成） | `b0260e41` `d9f7aaed` `见 b4-l3g` | [b4-l3](status/b4-l3.md)：语义层 + 接线层 + run controls + 执行归属；M1 只重放可证明未发送的请求，M2 分类表逐条判定，M3 真实 App 端到端全绿；流式粒度已与进程内一致（20 事件/样本、间隔 152 ms）。[b4-l3g](status/b4-l3g.md)：卡死 run 未复现（300 次启动、10 s 看门狗），审计出两处 `providerStart` 之前的无上限等待并改为 20 s 有界（`run_admission_timeout` / 既有「同一会话已有一轮正在运行」），经 dispatcher 记为带原因的 `run_failed`；H1 把上限收回到只作用于启动 run（`admitRun`），会话账本、删除与 fork 恢复无上限排队；20 s 为暂定值。S1 未达成，按维护者答复转为 B4-S 前置门禁（[REVIEW-BATCH4-L3G](REVIEW-BATCH4-L3G.md)）。撤销后重连入口按维护者答复放在 B4-S 设置页 |
| B4-L4 其余能力经 daemon | 进行中（L4-0 完成） | `见 status` | [b4-l4](status/b4-l4.md)：矩阵补漏到 134 通道；开关打开时未迁移通道一律以 `daemon_capability_unavailable:<channel>` 拒绝（挂在 `registerTrustedIpcHandler`）；开关打开时 App 不再启动进程内远程宿主。能力迁移按 b4-l4「迁移顺序」进行 |
| B4-S 切换与删除 | 方案已审（一步到位，S0 进行中） | — | [P3-b4s-plan](P3-b4s-plan.md) |
| B4-V 验收 | 未开始 | — | |

## 执行顺序

1. **B4-F1 → F2 → F3**：每项先写失败测试、单独提交；每段通过门禁后更新本文件并推送。
2. **B4-D**：已完成，停在这里等维护者核验。
3. B4-L1 及之后不在本轮范围；未获核验前不开始。

## 阻塞

无。

## 已决定（维护者 2026-11-07，见 [REVIEW-BATCH4-D2](REVIEW-BATCH4-D2.md)）

| 决策 | 结论 | 落地 |
|---|---|---|
| 本机入网与 `scope: local` | 接受「同一 uid 的进程凭 `0600` secret 自证为本机设备」。secret + unix socket + 同 uid 就是证明，**不再有额外确认步骤**；无有效 local grant 期间 secret **不按时间过期**，只按「被使用」和「daemon 重启」轮换。撤销后走「重验 `daemon.lock` 身份 → SIGTERM → 重启生成新 secret → 重新入网」，不自动重入 | [§13.2](P3-batch4-design.md)、B4-L1 |
| 新 op 的远程开放 | 本批一个都不向远程开放；`scripts/daemon-ipc-remote-approvals.json` 保持空。要开具体 op 时再单独批准 | [§13.1](P3-batch4-design.md)、D1 |
| 按 grant scope 选策略 | 接受。除 `agent:start`、`agent:deleteSession` 外，扩到历史、列表、descriptors、detect：本机拿完整结果，远程拿裁剪投影。确认框仍留在 main | [§13.6](P3-batch4-design.md)、D2/G1 |
| 本机 grant 的空 cwd 会话 | 允许。`scope: local` 完全沿用当前 App 行为，包括空 cwd 会话；`scope: remote` 仍拒绝。方案 (a) 不采用：B4-S 删除进程内路径后该能力会永久消失 | 维护者 2026-11-07 答复第 3 条（[REVIEW-BATCH4-D2](REVIEW-BATCH4-D2.md)）、[REVIEW-BATCH4-L3A](REVIEW-BATCH4-L3A.md) P2；实现见 [b4-l3](status/b4-l3.md) |
| trace 推送与预算 | **S1 未达成，转为 B4-S 的前置门禁**（核验 [REVIEW-BATCH4-L3G](REVIEW-BATCH4-L3G.md)：S1 达成或维护者另有 A/B 决定之前，不得把 `SCRY_HOST_DAEMON` 改为默认打开）。预算不放宽、协议版本不动。接受 `watch` 长轮询 + `traceDelta`，P95 相对进程内 ≤ +10 ms（同机同负载、≥30 样本、同一 fake provider、串行测量并记录负载）；超预算再单独提 push op。**实测未达成**（30 样本：daemon 首 token P95 198.6 ms，进程内 120.2 ms；流式粒度已一致，20 事件/样本）。分段显示约 40 ms 是两次必要往返，其余落在首段文本的唤醒读取，F1 修复后交付尾段降到约 8 ms，剩余 +41…+58 ms 主要在 Provider 启动前的准备阶段，push 订阅（[P3e](P3e-first-token-push-proposal.md)）暂无依据；准备阶段归因与 B4-L4 并行 | [§13.4](P3-batch4-design.md)、[b4-l3 §S1](status/b4-l3.md) |

G1（5 条差异补处理方式 + 守卫断言）与 G2（secret 生命周期改口径）已按评审修正，见提交 `5f4d050f` 与本节。

## 已决定（维护者 2026-11-10，参照 t3code 的 Orchestration V2）

| 决策 | 结论 | 落地 |
|---|---|---|
| `conversation:send` | 经台账派发，run 只用会话 turn 的 `runId` 一个 id；能落盘的从落盘读取并校验，进程内交接只保留到派发为止，daemon 重启后不重建、不重发 | [P3-conversation-send](P3-conversation-send.md) |
| daemon → App 推送流 | 排在 L4 剩余各组之前做。新增的流式 op 只在本机端点、`scope: local`，不向远程开放；维护者确认这不违反“协议版本不变” | [P3f](P3f-app-event-stream.md)；E0–E3（含 E1b）见 [b4-l4-events](status/b4-l4-events.md) |
| userData 独占锁 | 现在做，只在开关打开时生效；不属于 B4-S 的删除工作 | 已实现，开关打开、关闭两侧都有（关闭侧按维护者 2026-11-11 选的 A + B）。设计见 [P3-userdata-lock](P3-userdata-lock.md) |
| S1 门禁 | 改为首 token 的绝对值上限。数值由执行方以数据提出、维护者批准；批准之前沿用现有 S1 门禁，开关仍不得默认打开 | 维护者 2026-11-12 批准，已满足（`3b04ee8`：daemon 热启动 P95 157.5 / 146.0 ms，P50 128.3 / 133.8 ms）：[P3-s1-absolute-cap](P3-s1-absolute-cap.md) |
| 两本账（远程台账、会话账本）合并 | 不在 B4 做，B4-S 之后再议 | — |
| 维护者机器上的孤儿 daemon | 维护者自行清理（进程 20198、20201，`/tmp/scry-g1-stuck-*`） | — |

## 已决定（维护者 2026-11-11，B4-L4 第一轮并行之后）

1. 开关关闭侧的 userData 锁做 A + B，已实现。合入时做了一处调整：没有任何进程持有锁、但 App 自己拿不到锁时，照常启动并记录警告，不再直接退出（见 P3-userdata-lock 末节）。
2. `workspace:openExternal`、`workspace:trash` 留在 App，已实现。
3. 终端：已实现，见 [P3-terminal](P3-terminal.md) 与 [b4-l4-terminal](status/b4-l4-terminal.md)。没有转发到设备的 `desktopWorkbench`，而是 daemon 为 App 单独开一套，跑 main 的同一份终端处理，三处语义差异因此不存在。
4. 工作台写操作走单独的 `workbench` lane，已实现。
5. `agent:recorderContentPage` 由 App 补上窗口 cwd，daemon 重新校验，已实现。
6. `agent:listCommands` 改为本机 op `providerCommands`，已实现。
7. 会话改名、置顶、存档、删除、分支走本机 op `sessionLifecycle`，已确认。

## 已决定（维护者 2026-11-11，第二轮之后）

1. `agent:addPiProfile` 在 daemon 模式下要求握手目录是 daemon 已知的项目：接受。
2. 配对设备经 daemon 宿主分支会话：先保持关闭，等 macOS 验证过本机分支再议。
3. main 的 `resolveKnownProjectDirectory` 在 daemon 模式下改为向 daemon 询问：已实现，见 [b4-l4-known-projects](status/b4-l4-known-projects.md)。
4. openExternal 在 daemon 模式下的候选项目范围变窄：接受。

## 进度（2026-11-11）

B4-L4 迁移完成：168 个特权通道全部有了去处（留在 main、本机 op、转发或拆分）。各组见 `status/b4-l4-*.md`；最后一组是 [b4-l4-pairing](status/b4-l4-pairing.md)。

## 已决定（维护者 2026-11-11，配对组之后）

1. `remote:desktop:*` 交给 daemon：已实现（本机 op `localDesktopHost`）。
2. 撤销 App 自己的本机连接：暂不提供入口。

## 已决定（维护者 2026-11-18，无界面执行端）

| 决策 | 结论 | 落地 |
|---|---|---|
| 分步做，与 P4 分开 | 第 1 步「登录时启动」：设置开关安装/卸载 launchd 或 `systemd --user` 服务，登录或重启后不开 App 也有后台服务；App 仍装在这台机器上 | [P5-headless-host](P5-headless-host.md) |
| 第 2 步：不靠执行端界面批准新设备 | 方案 a，在执行端上用命令行批准。能以同一 OS 用户登录这台机器的人，已有本机授权模型的权限（上文 2026-11-07 第一行）。方案 b（从已配对设备批准）不采用 | [P5-host-cli](P5-host-cli.md) |
| 不依赖 App 的独立安装包 | P4 之后再做；本轮只记在「不做/以后」 | [P5-host-security](P5-host-security.md) §8 |
| P4 设计评审 | 做完整设计（约 12 周，不含 S3）；`subscribe` 先作 v2 能力、真机验证后一次升 v3；立即路径 intent 与领取同事务、pending 有 TTL、派发前复核 grant；`fullfsync` 先测后定；其余按评审建议。无待决定事项 | [P4-orchestration-decisions](P4-orchestration-decisions.md) |
| 多 Agent 编排 | P4 只是 t3code Orchestration V2 核心的对应物，多 Agent 是其上的另一层。先在 P4 设计里预留钩子（只改文档，P4 不实现行为，工期不变），再仿 t3code 的编排 MCP 写草案 | [P4-orchestration-core](P4-orchestration-core.md) §2.10、[P6-multi-agent-draft](P6-multi-agent-draft.md) |
| 「第 1 步」暂不做（2026-11-19） | App 发起的 run 由 daemon 直接写记录、绕过 Hook 与命令行，暂不做；P4–P6 不改 scry 命令行、其命令与记录格式 | [P6-multi-agent-decisions](P6-multi-agent-decisions.md) D27 |
| 已知问题，未修（2026-11-19 记录） | 历史检索给 Claude 的 bearer token 经 SDK 进 `--mcp-config` 参数（`claude.ts:413-415`），本机其他用户可经 `ps` 看到；不在 P6 修，维护者 2026-11-19 决定与下一行一并修 | [P6-multi-agent-security](P6-multi-agent-security.md) §S4 |
| 已知问题，未修（2026-11-19 记录） | 范围更大：经授权的仓库/用户 MCP 配置（远程的 `headers`、stdio 的 `env`）也整段进 Provider 的命令行参数——Codex 的 `-c mcp_servers=…`（`codex.ts:148-170`、`:775`），Claude/Qoder SDK 的 `--mcp-config`。配置里若有 API key，本机其他用户可经 `ps` 看到；维护者 2026-11-19 决定优先修（P6 之外单独实施） | [P6-multi-agent-decisions](P6-multi-agent-decisions.md) §10.3 |

评审后（同日）「都按推荐」：supervisor 停止时等 daemon、远程策略随服务写入、命令行批准默认关且只能在 App 里打开、挑战认证、运行标记、通知与速率、批准方式分两次发布写进 grant。随后「都按推荐」：开关关闭时仍放行只收紧的 `cancel`、`revoke`、`desktop-off`（每次通知）；`SCRY_RUN_CONTROLS`、`SCRY_PROVIDER_MANIFEST_URL` 写进服务文件（[P5-headless-host](P5-headless-host.md) §10）。

## 需要决定

P5、P4 均无待决定事项（P4 见上表最后一行）。

B4-S 的决定见 [P3-b4s-plan](P3-b4s-plan.md) 末节。
