# P6 · §P 性能 · §D 依赖 · §W 阶段与工期 · §T 测试（草案）

> **暂停（维护者 2026-11-23）**：先完成 [V2 对齐](V2-alignment.md)（任务单 W20），再按其 §E 更新依赖后恢复。

属于 [P6 草案](P6-multi-agent-draft.md)。状态：草案，未批准；评审后修订 2026-11-19。行号说明见草案开头。

## P. 性能

| 项 | 规则 |
|---|---|
| 不启用委派的 run | 不注入，首 token 路径与 P4 相同。S1 的两条上限（热启动两轮 P95 ≤ 200 ms、P50 ≤ 150 ms，[P3-s1-absolute-cap](P3-s1-absolute-cap.md)）与 P4 的「首 token 前提交合计 P95 ≤ 8 ms」照旧是门禁 |
| 启用委派的父 run | Claude、Qoder：进程内 MCP 的握手，无端口；Codex：共用端点已在，线程级请求头若成立则复用池化 client（今天按 cwd、trust、MCP 指纹复用，`codex.ts:736-748`），不再冷启动。P6-0 分 Provider 测首 token，单独登记，不并入也不放宽 S1 |
| 委派 | 两次 P4 事务（请求与确认后创建），与用户 submit 同类；子 run 首 token 前的提交次数不变（P4 plan §8.1）。确认等待的是用户，不计入首 token |
| 读工具 | 同步读 `orch_p_task`，同 P4 快照读法（protocol §5.2）；不读文件系统，全文按需从归档分页读；按 run 限速 |
| 等待 | 按 `stateVersion` 边沿触发，挂在 P4 订阅唤醒上，无 tick；Codex 端点连接数上限 8（同 `conversation-history-reader.ts:222`） |
| 级联停止 | 同一事务按 `parent_run_id` 索引找子 run；深度 1 时至多一层 |
| 登记 | 编排服务与工具路径进 `performance-paths.json` 的 `sources`，未登记则 `performance-feedback.test.ts` 失败（同 P4 plan §8.4） |

默认关（D2）的理由从「Codex 失去 client 复用」变为「每个父 run 多一个 MCP 服务、多一道确认」；若 P6-0 证实线程级请求头，Codex 的复用不再受影响。

## D. 依赖

| 依赖 | 原因 |
|---|---|
| P4 全部完成（P4-0 到 P4-6） | 命令、回执、run 生命周期权威、派发前复核、本机订阅、会话 projection、谱系列；P4 core §2.10 的预留已在 P4-0 落库 |
| S3 | P4 要求它先于删除 `off` 路径；P6 在 P4 之后开工，因此也在 S3 之后。之前 `off` 模式不提供多 Agent（R11） |
| P4-5a | 第二切片的 Desktop 远程与 iPhone 显示（P4 完成时已具备） |
| P5 运行标记 | 子 run 带 `SCRY_HOST_CHILD`（[P5-host-security](P5-host-security.md) §4.2） |
| macOS 真机基线 | 同 P4-2（P4 plan §7） |

首稿「P6-1 可在 S3 前开工」作废：维护者 2026-11-19 定工期「在 P4（及 S3）之后」（D26）。

## W. 阶段与工期

### W1. P6-0 探针（Codex、Qoder 真机）

| # | 探针 | 决定什么 |
|---|---|---|
| 1 | Codex `thread/start` 的线程级 MCP 配置与请求头，在 `--strict-config`（`codex.ts:751-758`）下是否被接受；随之的 client 复用与冷启动 | Codex 是否 available |
| 2 | Claude、Qoder 的 SDK 进程内 MCP（`type: 'sdk'`）真机可用，且不进 `--mcp-config` | Claude、Qoder 的通道 |
| 3 | Codex 对 MCP 工具调用的原生审批路径与注解（只读提示是否生效） | adapter 如何放行读工具（security §S6） |
| 4 | Codex 是否把含 `TOKEN` 的环境变量传给 Agent 执行的命令 | 记录今天历史检索的暴露面 |
| 5 | Codex 沙箱下 app-server 到 loopback 端点的连通 | 端点可用性 |
| 6 | Codex code mode 在 Scry 的配置下是否默认开启 | 是否把等待与委派登记为直接调用（L7） |
| 7 | 仓库项目设置能否预先放行 `mcp__scry_orchestrator__*`；扩展指纹要含哪些文件 | security §S3 的文件清单 |
| 8 | Provider 原生子 Agent 是否继承父 run 的编排工具 | 是否要在注入时排除，归属如何记 |
| 9 | MCP 客户端超时与等待的关系：Qoder `controlRequestTimeoutMs: 30_000`（`qoder-launch.ts:175`）、Codex `tool_timeout_sec`、Claude SDK 的工具超时 | 20 s 等待上限是否安全 |
| 10 | Pi 是否有不经 argv 与环境变量的凭据通道；OpenCode 动态 MCP（低优先） | D12 |

### W2. 阶段

| 段 | 内容 | 周 | 依赖 |
|---|---|---|---|
| P6-0 | W1 的十项 | 1.5–2 | P4 完成 |
| P6-1 | 核心：`task.*` 命令与事件、`orch_p_task`、Scry 确认、两个开关的 peer-only 命令、同 Provider 档位上限、限额与读工具限速、边沿触发等待、级联与会话级停止、L4 作废、R8 重启、Agent 基线与扩展指纹、决策器的子会话只读；fake provider 集成测试 | 3 | P6-0 |
| P6-2 | 注入：Claude、Qoder 进程内 MCP；Codex 端点与线程级请求头；adapter 放行读工具；`orchestrationTools` 能力位与 registry 拒绝；连接失败降级；code mode 直接登记 | 2–2.5 | P6-0、P6-1 |
| P6-3 | App 界面：侧栏嵌套、任务卡、确认卡、父会话里的审批与提问、只读子会话、停止与「停止全部子任务」、两个开关与 main 原生确认、用量并列、首轮统计的关联 | 2 | P6-1 |
| P6-V | 真机 L3（Codex、Qoder）、性能登记与测量、控制实验 | 0.5–1 | P6-2、P6-3 |
| **第一切片** | | **9–11** | |
| P6-4 | 工作树隔离 | 1 | 第一切片 |
| P6-5 | Desktop 远程、iPhone：显示、回答审批与确认、停止 | 1–1.5 | 第一切片 |
| P6-6 | Pi（视 P6-0） | 0.5–1 | P6-2 |
| 以后 | 跨 Provider（先做效果表）；会话消息、等待与打断；自动唤醒；有预算的上下文交接；跨机委派；定时任务；OpenCode | — | — |

**为什么从约 6 周变成 9–11 周。** 首稿 5.5–6.5 周。增加的：P6-0 从五项一台机器的核对变成十项两台真机，+1；P6-1 多了 Scry 确认、开关命令、Agent 基线与扩展指纹、任务 projection、边沿触发等待与限速、会话级停止，+1；P6-2 从照搬历史检索的一种通道变成两种新通道、外加逐 Provider 放行读工具，+0.5–1；P6-3 多确认卡与原生确认，+0.5；首稿把真机与性能分摊在各段里，这里单列 P6-V，+0.5–1。合计 9–10.5；上沿取 11，留给探针结果不理想时的返工。

P4 的工期不变：预留改动（删 R6、加 R12 与复核行）仍在约 +1 天之内（P4 core §2.10）。

## T. 测试

| 类别 | 断言 | 级别 |
|---|---|---|
| 幂等 | 委派缺 `clientRequestId` → `invalid_request`；同 run 同 id 同载荷：一个任务、一次 Provider 调用（fake 计数）、同一回执；不同载荷 `command_payload_conflict`；下一 run 用同一 id 得到新任务；读工具不写回执与事件 | CI |
| 档位上限 | 同 Provider 内 Provider × 父档位 × 请求档位全矩阵：升档拒绝；Claude/Qoder 中间两档互拒；Codex 全序；不隐式降档；开关关时无 `full_access` 子 run；跨 Provider 目标被拒 | CI |
| Scry 确认 | 写工具返回 `awaiting_confirmation`，确认前 Provider 0 次；`agent:` 回答被拒；`full_access` 父 run 也要确认；拒绝 → `declined`；原生「本会话允许」与项目设置预放行都绕不过；读工具不触发原生审批 | CI |
| trust 与基线 | 没有用户 run 的基线 → 子 run `trust_gate_rejected`，Provider 0 次；父 Agent 改 Hook、MCP 或项目设置后委派被拒；`scry init` 后被拒、用户运行一次后恢复；用户 run 不受影响；daemon 重启后基线为空 | CI |
| 凭据 | 扫描 Provider 进程的 argv（`/proc/<pid>/cmdline`）与环境、日志、事件、库、临时配置：找不到凭据；Codex 端点错 token、错 `Host`、带 `Origin`、超大请求体、run 终态后再调 → 拒绝且无新行 | CI（Linux） |
| 开关 | 远程 grant 与 `agent:` 改开关被拒；开关在 intent 与派发之间被关 → 子 run 失败 | CI |
| 停止 | 调用方 run 已请求停止 → `caller_not_active`（决策与复核各一次）；会话级停止只接受 peer；父 run 行裁剪后级联仍生效；Codex 子 run 只收到 `interrupt`、共享 client 未关闭；父 run 正常结束时未派发与等确认的作废 | CI |
| 等待 | 无变化时等到 20 s；`sinceVersion` 之后的变化立即返回；待答 interaction 不让等待空转；读工具超速 `limit_exceeded`；等用户超时 → `unavailable(interaction_timeout)`（环境变量调小，记录值） | CI |
| 重启 | 真实 daemon + SIGKILL：等确认 → `cancelled(caller_run_gone)`；Agent 发起的 pending → `caller_run_gone`；已派发 → `unavailable(host_restarted)` | CI |
| 只读子会话 | 决策器拒绝对 `delegated` 会话的 peer 发送，旧客户端同样被拒 | CI |
| 降级 | 编排服务连接失败：父 run 继续，工具与界面显示 unavailable | CI |
| 证据与用量 | 摘要继承归档标记；空的最后消息 → `unavailable`；用量按质量并列、单位不合计、缺失为 `partial`；子会话首轮不计入用户轮次；同一工作区并行写 → 归属 `partial`/`inferred` | CI |
| 独立与不变 | `src/core/turn-recorder` 不导入编排模块；scry 命令行的命令表与记录格式的契约测试不变（D27） | CI |
| 性能 | 未启用委派时满足 P4 门禁；启用时分 Provider 记录，计时锁下串行，记录负载 | 计时脚本 |
| 控制实验 | 去掉档位检查、确认、Agent 基线、`Origin` 校验、级联，各自让对应测试失败 | CI |
| 真机 | Codex、Qoder：委派与确认、取消、父 run 停止级联、会话级停止、SIGKILL 后的结局；中文系统语言 + 中文工作区路径；记录 OS、locale、Provider 版本、是否正式包 | **L3** |
| 真机，未授权 | Claude、Pi、OpenCode：**not-run** | — |

模拟事件与调小阈值的测试只证明受控行为，不冒充真实宿主或默认阈值下的真实等待（AGENTS「验证分级」）。
