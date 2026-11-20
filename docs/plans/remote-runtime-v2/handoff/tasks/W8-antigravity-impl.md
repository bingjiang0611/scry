# W8 · Antigravity Provider 实现（A0.5–A7）与 macOS 真机验收（A9）

执行方 B。设计已定稿：[P7-antigravity-provider](../../P7-antigravity-provider.md)、[-integration](../../P7-antigravity-integration.md)、[-plan](../../P7-antigravity-plan.md)（§7 拆分、§9.1 已定）；评审 [reports/P7-design-review.md](../reports/P7-design-review.md)；探测结论 [reports/W7.md](../reports/W7.md) 与 [W7-review](../reports/W7-review.md)。**按设计实现，不重新设计**；有歧义选更保守的做法并写进报告。

## 维护者要求（2026-11-19/20）

- 体验与 Codex、Qoder 一致：终端里能用的 `agy`，Scry 里就要能用；Scry 不做登录，用 CLI 已有登录态（不调 OAuth `authenticate`、不弹浏览器）。
- 可选权限：`default`、`auto_accept_edits`（`accept-edits`）、`full_access`（`--dangerously-skip-permissions`，用 Antigravity 专属文案说明真实效果）；`auto` 暂不映射；`plan` 按设计。用户级设置会绕过审批：有效权限高于所选档位或远程上限时拒绝启动并说明。
- 实验开关：`SCRY_EXPERIMENTAL_PROVIDERS=antigravity` 未设置时不注册、不探测、不出现在远程 discovery；真机验收通过前保持默认隐藏。
- 真实 `agy` 运行已授权。

## 范围与顺序

| 段 | 内容 |
|---|---|
| A0.5 | 预拆接近或超过 20,000 字节的旧文件，零行为变化，单独提交（清单见 plan §7；`host-process.ts` 已由执行方 C 拆分，不要再碰它与编排模块） |
| A1 | Provider 枚举与各处列表、`mcp-config.ts` 显式分支、实验开关与 `LOGIN_START_POLICY_ENV_KEYS`、`run-stop-lifecycle.ts` 窗口。**单独小提交、尽快推送**，减少与他人冲突 |
| A2–A6 | ACP 客户端与假 Agent 夹具；启动与清洗（去 `SSH_*`、`BROWSER` 退出 0、独立进程组后代清理）；运行、事件、审批、用量（费用缺失记未知不记 0）；目录与思考档；配置门禁（4 别名目录、cwd 至 git 根、插件、用户级权限键）与 run 级历史检索 MCP（轮末撤销 token） |
| A7 | 界面显示名与中性字母图标、MCP 面板来源、兼容性清单、`error-classify` 按 Provider、`GLOSSARY.md` |
| A9 | macOS 后台服务模式真机验收（plan §6.2 清单，含手机远程若 iPhone 已就绪）；Linux 标 not-run |
| A8 | 输入回执与 `historicalContext`：本轮不做，写明延后 |

## 验收与自验

- 每段先写失败测试（假 ACP Agent 覆盖：重复、乱序、部分、取消、未知事件、未登录信号、argv 记录器、`protocolVersion` 形状、取消时未决审批、尾随更新、stderr 中的登录链接不落日志）。
- 每段 `npx tsc --noEmit`（node 与 web）、受影响测试、`node scripts/check-staged-file-size.mjs`；改到 `scripts/performance-paths.json` 里的源文件时跑 `npm run performance:measure -- --compare <基线>` 并解释变差行；`npm run check:cli-runtime` 证明没碰 scry CLI。
- A9 真机：发送、流式、工具、审批（允许一次、拒绝）、提问、停止（含命令子进程）、恢复、模型与思考档、三档权限的真实效果、用户级权限设置导致的拒绝、MCP 注入与 `ps` 零泄露、中文路径、后台服务由 launchd 拉起时的登录态。

## 约束

不碰 `src/daemon/host-process.ts`、`host-process-assembly.ts` 与 `src/host-runtime/orchestration/`；不改 scry CLI、协议版本与性能门限；不改 `~/.gemini` 配置与登录项；遵守测量互斥规则；不碰日常 App、`com.scry.daemon`。

每完成一段就提交并推送；报告写 `reports/W8.md`（第一行写状态）。全部能做的做完或只剩需要维护者决定的事项时停下总结。
