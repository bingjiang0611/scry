# 状态

状态值：`未开始` → `进行中` → `待核验` → `已核验` / `需修改`；证实不了：`放弃（附证据）`。等待前提：`阻塞`。

执行方完成批次后更新本表并 push；审查方核验后更新状态与核验备注。

| # | 问题 | 批次 | 状态 | 报告 | 核验备注 |
|---|---|---|---|---|---|
| H1 | 缺开始事件时整轮被当 duplicate 丢弃 | A1 | 已核验 | [A 报告](reports/A.md) | orphan-only 范围接受；V1 误报已修，`7ced5ba` 上 13 个测试失败、修复后 233/233 通过（Linux/Node 22 复跑）；OpenCode idle 去重需 repair |
| H2 | hook 脚本静默跳过无痕迹；invalid_config 当作禁用 | A2 | 已核验 | [A 报告](reports/A.md) | 快路径无新增进程、始终 exit 0、符号链接保护成立；需 repair；V3 时间分级已核验（7 失败→通过，升级 CLI 即生效）；真实 Provider 在 OpenCode/Qoder/Codex 隔离验收通过（a21110c），OpenCode/Qoder 短轮次 180 秒宽限按现有行为接受 |
| L2 | 开始/终态 open.json 不 fsync | A3 | 已核验 | [A 报告](reports/A.md) | 只在开始与终态边界加 sync，中间事件不变；每轮 +6 次 fsync 属必要工作；未做断电测试 |
| H4 | inbox 重放或读取失败即删除 | B1 | 需修改 | [B 报告](reports/B.md) | 证实与修复复跑通过（8 失败→通过）；隔离、5 次上限、不阻塞后续条目成立。sidecar 损坏时 daemon 永不空闲退出（VB1），见核验意见 |
| M1 | recover 被单个会话打断，投递不执行 | B2 | 已核验 | [B 报告](reports/B.md) | 5 失败→通过；逐会话 try/catch、finally 投递、daemon 日志成立；Linux/Node 22 focused 266/266 |
| M5 | 回退链路超时与三重处理 | C1 | 未开始 | | 顺带确认无 daemon 时谁触发宽限后的 recover（见 A 报告 V3 核验意见） |
| L1 | 长路径下快路径失效 | C2 | 未开始 | | |
| M6 | 子目录启动找不到 hook 脚本 | C3 | 未开始 | | 需用户实测 |
| D1 | 发现深度之外的子仓库静默缺席 | D1 | 未开始 | | |
| D2 | 每轮仓库清单与快照状态可见性 | D2 | 未开始 | | |
| H3 | daemon env 串会话（显式 UPLOAD_ENABLED=0 时会误 ACK） | E1 | 未开始 | | 用户 2026-10-25 已确认 uploader 语义，见 E.md |
| M2 | commit hook 队头阻塞无死信 | E3 | 未开始 | | 2026-10-25 重新升为必做：新 uploader 在哈希不符、路径不符、源文件缺失时持续返回非 0，recorder 会永久停在该 sequence（`store.ts:515-521`），见 E.md |
| M3 | ACK 身份绑定 bundle 内容指纹 | E3 | 未开始 | | 降为低优先级（只带来重复校验），可放弃 |
| M4 | ACK 只代表入队；归档后回源校验阻止发送 | E2 + U1/U2 | 未开始 | | recorder 侧 E2 未开始；uploader 侧 U1/U2 已在 `reliability/uploader` 本地完成（53928688），只按报告审阅，见 [uploader 审阅](reports/uploader-review.md) |
| U3 | uploader 不可重试错误返回 0 | U3 | 需修改 | [uploader 审阅](reports/uploader-review.md) | 方向通过；上线前有 3 项必改（bundle 清单、升级重放、非默认 dataDir） |
| U4 | 显式关闭上传无痕迹 | U4 | 需修改 | [uploader 审阅](reports/uploader-review.md) | 语义符合用户确认；同上 3 项必改 |
