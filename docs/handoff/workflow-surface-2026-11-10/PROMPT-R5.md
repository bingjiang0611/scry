# 第五轮启动提示（可直接粘贴）

```
继续 scry 仓库分支 claude/sweet-ptolemy-qxysuh。先执行：
git fetch origin claude/sweet-ptolemy-qxysuh
git switch claude/sweet-ptolemy-qxysuh
git reset --hard origin/claude/sweet-ptolemy-qxysuh

审查方针对第四轮的失败做了修复（提交 39e5f35e）：新会话由 Scry 预设会话 ID 并尽早采用，空的 session_id 不算 ID，守护进程启动期间点停止会立即结束。这一轮在本机已登录的 qodercli 1.1.86 上复测。先读 docs/handoff/workflow-surface-2026-11-10/R5.md，再看 STATUS.md 顶部和 README.md 的必须停下的情况。

按 E1 → E2 → E3 → E4 → E5 连续完成。E1 在三种时机各停至少 3 次，每次停完都再发一轮，并统计 native hook 帧里 session_id 的取值。E3 是采证：查清第四轮里会话 A 的守护进程为什么消失。E1 到 E4 全部通过才做 E5 里的清单修改。每完成一个包就提交、写 reports/E<n>.md、更新 STATUS.md、push，不需要等我回复。

自己验证：独立 test 实例（全新的临时 userData、临时工作区、调试端口），开 SCRY_PROVIDER_EVENT_LOG=1，用脚本扫描事件，用真实指针点击并截图。门禁在干净 worktree 里按 package-lock 重装依赖后跑，不要动我主检出的 node_modules，也不要停止或干扰我正在用的日常 App。

边界：不改 trace 恢复判据、managed recorder 的提交方式、运行登记和停止语义，不放开单任务停止，不改成 SDK 默认的共享守护进程；需要改这些就停下写证据和建议。任何东西被公司安全软件、网络策略或网关拦截就停下记录，不绕过、不长时间轮询；推送如果需要绕过安全软件，也停下告诉我。仓库是公开的，不写公司内部地址、内部产品名、账号、令牌、本机用户名路径。不删 Qoder 自己的日志文件。真实 Provider 调用已授权。不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不改测试超时，不动 feat/workflow-m0。提交身份按 CLAUDE.md。

全部结束后在 STATUS.md 顶部写「第五轮待核验」，push，然后告诉我已完成。
```
