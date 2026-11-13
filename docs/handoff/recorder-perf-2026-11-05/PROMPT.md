# 给执行 agent 的启动提示（可直接粘贴）

```
你在 scry 仓库的分支 perf/recorder-engine 上工作。先 git fetch 并切到这个分支。

任务说明在 docs/handoff/recorder-perf-2026-11-05/ 下。按顺序读：
README.md（硬约束、协作方式、必须停下的情况）→ review.md（已核对的代码事实）→ M.md → G.md → R.md。

按 M → G1 → G2 → R 的顺序连续完成所有条目。每完成一个条目：提交（测量与优化分开提交）、
写 reports/<批次>.md、更新 STATUS.md、push 到 perf/recorder-engine。不需要等审查方核验，
直接继续下一个。只有碰到 README「必须停下的情况」才停止，并在 STATUS 写明原因。

测量后判定不值得做的条目，写明数字后标「放弃」并继续，这是合格结果。
所有 Git 快照改动必须通过 M2 的 oracle 测试；oracle 不一致时不能改 oracle 让它通过。

不 push main，不开 PR，不发布 npm，不安装桌面 App。
全部结束后写 reports/SUMMARY.md，在 STATUS 顶部写「全部待核验」，push。
```
