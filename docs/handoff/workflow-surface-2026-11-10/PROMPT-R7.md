# 第七轮启动提示（可直接粘贴）

```
继续 scry 仓库分支 claude/sweet-ptolemy-qxysuh。先执行：
git fetch origin claude/sweet-ptolemy-qxysuh
git switch claude/sweet-ptolemy-qxysuh
git reset --hard origin/claude/sweet-ptolemy-qxysuh

审查方按第六轮证据修了三处（cc75676b、fda34e0e、0f95dddf）：
- 审批标题超过 120 字符时截断，完整命令放进「允许一次」的说明。旧 E4 的 invalid canonical record 就是标题超长造成的。
- 新对话里的 /plugins reload 不再报告会话 ID，下一轮不会再去 resume 一个不存在的会话。
- CLI 日志与 SDK 各报半次的 hook 运行合并为一次。
先读 docs/handoff/workflow-surface-2026-11-10/R7.md，再看 STATUS.md 顶部和 README.md 里必须停下的情况。

按 G0 → G1 → G2 → G3 → G4 → G5 连续完成。
- G0：只读核对旧备份里 hook 不成对的来源。
- G2：启动窗口按 R7 的新可观测标准做 3 次。
- G4：分支和后台 Agent 只采证，不修。
- G5：满足 R7 写的前提才改兼容性清单。
CLI 用本机实际安装的版本，每份报告写明版本，不改全局安装。每完成一个包就提交、写 reports/G<n>.md、更新 STATUS.md、push，不需要等我回复。

自己验证：独立 test 实例（全新的临时 userData、临时工作区、调试端口），开 SCRY_PROVIDER_EVENT_LOG=1，用脚本扫描事件，用真实指针点击并截图。门禁在干净 worktree 里按 package-lock 重装依赖后跑，不要动我主检出的 node_modules，也不要停止或干扰我正在用的日常 App。第六轮留下的旧 E4 recorder 进程（PID 20739）属于测试现场，确认它的命令行属于该现场后可以结束。

边界：不改产品代码，包括 recorder、trace 恢复判据、运行登记和停止语义，不改成 SDK 默认的共享守护进程。审批表单看不到完整命令，或 recorder 写入了不该提交的轮次，就立即停下并保留现场。任何东西被公司安全软件、网络策略或网关拦截就停下记录，不绕过、不长时间轮询；推送如果需要绕过安全软件，也停下告诉我。仓库是公开的，不写公司内部地址、内部产品名、账号、令牌、本机用户名路径，记录内容只交结构不交原文。不删 Qoder 自己的日志文件。真实 Provider 调用已授权。不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不改测试超时，不动 feat/workflow-m0。提交身份按 CLAUDE.md。

全部结束后在 STATUS.md 顶部写「第七轮待核验」，push，然后告诉我已完成。
```
