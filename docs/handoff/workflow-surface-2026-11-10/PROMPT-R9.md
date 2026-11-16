# 第九轮启动提示（可直接粘贴）

```
继续 scry 仓库分支 claude/sweet-ptolemy-qxysuh。先执行：
git fetch origin claude/sweet-ptolemy-qxysuh
git switch claude/sweet-ptolemy-qxysuh
git reset --hard origin/claude/sweet-ptolemy-qxysuh

审查方核验了第八轮：H1、后台 Agent 的流关闭顺序、H4 的三项回归都成立。本轮新增：
- 71ffdb5d：Hook 窗口停止后实时提交，不用再等重启。
- 3eb50e4d：recorder 的 lifecycle 不一致和分支「没有找到归档」两种报错，现在都会在括号里附上计数。
先读 docs/handoff/workflow-surface-2026-11-10/R9.md，再看 STATUS.md 顶部和 README.md 里必须停下的情况。

按 I1 → I2 → I3 → I4 → I5 连续完成。每个场景都保存主进程标准输出。
- I1：Hook 窗口停止 3 次，不重启就要看到中断提示和 interrupted 记录。
- I2、I3：如果失败，交出报错括号里的计数和 R9 列的结构，不要自行修改。
- I4：test:unit 只跑一次，不重跑。
- I5：满足 R9 写的前提才改兼容性清单。
CLI 用本机实际安装的版本，每份报告写明版本，不改全局安装。每完成一个包就提交、写 reports/I<n>.md、更新 STATUS.md、push，不需要等我回复。

自己验证：独立 test 实例（全新的临时 userData、临时工作区、调试端口），开 SCRY_PROVIDER_EVENT_LOG=1，用脚本扫描事件，用真实指针点击并截图。门禁在干净 worktree 里按 package-lock 重装依赖后跑，不要动我主检出的 node_modules，也不要停止或干扰我正在用的日常 App。

边界：不改产品代码，包括 recorder、trace 恢复判据、运行登记和停止语义，不改成 SDK 默认的共享守护进程。Hook 窗口停止后出现没有 Provider turn id 的记录或同一 run 两条记录、出现误停、后台 Agent 全部结束后卡住超过 3 分钟、打包时私有 CLI 再次被 SIGKILL：立即停下并保留现场。任何东西被公司安全软件、网络策略或网关拦截就停下记录，不绕过、不长时间轮询；推送如果需要绕过安全软件，也停下告诉我。仓库是公开的，不写公司内部地址、内部产品名、账号、令牌、本机用户名路径，记录内容只交结构不交原文。不删 Qoder 自己的日志文件。真实 Provider 调用已授权。不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不改测试超时，不动 feat/workflow-m0。提交身份按 CLAUDE.md。

全部结束后在 STATUS.md 顶部写「第九轮待核验」，push，然后告诉我已完成。
```
