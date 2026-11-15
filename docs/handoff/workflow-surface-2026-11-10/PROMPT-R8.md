# 第八轮启动提示（可直接粘贴）

```
继续 scry 仓库分支 claude/sweet-ptolemy-qxysuh。先执行：
git fetch origin claude/sweet-ptolemy-qxysuh
git switch claude/sweet-ptolemy-qxysuh
git reset --hard origin/claude/sweet-ptolemy-qxysuh

审查方按第七轮证据修了四处，并补了两项诊断（db4f9015、285099b4、ebb660f4、c7da591b）：
- 发送后、runId 返回前点的停止原来会被丢弃，现在会在 runId 一到时送出。
- 中断的实时轮次显示「本轮已中断」。
- 后台 Agent 结束后，等它的通知送达再关闭输入流，修 Operation aborted。
- 分支报错写明原因；主进程日志记录每个 Qoder 守护进程的 owner、pid 和启停时刻。
先读 docs/handoff/workflow-surface-2026-11-10/R8.md，再看 STATUS.md 顶部和 README.md 里必须停下的情况。

按 H1 → H2 → H3 → H4 → H5 连续完成。每个场景都保存主进程标准输出。
- H1：启动窗口停止 3 次，至少 1 次在 200 ms 内，另做一次不点停止的负对照。
- H2：把主进程日志和 native 时间线放到同一时间轴上。
- H3：分支失败时只交出报错原因。
- H5：满足 R8 写的前提才改兼容性清单；门禁有超时先测 node 启动耗时。
CLI 用本机实际安装的版本，每份报告写明版本，不改全局安装。每完成一个包就提交、写 reports/H<n>.md、更新 STATUS.md、push，不需要等我回复。

自己验证：独立 test 实例（全新的临时 userData、临时工作区、调试端口），开 SCRY_PROVIDER_EVENT_LOG=1，用脚本扫描事件，用真实指针点击并截图。门禁在干净 worktree 里按 package-lock 重装依赖后跑，不要动我主检出的 node_modules，也不要停止或干扰我正在用的日常 App。

边界：不改产品代码，包括 recorder、trace 恢复判据、运行登记和停止语义，不改成 SDK 默认的共享守护进程。出现误停（没点停止的轮次被中断），或后台 Agent 全部结束后仍卡住超过 3 分钟，立即停下并保留现场。任何东西被公司安全软件、网络策略或网关拦截就停下记录，不绕过、不长时间轮询；推送如果需要绕过安全软件，也停下告诉我。仓库是公开的，不写公司内部地址、内部产品名、账号、令牌、本机用户名路径，记录内容只交结构不交原文。不删 Qoder 自己的日志文件。真实 Provider 调用已授权。不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不改测试超时，不动 feat/workflow-m0。提交身份按 CLAUDE.md。

全部结束后在 STATUS.md 顶部写「第八轮待核验」，push，然后告诉我已完成。
```
