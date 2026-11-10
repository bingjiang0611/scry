# 第二轮总结（不用 Claude）

第二轮的目标不是补齐 Claude 的真实运行态，而是先用本机能跑的其他 Provider 证明：Workflow 面板不会把它们的子 Agent、后台任务或 Pi 的 workflow 误判成 Claude workflow，并且本分支的改动没有破坏它们原有的显示。

## 一句话结论

Codex、Pi（原生）、OpenCode 在本机的真实轮次里，Workflow 面板都是空态，canonical 流里 `workflow_activity` 为 0；`origin/main` 的对照没有差异。Qoder 与 Pi `rotom` 在本机跑不起来，各有可归因证据并标为阻塞。

## 逐包

| 包 | 结果 | 关键证据 |
|---|---|---|
| G1 | 完成（两处阻塞） | Codex 两个子 Agent：分支与 `origin/main` 的 Agents 结果逐项一致，`workflow_activity` 0；Pi 原生一轮空态；OpenCode 换到支持范围内的 1.18.31 后跑通一轮，空态正确。Qoder `exit 42`（分支与 main 同，仓库外同 SDK 复现）、本机 OpenCode 2.2.6 `POST /session 405`、Pi rotom 缺 `model-catalog.mjs` |
| G2 | 完成 | `test:workflow-ui` 新增 `focus` 模式（两个 run、卡片入口、手动换、再来一帧流式更新），两个宽度通过；删掉清空请求那一行后真的失败 |
| G3 | 完成（两处环境失败） | `typecheck`/`build`/`test:workflow-ui`/`test:workflow-archive`/`test:renderer:ui` 全 0；`pack:artifact` 在 `origin/main` 上同样失败；`test:unit` 7 个失败全是压力下 spawn 超时，两个文件单独跑通过 |
| G4 | 部分完成 | 同实例切换 Codex / OpenCode 会话，Workflow 标签一直开着：无残留、Agents 按会话分开、切回恢复。带真实 workflow 行的会话造不出来（Claude 阻塞） |
| G5 | 完成（仅设计） | Pi `kind: workflow`：有运行、步骤、终态、活动，**没有阶段、没有每 agent 用量**；Qoder 连真实事件都没有，不能开工 |

## 这一轮明确没有做

- 没有为其他 Provider 适配面板（G5 只写设计）。
- 没有用 shim、改名、换启动方式绕过被拦截的 CLI。OpenCode 的 1.18.31 是仓库自己声明的支持版本，用 Scry 自己的 `SCRY_OPENCODE_PATH` 指过去，启动方式不变。
- 没有读或改维护者日常 App 里的 Claude 历史会话。
- 没有改测试超时、没有放宽门禁、没有动 `performance-ratchet.json`。

## 仍然阻塞

| 项 | 原因 | 解除条件 |
|---|---|---|
| Claude workflow 真实运行态（第一轮 B、C 的运行态截图、E2） | 公司网关持续 429/400（见第一轮 B 报告） | 网关恢复或有可用凭据 |
| Qoder 真实事件 | SDK 流模式 `exit code 42`，仓库外同 SDK 复现 | Qoder CLI/SDK 版本对齐，或企业策略允许 |
| 本机 OpenCode 2.2.6 | 服务端 API 变化，`POST /session` 405 | 升级 Scry 的 OpenCode 适配或降级 CLI |
| Pi rotom 的 `kind: workflow` | 安装里 qoder 扩展缺 `model-catalog.mjs`，RPC 起不来 | 修 rotom 打包后重装 |
| G4 的运行态残留 | 需要一个带真实 workflow 行的会话 | Claude 恢复，或测试实例支持「只信任 fixture 会话」 |

## 本轮新增的可执行检查

- `npm run test:workflow-ui` 的 `focus` 模式（G2），有负对照。
- `src/main/normalize-workflow.test.ts` 与 `src/renderer/workflow-runs.test.ts` 各一条「其他 Provider 的后台 Agent 事件不进 workflow」用例（G3 前提），有负对照。
