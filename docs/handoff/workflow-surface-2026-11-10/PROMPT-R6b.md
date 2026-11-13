# 第六轮续跑提示（可直接粘贴）

```
继续 scry 仓库分支 claude/sweet-ptolemy-qxysuh。先执行：
git fetch origin claude/sweet-ptolemy-qxysuh
git switch claude/sweet-ptolemy-qxysuh
git reset --hard origin/claude/sweet-ptolemy-qxysuh

审查方已核验 F0：被提交的 hook-1 带有 Provider turn id，走的是 2026-09 就有的启动恢复（reserveCanonicalJournalRecovery），属于预期行为，不是不该提交的轮次。你停下是对的，原因是 R6 的措辞太宽，责任在审查方。先读 docs/handoff/workflow-surface-2026-11-10/R6.md 末尾「审查方核验 F0 与续跑」一节，那里的停下条件替换 R6 原条款。

按顺序继续：
1. F0 第 3 步：E4 原路径已备份，直接用当前构建在原路径启动，拿到 invalid canonical record 的字段路径，按 R6 导出被点名段的结构。
2. F0 hook-1 补采：已提交记录的 hooks 每个元素的 event、runs、lifecycleEvents、status，以及有无 name、command、startedAt、completedAt；再从备份 journal 里按 event 统计 hookId 是否成对。只交计数和是否成对，不交 id 原文。
3. F1 → F2 → F3 → F4，要求不变。
CLI 用本机实际安装的版本（现在是 1.1.88，在兼容范围内），每份报告写明版本，不改全局安装。每完成一个包就提交、写 reports/F<n>.md、更新 STATUS.md、push，不需要等我回复。

自己验证、边界与第六轮原提示相同：独立 test 实例、SCRY_PROVIDER_EVENT_LOG=1、真实指针点击并截图；门禁在干净 worktree 里跑；不改产品代码；被安全软件、网络策略或网关拦截就停下记录；仓库是公开的，不写内部信息和本机用户名路径，记录内容只交结构不交原文；不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不改测试超时，不动 feat/workflow-m0；提交身份按 CLAUDE.md。

全部结束后在 STATUS.md 顶部写「第六轮待核验」，push，然后告诉我已完成。
```
