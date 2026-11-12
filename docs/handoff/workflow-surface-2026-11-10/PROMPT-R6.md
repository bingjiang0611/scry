# 第六轮启动提示（可直接粘贴）

```
继续 scry 仓库分支 claude/sweet-ptolemy-qxysuh。先执行：
git fetch origin claude/sweet-ptolemy-qxysuh
git switch claude/sweet-ptolemy-qxysuh
git reset --hard origin/claude/sweet-ptolemy-qxysuh

审查方按维护者授权修了 managed recorder（提交 a99c2fa1、b25573e7、5d2d7f6e、f87c91b9）：/plugins reload 作为命令型轮次，不进 .scry/records；只跑过会话级 hook 就停止时，按观测到的中断落盘；invalid canonical record 现在会报出字段路径，但这个问题本身还没修。先读 docs/handoff/workflow-surface-2026-11-10/R6.md，再看 STATUS.md 顶部和 README.md 里必须停下的情况。

按 F0 → F1 → F2 → F3 → F4 连续完成。
- F0：第五轮 E1 hook-1 和 E4 的临时目录如果还在，先整个备份，再在原路径上用新构建启动，看恢复结果：hook-1 应该提交，E4 应该报出字段路径。
- F2：三种时机各停至少 3 次，“输出中途”这次必须做到。
- F3：如果出现 invalid canonical record，只导出被点名段的结构（键、类型、取值类别、长度），不导出原文。
- F4：F1 到 F3 全部通过才改兼容性清单。
每完成一个包就提交、写 reports/F<n>.md、更新 STATUS.md、push，不需要等我回复。

自己验证：独立 test 实例（全新的临时 userData、临时工作区、调试端口），开 SCRY_PROVIDER_EVENT_LOG=1，用脚本扫描事件，用真实指针点击并截图。门禁在干净 worktree 里按 package-lock 重装依赖后跑，不要动我主检出的 node_modules，也不要停止或干扰我正在用的日常 App。

边界：不改产品代码，包括 recorder、trace 恢复判据、运行登记和停止语义，不改成 SDK 默认的共享守护进程；查到 invalid record 的字段就写证据，然后继续其余包。recorder 把不该提交的轮次写进了 .scry/records 就立即停下，保留现场。任何东西被公司安全软件、网络策略或网关拦截就停下记录，不绕过、不长时间轮询；推送如果需要绕过安全软件，也停下告诉我。仓库是公开的，不写公司内部地址、内部产品名、账号、令牌、本机用户名路径。不删 Qoder 自己的日志文件。真实 Provider 调用已授权。不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不改测试超时，不动 feat/workflow-m0。提交身份按 CLAUDE.md。

全部结束后在 STATUS.md 顶部写「第六轮待核验」，push，然后告诉我已完成。
```
