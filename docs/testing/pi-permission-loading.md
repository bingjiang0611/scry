# Pi 权限目录加载期间误发送

## 证据与根因

截图对应 `run-muan2ah0-32` 的本地 trace archive 中，`runtime:controls.input.permissionMode` 为 `default`；随后 Pi adapter 在 frontdoor 拒绝运行。此次没有启动 Pi 模型调用。截图显示的“本机完全访问”不是这次请求的权限证据。

`useIntegrations` 在没有当前上下文的目录缓存时，用默认目录显示加载状态。即便偏好已保存 `full_access`，此时临时 selection 也会变成 `default`，待目录返回才恢复。原先 `runControlSendBlockedReason` 对所有 Provider 放行加载中的默认模型/权限，遗漏了 Pi 没有默认审批模式的差异。

修复让发送门禁接收当前 Provider 身份，仅对 Pi 关闭这条加载期快捷路径。不修改 adapter、不自动提升权限、不改变其他 Provider 的默认发送路径。

## 回归场景

现有隔离 Electron runner 加载生产 `App`，使用受控 bridge 延迟权限目录返回，不启动真实 Provider、不写真实工作区或 userData：

- 首次 Pi 使用：目录 pending 时按钮禁用、原生 Enter 不触发 `start`，草稿保留；目录返回后仍需显式选择“本机完全访问”。
- 已保存 Pi 完全访问：目录 pending 时同样阻止发送；返回后恢复保存的权限，原生 Enter 提交 `full_access`。
- 两条路径都核对 `start` 的 Provider、Profile、prompt 和权限参数。
- 单元测试另覆盖 Claude/Codex/Qoder/OpenCode 的默认加载期快捷路径，以及 Pi 不自动提权。

## 本次验证

- 新单元用例在旧判断下失败：Pi/default 得到 `null` 而非阻止原因；修复后通过。
- `npm run test:unit -- src/renderer/hooks/useIntegrations.test.ts src/main/providers/registry.test.ts src/main/providers/pi.test.ts src/renderer/hooks/useAgentSession.test.ts`：133 tests passed。
- `node scripts/session-capability-ui-smoke.mjs`：首次 fixture 误等 `role=alert` 超时；检查生产 Enter handler 后确认其直接阻止发送、不会调用 App 生成 alert。改为等待原生 keyup receipt，再核对零请求和草稿；fresh/saved 两场景通过，未扩大超时。
- `npm run typecheck`、`npm run build`、`git diff --check` 通过。

测试在含其他并行 WIP 的工作区运行；只提交本任务改动。隔离 App renderer 测试不等于真实 Pi 端到端验收。本次未重新发送用户原始任务、未安装/重启用户正在运行的 App；截图中的 Git diff timeout 是独立观测失败，本修复不声称解决它。
