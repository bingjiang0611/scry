# 第四轮启动提示（可直接粘贴）

```
继续 scry 仓库分支 claude/sweet-ptolemy-qxysuh。

这个分支的历史已经被改写过，你本地的旧提交和远端不一样了。开工前必须执行：
git fetch origin claude/sweet-ptolemy-qxysuh
git switch claude/sweet-ptolemy-qxysuh
git reset --hard origin/claude/sweet-ptolemy-qxysuh
不要 merge 或 rebase 你本地的旧提交。如果本地有没推送的工作，先导出成补丁，再在新历史上重新应用。

审查方已把 Qoder SDK 升到 1.0.59，改成每次运行启动一个专属的 qodercli 守护进程（提交 e50d776c），目标是兼容我本机的 qodercli 1.1.86。这一轮在本机真实验证这次迁移。先读 docs/handoff/workflow-surface-2026-11-10/R4.md，再看 STATUS.md 顶部和 README.md 的必须停下的情况。

按 D1 → D2 → D3 → D4 连续完成。D1 用已登录的 CLI 1.1.86 跑真实轮次，重点是停止、两个会话并发、managed recorder 的 run ID、MCP 认证超时、App 退出后有没有残留守护进程，每条都附 ps 的前后对照。D2 测发送到第一个 token 的延迟，和 origin/main 对比。D1 全部通过才做 D3。每完成一个包就提交、写 reports/D<n>.md、更新 STATUS.md、push，不需要等我回复。

自己验证：独立 test 实例（临时 userData、临时工作区、调试端口），开 SCRY_PROVIDER_EVENT_LOG=1，用脚本扫描事件，用真实指针点击并截图，负对照要真的失败过。门禁在干净 worktree 里按 package-lock 重装依赖后跑，不要动我主检出的 node_modules，也不要停止或干扰我正在用的日常 App。

边界：不要改成 SDK 默认的共享守护进程，不改 managed recorder 的身份传递、进程登记和停止语义，不放开单任务停止。任何东西被公司安全软件、网络策略或网关拦截就停下记录，不绕过、不长时间轮询；推送如果需要绕过安全软件，也停下告诉我。仓库是公开的，不写公司内部地址、内部产品名、账号、令牌、本机用户名路径。不要删 Qoder 自己的日志文件。真实 Provider 调用已授权。不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不改测试超时，不动 feat/workflow-m0。提交身份按 CLAUDE.md。

全部结束后在 STATUS.md 顶部写「第四轮待核验」，push，然后告诉我已完成。
```
