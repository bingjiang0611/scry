# 给执行 agent 的启动提示（可直接粘贴）

```
你在 scry 仓库工作，分支是 claude/sweet-ptolemy-qxysuh。先 git fetch origin 并切到这个分支，确认 HEAD 包含提交 09304e7b。

任务是把 Claude Code 原生 workflow 的观测面板做完并在本机真实验证。说明都在 docs/handoff/workflow-surface-2026-11-10/ 下，按顺序读：
README.md（协作方式、必须停下的情况、硬约束、已核对的事实、要你回答的 Q1 到 Q11）→ W.md（工作包 A 到 F 的做法与完成条件）→ STATUS.md。再读提交 3a015367 和 09304e7b 的提交说明，以及仓库根的 CLAUDE.md。

按 A → B → C → D → E → F 的顺序连续完成全部工作包。B 是真实事件核对，最重要，先把它做扎实。每完成一个工作包：提交、写 reports/<包>.md、更新 STATUS.md、push 到 claude/sweet-ptolemy-qxysuh。不需要等审查方回复，直接继续下一个。只有碰到 README「必须停下的情况」才停止对应条目，在 STATUS 写明证据和你建议的方案，然后继续其他条目。

你要自己验证，不要把验证留给别人：
- 起独立的 test 实例（临时 userData、临时工作区、调试端口），用真实 Claude 账号跑真实 workflow，开 SCRY_PROVIDER_EVENT_LOG=1 抓原始事件。不要停止或干扰我正在用的日常 App。
- 用真实指针点击驱动界面并截图，截图放 evidence/screens/。重启后恢复这一条必须真的退出再启动。
- 写脚本把面板显示与原始事件逐行对比，不要肉眼判断。
- 发现真实格式和现有代码不一致就直接修，配先失败后通过的测试，并把脱敏的真实摘录做成测试夹具。审查方在 Linux 容器里只能看到你 push 的内容，它靠重跑这些测试来核验。

授权范围：真实 Claude 调用和费用已授权，预算不是约束，不要为省钱缩小验证。可以修改本面板相关的代码、测试、脚本和本交接目录。不 push main，不开 PR，不合并，不发布，不运行 install:mac:dev，不安装到 /Applications。不要动 feat/workflow-m0 分支。提交身份按 CLAUDE.md。

全部结束后写 reports/SUMMARY.md，在 STATUS 顶部写「全部待核验」，push，然后告诉我已完成。
```
