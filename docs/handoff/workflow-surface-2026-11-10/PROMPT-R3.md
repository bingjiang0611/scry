# 第三轮启动提示（可直接粘贴）

```
继续 scry 仓库分支 claude/sweet-ptolemy-qxysuh。先 git fetch origin 并切到这个分支，拉到最新。

审查方把 Scry 用的 Qoder SDK 从 1.0.17 升到了 1.0.57，rotom 也已经修好。这一轮在本机真实验证这次升级，并补跑第二轮里因为 Qoder 和 rotom 跑不起来而缺的部分。先读 docs/handoff/workflow-surface-2026-11-10/R3.md（为什么是 1.0.57 而不是 1.0.59、本轮要做什么、新增的停下条件），再看 STATUS.md 顶部和 README.md 的必须停下的情况。

按 Q1 → Q2 → Q3 → Q4 连续完成。Q1 先确认 Qoder 能不能跑起来；跑不起来就按 R3 抓 stderr、试配套 CLI，仍不行就停在 Q1 报告原因，然后去做 Q3 里的 rotom 和 Q4。每完成一个包就提交、写 reports/Q<n>.md、更新 STATUS.md、push，不需要等我回复。

自己验证：独立 test 实例（临时 userData、临时工作区、调试端口），开 SCRY_PROVIDER_EVENT_LOG=1，用脚本扫描事件，用真实指针点击并截图，负对照要真的失败过。门禁在干净的 worktree 里按 package-lock 重装依赖后跑，不要动我主检出的 node_modules，也不要停止或干扰我正在用的日常 App。

边界：不要把 Qoder SDK 升到 1.0.58 或更高，不改 Qoder 的进程登记、停止、环境注入和认证方式，不放开单任务停止的版本限制。任何东西被公司安全软件、网络策略或网关拦截就停下记录，不绕过、不长时间轮询。仓库是公开的，不写公司内部地址、内部产品名、账号、令牌。真实 Provider 调用已授权。不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不改测试超时，不动 feat/workflow-m0。提交身份按 CLAUDE.md。

全部结束后在 STATUS.md 顶部写「第三轮待核验」，push，然后告诉我已完成。
```
