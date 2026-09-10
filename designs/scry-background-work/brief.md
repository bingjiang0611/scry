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
- 已执行：`npm test` 1855 通过 / 3 外部用例跳过（含 shell 测试）；`npm run typecheck`、`npm run build`、`npm run test:background-ui`、`npm run check:cli-release`、`npm run pack:artifact` 均通过。packaged App 的 preload、安全边界与原有交互 smoke 通过；产物未安装/发布，用户 WIP 未作为本次提交内容。
- 外部边界：上述自动化不等于真实 Qoder 服务/真实 Obsidian 的新版端到端验收；单任务控制线依赖已核对的 CLI 1.1.45 源码与 SDK wire 合同，真实外部重放仍须单列。
- Revisit：Qoder CLI/SDK 版本变化、任务事件合同变化、增加 Provider 时复核；不升级为全局审美偏好。
