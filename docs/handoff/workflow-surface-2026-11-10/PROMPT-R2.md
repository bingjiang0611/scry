# 第二轮启动提示（可直接粘贴）

```
继续 scry 仓库分支 claude/sweet-ptolemy-qxysuh 上的 Workflow 面板工作。先 git fetch origin 并切到这个分支，确认 HEAD 包含提交 a3c0c34e。

这一轮先不用 Claude，改用本机的 OpenCode、Codex、Qoder、Pi（profile rotom）。按顺序读 docs/handoff/workflow-surface-2026-11-10/ 下的 STATUS.md（顶部有审查方对上一轮的核验结论，先读）→ R2.md（本轮要做什么、能证明什么、不能证明什么）→ README.md（必须停下的情况，特别是新加的第 7 条）。

按 G1 → G2 → G3 → G4 → G5 连续完成。G1 最重要：用这四个 Provider 的真实运行证明 Workflow 面板不会把它们的子 Agent、后台任务或 Pi 的 workflow 误判成 Claude workflow，并且本分支的改动没有破坏它们原有的子 Agent 和后台任务显示，要和 origin/main 的 build 对照。每完成一个包就提交、写 reports/G<n>.md、更新 STATUS.md、push。不需要等我回复。

你要自己验证：起独立 test 实例（临时 userData、临时工作区、调试端口），开 SCRY_PROVIDER_EVENT_LOG=1 抓原始事件，用脚本扫描事件而不是肉眼看，用真实指针点击并截图。负对照要真的失败过。不要停止或干扰我正在用的日常 App。

边界：
- 任何 CLI 被公司终端安全软件、网络策略或网关拦截，就停下记录、标阻塞、继续下一个 Provider。不要用包装脚本、改名或换启动方式绕过，不要长时间轮询。
- 仓库是公开的。不要把公司内部地址、内部产品名、账号、令牌写进任何提交。
- 不要为了让面板在其他 Provider 上有内容去适配它们，G5 只写设计说明。
- 真实 Provider 调用已授权，预算不是约束。不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不安装到 /Applications，不动 feat/workflow-m0。不改测试超时、不放宽门禁。提交身份按 CLAUDE.md。

全部结束后在 STATUS.md 顶部写「第二轮待核验」，push，然后告诉我已完成。
```
