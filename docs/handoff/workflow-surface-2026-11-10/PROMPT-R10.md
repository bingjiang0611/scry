# 第十轮启动提示（可直接粘贴）

```
继续 scry 仓库分支 claude/sweet-ptolemy-qxysuh。先执行：
git fetch origin claude/sweet-ptolemy-qxysuh
git switch claude/sweet-ptolemy-qxysuh
git reset --hard origin/claude/sweet-ptolemy-qxysuh

审查方核验了第九轮：I1 通过。I2 的计数定位了根因：CLI 1.1.89 的后台通知 prompt 不带 id，会替换本 run 的 lifecycle，已修复（88eb6b1c、941a3fc4）。I3 说明分支用的会话 ID 与归档的会话 ID 不同，本轮补了诊断（3110f66d）：分支报错附更多计数，主进程日志记录每次会话 ID 采用。
先读 docs/handoff/workflow-surface-2026-11-10/R10.md，再看 STATUS.md 顶部和 README.md 里必须停下的情况。

按 J1 → J2 → J3 → J4 连续完成。每个场景都保存主进程标准输出。
- J1：两个后台 Agent 必须提交一条 completed 记录。
- J2：交出 session adopted 日志、native 帧里会话 ID 的计数，以及分支结果；只交是否和计数，不交 ID。
- J4：满足 R10 的前提才改兼容性清单；本轮门禁只在 J1–J3 全过时才跑。
CLI 用本机实际安装的版本，每份报告写明版本，不改全局安装。每完成一个包就提交、写 reports/J<n>.md、更新 STATUS.md、push，不需要等我回复。

自己验证：独立 test 实例（全新的临时 userData、临时工作区、调试端口），开 SCRY_PROVIDER_EVENT_LOG=1，用脚本扫描事件，用真实指针点击并截图。不要动我主检出的 node_modules，也不要停止或干扰我正在用的日常 App。

边界：不改产品代码，包括 recorder、trace 恢复判据、运行登记和停止语义，不改成 SDK 默认的共享守护进程。J1 同一 run 出现两条记录或没有 turn id 的 completed 记录、出现误停、后台 Agent 全部结束后卡住超过 3 分钟、打包时私有 CLI 再被 SIGKILL：立即停下并保留现场。任何东西被公司安全软件、网络策略或网关拦截就停下记录，不绕过、不长时间轮询；推送如果需要绕过安全软件，也停下告诉我。仓库是公开的，不写公司内部地址、内部产品名、账号、令牌、本机用户名路径，记录内容只交结构不交原文。不删 Qoder 自己的日志文件。真实 Provider 调用已授权。不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不改测试超时，不动 feat/workflow-m0。提交身份按 CLAUDE.md。

全部结束后在 STATUS.md 顶部写「第十轮待核验」，push，然后告诉我已完成。
```
