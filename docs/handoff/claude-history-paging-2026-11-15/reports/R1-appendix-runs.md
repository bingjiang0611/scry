# R1 附录：首次失败与重跑记录（如实）

主报告：[`R1.md`](R1.md)

1. **T3 第一次 smoke（HEAD）**：会话打开停在 `data-history-source=preview`、1 轮、无 `session_history.load` 记录。原因两层：(a) Claude adapter 未注册（`SCRY_ELECTRON_SMOKE_PROVIDER=1` 只注册 codex 夹具），需要 `SCRY_ELECTRON_SMOKE_CONVERSATIONS=1`；(b) 夹具用 clonefile 复制导致 sidecar stamp 失配、索引不可用，退化成全量读。修好后同一 smoke 得到 `archiveIndexTurns=100 / archiveTurnFilesRead=10`。
2. **T3 基线第一次**（`--warmups 1 --iterations 12`）：`Native session readiness timed out`（脚本内 15 s 上限），基线单次冷打开远超 15 s。改为可选 `deadlineMs` 后重跑成功。
3. **T3 基线第二次**：`--iterations 12` 在测量阶段超时（同样是 15 s 上限未被那次脚本使用），改为 `--iterations 6` 并加 `deadlineMs` 后完成。
4. **T4 前几轮**：T4-1 断言写错（把「输入框 DOM disabled」当成锁），实际产品契约是「草稿可写、发送被 `sessionLoading` 锁住」；T4-3 用 `scrollTop=0`+合成 scroll 事件无法触发自动续读，改为真实滚轮；T4-4/T4-5 的侧栏点击被浮层挡住，改为先 `scrollIntoView` 再按候选点命中元素本身。修正后逐条通过（`accept-paged2/3/4/5.log` 保留了每次的失败明细）。
5. **T4 首轮另有一处真实等待不足**：第一次打开 Older 页需要冷发布约 1200 个工具正文（本机单次目录同步约 95 ms），15 s 等待窗口必然「无增长」。把等待改为 300 s 后通过 —— 这是负载下的真实成本，不是断言放宽。
6. **T1 unit / renderer UI**：见上表；renderer UI 首次失败是原生模块 ABI 不匹配，重建后通过。

