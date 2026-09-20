# Pi slash 命令：Scry 侧兼容范围

Scry 通过 Pi/Rotom RPC 执行命令，不嵌入终端 TUI，也不按 `/goal` 等名称硬编码插件行为。

## 已接入的路径

- 使用同一 RPC 进程的 `get_commands` 证明输入是已注册的 extension command；Skill、prompt template、未知 slash 仍走原有模型轮次路径。
- 连续 `select` / `input` / `editor` / `confirm` 使用各自 request ID 回答；取消只回答当前请求，由插件决定返回上一级还是关闭。
- `editor.prefill` 保留为可编辑初始内容；原生 multiline 回答仍受现有 100,000 字符边界约束。
- `notify` 与 `display: true` 的 custom 文本消息显示为 **Pi 命令反馈**，不冒充模型输出。
- 已观测到模型执行的命令继续等待原生 user entry 和 `agent_settled`，不以菜单关闭或 `agent_end` 提前结束。
- Pi 在 extension handler 返回后才确认 `prompt`。如果确认后没有模型事件/新增模型消息，且原生快照明确不在 streaming、compacting 或 pending message 状态，则记录“命令交互已结束；未观测到模型轮次”。插件 handler 的 `extension_error` 仍标为失败。
- 这种结果只证明 handler 的边界，不是 Goal 完成证据。撤销本次准确匹配的 provisional recorder 状态，保存 Scry 本地交互 archive，不伪造 native turn ID、token/cost 或 canonical `.scry/records` 模型轮次。Rotom 的原生会话仍按现有连接池策略复用，允许下一条输入。

## 尚不支持及升级条件

1. **动态子命令补全**：Pi 的 `get_commands` 没有暴露 `getArgumentCompletions`；Scry 目前只补全顶层命令，用户仍可手动填写参数。需上游增加参数补全 RPC 后接入，不能从描述猜测或硬编码 `resume` 等选项。
2. **任意 TUI 组件**：RPC 不执行 `ctx.ui.custom()`。插件需要提供标准对话框形式的 RPC 实现；截图中的 pi-goal 使用的 pi-tui-kit 已有该路径。
3. **脱离 handler 的延迟任务**：handler 返回、状态快照也无活动之后，扩展仍可能通过未暴露的异步任务启动模型。现有 RPC 没有“command 已排队但尚未进入 agent”证据，不能把命令结果当作此类后台任务已完成的证明。若要覆盖这类插件，需要 Pi 暴露 command-owned pending/completion 身份，再把命令与其后续模型轮次关联；不能用 sleep 或空闲超时猜测。
4. `set_editor_text` 等单向终端编辑器控制仍只保留诊断事件，不自动覆盖 Scry 当前草稿；native session 切换及多个新增 user entry 的命令不在此次已验证范围内。

## 最小回归

```sh
npm run test:unit -- src/main/providers/pi.test.ts src/main/providers/pi-lifecycle.test.ts src/main/trace-turn-progress.regression.test.ts src/shared/runtime.test.ts src/renderer/components/AskUserQuestionDialog.test.tsx
node scripts/session-capability-ui-smoke.mjs
```

RPC fixture 使用临时工作区与真实子进程，不请求模型、不使用真实凭据。Electron fixture 复用生产对话组件，通过坐标点击、焦点检查和原生文本输入验证连续菜单、prefill、取消重开及反馈显示；它不是完整 App 或真实 `/goal` 的端到端验收。

本次本地检查（macOS arm64，Node 24.18.0，App 源码 0.2.150；当前工作区含其他在途改动）：

- 9 个相关 unit 文件共 358 个测试通过，无 skip；包括上列文件、Pi environment、trace-turn-progress、user-question 和 renderer render 测试。
- 隔离 Electron 原生坐标/输入检查、`npm run typecheck`、`npm run build`、`git diff --check` 通过。
- 新增 menu-only 两个回归最初在旧实现下失败（handler 返回后未结束）。实现中持久化断言也曾发现 result 缺少 Provider 标识，已补齐；一次宿主登录 shell 超时导致 fixture 失败，随后仅隔离新命令测试的 HOME/Node/环境，没有扩大超时或删断言。renderer SSR 测试仍有既有 `useLayoutEffect` 提示。
- 未运行全量发布 gate、真实 Provider `/goal`、完整 App 重放或安装；未更改 Pi/Rotom 安装产物。
