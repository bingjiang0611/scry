# 状态

状态值：`未开始` → `进行中` → `待核验` → `已核验` / `需修改`；证实不了：`放弃（附证据）`。等待前提：`阻塞`。

执行方完成批次后更新本表并 push；审查方核验后更新状态与核验备注。

| # | 问题 | 批次 | 状态 | 报告 | 核验备注 |
|---|---|---|---|---|---|
| H1 | 缺开始事件时整轮被当 duplicate 丢弃 | A1 | 已核验 | [A 报告](reports/A.md) | orphan-only 范围接受；V1 误报已修，`7ced5ba` 上 13 个测试失败、修复后 233/233 通过（Linux/Node 22 复跑）；OpenCode idle 去重需 repair |
| H2 | hook 脚本静默跳过无痕迹；invalid_config 当作禁用 | A2 | 已核验 | [A 报告](reports/A.md) | 快路径无新增进程、始终 exit 0、符号链接保护成立；需 repair；V3 时间分级已核验（7 失败→通过，升级 CLI 即生效）；真实 Provider 在 OpenCode/Qoder/Codex 隔离验收通过（a21110c），OpenCode/Qoder 短轮次 180 秒宽限按现有行为接受 |
| L2 | 开始/终态 open.json 不 fsync | A3 | 已核验 | [A 报告](reports/A.md) | 只在开始与终态边界加 sync，中间事件不变；每轮 +6 次 fsync 属必要工作；未做断电测试 |
| H4 | inbox 重放或读取失败即删除 | B1 | 已核验 | [B 报告](reports/B.md) | 8 失败→通过；VB1 3 失败→通过（`8a29edf`→`aaee897`），sidecar 不可读时不再阻止 daemon 空闲退出，仍计 pending；VB2 人工重试文档已核验；升级 CLI 后需 `recorder restart` |
| M1 | recover 被单个会话打断，投递不执行 | B2 | 已核验 | [B 报告](reports/B.md) | 5 失败→通过；逐会话 try/catch、finally 投递、daemon 日志成立；Linux/Node 22 focused 266/266 |
| M5 | 回退链路超时与三重处理 | C1 | 已核验 | [C 报告](reports/C.md) | 红测 2→通过；curl 回退只发一次请求并持久入 inbox；VC1：rc=7（stale socket）恢复直写并拉起 daemon，2 失败→通过；Linux 全量无新增失败；需 repair + restart |
| L1 | 长路径下快路径失效 | C2 | 已核验 | [C 报告](reports/C.md) | 红测 2→通过；发布实际 socket 路径，stale hint 安全；VC2 已加 `-O` 属主检查；需 repair + restart |
| M6 | 子目录启动找不到 hook 脚本 | C3 | 已核验 | [C 报告](reports/C.md) | 红测 9→通过（fixture 范围）；需 repair 并重启 Provider；待用户按 C-U2 实测，另需在多仓库工作区的子仓库内启动一次 |
| D1 | 发现深度之外的子仓库静默缺席 | D1 | 已核验 | [D 报告](reports/D.md) | 用户选方案 A：record 只记 discovery 元数据不降级，doctor 仅在下一层看到 .git 时 warn；VD1 5 失败→通过；VD2 注释已恢复，抽取逐行一致 |
| D2 | 每轮仓库清单与快照状态可见性 | D2 | 已核验 | [D 报告](reports/D.md) | 红测 10→通过；同毫秒多仓库快照不再合并，requestedRoot/repoRoot 分离；用户级 bridge_not_found 独立告警；入口无条件 unset 标记；需 repair + restart |
| H3 | daemon env 串会话（显式 UPLOAD_ENABLED=0 时会误 ACK） | E1 | 已核验 | [E 报告](reports/E.md) | env 按轮快照、正文不带 env；VE1：shell 对 4xx 视为确定未送达，5 失败→通过，协议不匹配探针复测通过；需 repair + restart |
| M2 | commit hook 队头阻塞无死信 | E3 | 已核验 | [E 报告](reports/E.md) | 退避 1/5/15/60 分钟后才死信，退避期间续投后续记录，ACK 不越过缺口；`notify-retry` 显式重放经 trust 校验；短暂故障探针复测通过 |
| M3 | ACK 身份绑定 bundle 内容指纹 | E3 | 放弃（附证据） | [E 报告](reports/E.md) | 本批不引入稳定 id：只有重复校验开销；ACK/失败/死信迁移成本不属必做缺口。保留指纹隔离和 fail-closed trust；实际测得主要瓶颈后再单独评估；审查方接受 |
| M4 | ACK 只代表入队；归档后回源校验阻止发送 | E2 + U1/U2 | 已核验 | [E 报告](reports/E.md) | recorder E2：3 红测→通过，通知 v2 带 dataRoot 相对路径与原始字节 SHA-256；uploader U1/U2 按报告审阅（c230f652），真实整链路待验收，见 [uploader 审阅](reports/uploader-review.md) |
| U3 | uploader 不可重试错误返回 0 | U3 | 阻塞 | [uploader 审阅](reports/uploader-review.md) | R1–R3 按报告已处理（c230f652，17/17 离线验收，未读代码）；夹具已更新（fdd20ba7）；用户 2026-10-25 确认服务端已去重，R2 接受；等待：全仓门禁基线失败另行处理、真实端到端验收、recorder E3 |
| U4 | 显式关闭上传无痕迹 | U4 | 阻塞 | [uploader 审阅](reports/uploader-review.md) | 同 U3 |

## 合入前汇总验收（2026-10-26，构建 `6e2012e7`）

详见 [F 报告](reports/F.md)。F-3～F-8 在本机隔离环境通过；F-1、F-2 未全部通过。

| # | 场景 | 状态 | 备注 |
|---|---|---|---|
| F-1 | Claude / Codex / OpenCode 各一轮 | 部分通过 | OpenCode 12 条 record、Pi 限流下仍 1 条；Claude 隔离 HOME 内 CLI 无输出被 SIGKILL；Codex 轮次完成但无 record；Qoder 阻塞于凭据 |
| F-2 | Codex 子目录 / 子仓库 | 未通过 | 同 Codex：hook 打印 Completed，`.scry` 无写入，`health.json` 全 0；`--sandbox workspace-write` 下 UserPromptSubmit 后挂住 |
| F-3 | 长路径 workspace | 通过 | socket 指针指向 95 字节真实 socket，1 条 record |
| F-4 | 多仓库 root / `one/` / `a/b/c` | 通过 | discovery 列出请求目录，doctor warn 且含 `a/b/c`，单仓库深目录对照 pass |
| F-5 | 每轮 env | 通过 | 未设置/`0`/`1` 三者逐轮隔离 |
| F-6 | 通知 v2 | 通过 | 41 次投递 schemaVersion=2、sha256 一致、按 recordPath 读取 |
| F-7 | uploader 短暂故障恢复 | 通过 | attempts=1、nextRetryAt=+60s、退避内不重调用、到期补投、ACK 前进 |
| F-8 | kill daemon | 通过 | 下一轮落盘、daemon 自动拉起、inbox 0 |
