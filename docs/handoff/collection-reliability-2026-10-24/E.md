# 批次 E：投递链路（H3、M2、M3、M4）—— 等用户确认后再开工

分支：`reliability/collection`。

**开工前提**：用户回答下面三个问题（或提供 commit hook bundle / `scry_turn_uploader.py` 的代码）。审查方会把答案补进本文件，之后执行方才开始。

1. uploader 在 `SCRY_TURN_UPLOAD_ENABLED` 未设置、或 `SCRY_INSTALLATION_ID` 缺失时，是 exit 0 还是非 0？
2. uploader exit 0 之前，是否已经把完整 record 内容复制到自己的 outbox？还是只入队 `recordId`，之后再去 `.scry/records/` 读？
3. 团队是否会执行 `scry records archive`？uploader 脚本是否经常改动（每次改动都会触发 M3 的全量重投）？

## 计划（确认后细化）

- **H3**：开始事件时把上传相关 env（`COMMIT_HOOK_ENV_KEYS` 中的上传项）快照进 `open.json`，提交时写进 record 或旁路文件，投递时用记录自带的快照而不是 daemon 进程 env。shell 快路径需要把这些 env 带给 daemon（header 或 body 包一层），注意不要把凭据写进 record 正文。会话级 `SCRY_RECORDER_ENABLED=0` 也要能经由快路径生效。
- **M2**：按 sequence 记录失败次数，超过阈值移入 recorder 侧死信（`.scry/notifications/dead-letter/`），推进游标并告警；`status` 暴露最老未 ACK 记录的年龄。
- **M3**：ACK 身份与 trust 指纹分离，配置中增加稳定的 `commitHook.id` 作为 ACK key；trust 指纹仍每次校验。bundle 无效时 `status` 报 error 并照常计算 backlog。迁移要兼容现有按指纹保存的 ACK 文件。
- **M4**：取决于问题 2 的答案：要么在通知里带上 record 内容（或 contentRef），要么归档时也检查 uploader 侧 ACK。

红线：commit hook trust 继续 fail closed（CLAUDE.md「权限与 trust 不是一回事」）；ACK 语义仍是至少一次。
