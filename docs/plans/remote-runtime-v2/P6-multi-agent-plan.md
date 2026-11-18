# P6 · §P 性能 · §D 依赖 · §W 阶段与工期 · §T 测试（草案）

属于 [P6 草案](P6-multi-agent-draft.md)。状态：草案，未批准。行号说明见草案开头。

## P. 性能

| 项 | 规则 |
|---|---|
| 不启用委派的 run | 不开端点、不注入，首 token 路径与 P4 相同。S1 的两条上限（热启动两轮 P95 ≤ 200 ms、P50 ≤ 150 ms，[P3-s1-absolute-cap](P3-s1-absolute-cap.md)）与 P4 的「首 token 前提交合计 P95 ≤ 8 ms」照旧是门禁 |
| 启用委派的父 run | 新增：开一个 loopback 端点（同历史检索）；Provider 侧 MCP 握手；Codex 每 run 一个专用 app-server client（冷启动）；Pi 不进池。P6-0 分 Provider 测首 token，单独登记，不并入 S1，也不放宽 S1 |
| 委派本身 | 一次 P4 事务，与用户 submit 相同；子 run 首 token 前的提交次数不变（P4 plan §8.1） |
| 读工具 | 同步读 projection，同 P4 快照读法（protocol §5.2）；不读文件系统，摘要全文按需从归档分页读 |
| 等待 | 挂在 P4 订阅唤醒上，无 tick；每个端点连接数上限 8（同历史检索 `maxConnections`，`conversation-history-reader.ts:222`） |
| 级联停止 | 同一事务内按 `parent_run_id` 索引找后代（R5），深度 1 时至多一层 |
| 登记 | 端点与工具路径进 `performance-paths.json` 的 `sources`，未登记则 `performance-feedback.test.ts` 失败（同 P4 plan §8.4） |

默认关（草案 D2）的主要理由就是 Codex：今天 app-server client 按 cwd、trust、MCP 指纹复用（`codex.ts:736-748`），每 run 一份凭据会让每个启用委派的 Codex run 都冷启动。若 P6-0 证实 `thread/start` 接受线程级 MCP 配置，凭据就能随线程走，client 可复用，届时重测再议默认值。

## D. 依赖

| 依赖 | 原因 |
|---|---|
| P4-2 | 命令、回执、run 生命周期权威、派发前复核、pending TTL；P4 core §2.10 的预留列已在 P4-0 落库 |
| P4-3 | App 本机订阅：任务卡更新与 `wait` 的唤醒 |
| P4-4 | 会话 projection、谱系列（R1）、侧栏读 projection |
| P4-5a | 第二切片的 Desktop 远程与 iPhone 显示 |
| S3 | 删除进程内路径后只有 daemon 一个写者；之前 `off` 模式不提供多 Agent（R11）。P6-1 可在 S3 前开工，但只在 daemon 模式启用 |
| P5 运行标记 | 子 run 带 `SCRY_HOST_CHILD`（[P5-host-security](P5-host-security.md) §4.2）；P5 第 1 步的无人值守行为见 security §S6 |
| macOS 真机基线 | 同 P4-2（P4 plan §7） |

## W. 阶段与工期

| 段 | 内容 | 周 | 依赖 |
|---|---|---|---|
| P6-0 | 探针：Codex 线程级 MCP 配置与专用 client 的冷启动成本；Codex 是否把 `SCRY_*` 变量传给 stdio MCP；Qoder SDK 的 http 型 MCP 与请求头；OpenCode 动态 MCP 或配置里引用环境变量；各 Provider 对 MCP 工具调用的原生审批行为。Codex、Qoder 真机 | 0.5–1 | P4-2 |
| P6-1 | 核心：`task.*` 命令与事件、档位上限、限额、级联停止实装、R8 重启规则、凭据表、daemon 端点、五个第一切片工具；fake provider 集成测试 | 2 | P4-4 |
| P6-2 | 注入：Codex、Qoder；Claude 的代码路径与单测（真机 not-run）；`orchestrationTools` 能力位与 registry 拒绝（同 `types.ts:246-247`、`registry.ts:90`） | 1.5 | P6-0、P6-1 |
| P6-3 | App 界面：侧栏嵌套、任务卡、父会话里的审批与提问、只读子会话、停止文案、两个开关、含子任务用量 | 1.5 | P6-1、P4-3、P4-4 |
| **第一切片** | | **约 6（5.5–6.5）** | |
| P6-4 | 工作树隔离 | 1 | P6-3 |
| P6-5 | Desktop 远程、iPhone：显示、回答审批、停止 | 1–1.5 | P4-5a |
| P6-6 | Pi：第二个固定哈希扩展 | 0.5–1 | P6-2 |
| 以后 | 会话消息、等待与打断（约 1.5）；自动唤醒父会话（约 0.5）；有预算的上下文交接（约 1.5）；跨机委派（2+，新能力，三方同批）；定时任务（另立设计，依赖 P5）；OpenCode（视 P6-0） | — | — |

P4 的工期因预留增加约 1 天，落在 11–13 周之内，不改总估（P4 core §2.10）。

## T. 测试

| 类别 | 断言 | 级别 |
|---|---|---|
| 幂等 | 同 `clientRequestId` 同载荷：一个子会话、一个子 run、一次 Provider 调用（fake provider 计数）、同一回执；不同载荷 `command_payload_conflict`；无 id 两次得到两份；读工具不写回执、不写事件 | CI |
| 档位上限 | Provider × 父档位 × 请求档位的全矩阵：升档拒绝；继承不到时拒绝并列出可用档位；`auto_accept_edits` 与 `auto_review` 互相拒绝；`full_access` 开关关时不产生 `full_access` 子 run；父 `default` 委派 Pi 被拒 | CI |
| trust gate | 子 run 的 cwd 指纹变化 → `trust_gate_rejected`，Provider 0 次；工作树的新 cwd 先过 gate | CI |
| 派发前复核 | intent 与派发之间撤销 principal 的 grant、父 run 终态、凭据撤销、开关被关 → 子 run 失败，Provider 0 次 | CI |
| 级联 | 停止父 run：全部后代 `run.stop_requested`；存储 fence 时沿内存关系停止；父 run 正常结束或失败不级联；取消只作用于该子树 | CI |
| 重启 | 真实 daemon + SIGKILL：Agent 发起的 pending → `caller_run_gone`；已领取未派发 → `not_sent`；已派发 → `unavailable(host_restarted)`，任务 `unavailable` 而不是 `failed` | CI |
| 端点 | 错 token、错 `Host`、带 `Origin`、超大请求体、run 终态后再调 → 拒绝，库里无新行；扫描日志、事件、库文件与临时配置，找不到 token | CI |
| 限额与深度 | 超并发、总数、速率 → `limit_exceeded`（环境变量调小，记录值）；子 run 的 Provider 配置里没有 `scry_orchestrator` | CI |
| 审计与界面 | `agent:` 发起的子会话首轮不显示为用户消息；没有回答审批或提问的工具；原生审批的回答只记在父 run；子会话没有输入框 | CI（renderer UI） |
| 用量 | 子 run 用量缺失时合计为 `partial`，不显示 0；单位不合计；质量取最弱；父 run 用量不含子任务 | CI |
| Recorder 独立 | `src/core/turn-recorder` 不导入编排模块（沿用 P4 的导入测试） | CI |
| 性能 | 未启用委派时首 token 与提交合计满足 P4 门禁；启用时分 Provider 记录，计时锁下串行，记录负载 | 计时脚本 |
| 控制实验 | 去掉档位检查、去掉派发前复核、去掉 `Origin` 校验、去掉级联，各自让对应测试失败 | CI |
| 真机 | Codex、Qoder：委派、跨 Provider（Codex↔Qoder）、取消、父 run 停止级联、daemon SIGKILL 后的结局、原生审批批准委派；中文系统语言 + 中文工作区路径；记录 OS、locale、Provider 版本、是否正式包 | **L3** |
| 真机，未授权 | Claude：**not-run**（未授权真实运行，只有单测与 fake）；Pi、OpenCode：**not-run** | — |

模拟事件与调小阈值的测试只证明受控行为，不冒充真实宿主或默认阈值下的真实等待（AGENTS「验证分级」）。
