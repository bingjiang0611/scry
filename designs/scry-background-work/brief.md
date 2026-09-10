# Scry Qoder 后台任务 · 2026-09-10

## D-20260910-qoder-background-work

- Scope / status：Scry 项目；需求已确认，成品待用户验收。
- Feedback：用户报告会话停在 Obsidian 日志追加后超过 11 小时，指出“这是明显的设计缺陷”，随后要求“完整解决”。15 分钟自动取消只是兜底，不是原生任务体验。
- 目标：区分模型正在生成、模型已回复但等待后台任务、长时间未收到事件、用户请求停止、Provider 真正返回终态。静默不等于失败，更不是自动重试写操作的理由。
- 保留：run/session 所有权、消息排队、Qoder 后台通知后的续跑、已有整轮停止升级、权限提问、renderer 隔离。不会把未结束的 run 提前归档为成功，不覆盖 composer 的既有 WIP。
- 路径：用户明确授权局部修复，采用已有状态条和工具卡模式，不另做视觉重设计。查库“ Scry 后台任务 状态”无现成命中；原始截图为本轮问题基线，不收录私人截图。

## 实现与证据边界

- `src/shared/background-work.ts`：可持久的 typed 观测快照，经 TraceEvent 传递；任务集合是 partial，不是 Provider 完整任务清单。任务时间是回执观测时间，非进程启动时间。
- `src/main/providers/qoder-background-work.ts`：15 分钟无新执行事件只显示 quiet，不取消、不释放 stdin、不结束 run。收到进展恢复；权限提问暂停静默计时。模型 end_turn 与最终 Provider result 分开处理。
- `src/main/providers/qoder-task-control.ts`：使用 SDK 公开 Transport 扩展，封装唯一的 `stop_task` 请求，不调用 Query 私有接口。仅放行 init 报告为 `1.1.45` 的 CLI；新版本须复验，不能猜能力相同。
- `src/main/background-task-control.ts`：trusted IPC 后再次验证活动 Qoder run 与已观测任务归属。没有 PID、任意命令、cwd 或私有 URL 入参。
- 停止回执只是 requested；10 秒无回执为 unknown，禁止自动重发。Provider 的任务终态才移除任务；后续 root result 才允许原有 run 收口。
- `BackgroundWorkPanel.tsx` / `ChatTurn.tsx` / `ChatView.tsx`：任务列表、停止任务、停止本轮，等待时取消生成骨架与游标；quiet 明示状态待确认和写入可能已发生。已结束/存档轮次不出现可用停止控件。
- Sidebar 使用同一快照的全局广播及 activeRuns 恢复，不以最后一条聊天文案推断状态；保留正在生成的普通 run 标识。

## 验证入口与验收

- focused tests：Qoder adapter、消息关联、background monitor、真实 SDK + 合成 transport wire、单任务 IPC 授权、preload allowlist、renderer 状态投影。
- `npm run test:background-ui`：生产 React/CSS 在隔离 sandboxed Electron 中重放 1100px 与 640px，涵盖等待无骨架、停止回执不算终态、目标任务隔离、quiet、续跑、归档、下一轮及未知版本降级。使用合成事件，没有真实 Provider、笔记写入或私人数据。
- 上一轮实现（`6f02d9d`）已执行：`npm test` 1855 通过 / 3 外部用例跳过（含 shell 测试）；`npm run typecheck`、`npm run build`、`npm run test:background-ui`、`npm run check:cli-release`、`npm run pack:artifact` 均通过。packaged App 的 preload、安全边界与原有交互 smoke 通过；产物未安装/发布，用户 WIP 未作为本次提交内容。
- 外部边界：上述自动化不等于真实 Qoder 服务/真实 Obsidian 的新版端到端验收；单任务控制线依赖已核对的 CLI 1.1.45 源码与 SDK wire 合同，真实外部重放仍须单列。
- Revisit：Qoder CLI/SDK 版本变化、任务事件合同变化、增加 Provider 时复核；不升级为全局审美偏好。

## 周边生命周期回归 · 2026-09-10

- 心跳/空 stream envelope 不再刷新 quiet 时钟；审批结束只恢复计时，不伪造 Provider 的 `lastEventAt`；迟到的 assistant 不复活 inactive 状态。
- stdin EOF、reader 结束和 close 撤销单任务能力并结算未确认请求；缺失版本的新 init 清除旧能力；异常回执归为 unknown，而非可重试的 rejected。
- Agent 使用同一终态归一规则处理 `error/cancelled/canceled/interrupted/killed`，并按已知 toolUseId 收敛多个 task-ID 别名和无 taskId 的直接终态，避免 Agent 卡片已结束但后台注册表仍阻止 stdin 收口。
- 原生进程日志中的关联终态参与最终快照收敛；主机取消请求/流丢失生成的兜底事件不能冒充任务终态。仍未确认的任务在最终快照中保留 `status: unconfirmed`，不误报停止或清空。
- Bash 任务未获终态而 transport 已结束时，本轮报运行失败并明确“任务完成情况未知、先核验文件”，不沿用此前的 provisional success，也不自动重试写入。
- 已结束 run 的 tombstone 不再被迟到 session/focus 通知删除。trace 恢复保留已收到的终态、错误和 native turn ID；拒绝过期、逆序和跨焦点恢复，且不发送虚假的恢复确认。
- background 快照增加每轮单调 revision（兼容旧归档）；局部 trace 裁剪/合并和侧栏恢复不再让旧快照覆盖新状态，包括 inactive 后的迟到事件。
- 回归：新增 **24 个单元用例**；最终 focused **226 通过**，`npm test` **1880 通过 / 3 外部用例跳过**，shell、typecheck、build、diff check 通过。
- `npm run test:background-ui` 保留宽/窄交互，并新增 **7 条实际挂载 hook 的 Electron 时序场景**：done/error 与恢复竞态、逆序恢复、切换焦点、侧栏 done/error/增量与迟到 hydration。入口新增 `scripts/fixtures/background-recovery-smoke.tsx`；这不是完整 App 的真实 Provider 验收。
- 本轮未改 preload、IPC 入参或 packaging，未重新打包/安装；先前打包结果不作为本轮产物验证。没有重放真实 Qoder/Obsidian 写入，也没有重启仍在运行的旧预览，避免中断未知的活动会话。
