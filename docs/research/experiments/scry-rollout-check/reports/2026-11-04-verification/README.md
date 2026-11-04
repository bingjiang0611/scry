# Scry CLI 0.2.57 + uploader 0.2.10 推广前验证报告

- 执行时间：2026-11-04T12:18Z–13:50Z（本机 04:18–05:50，UTC-8）
- 清单：`docs/rollout-checklist` @ `45bdb5b1`，`docs/research/experiments/scry-rollout-check/CHECKLIST.md`
- 清单检出：`<evidence-root>/checklist-worktree`（独立 worktree，主工作区未动）
- 本文用 `<evidence-root>` 指代本机证据目录，`<user-workspace>` 指代被观测的用户工作区
- 证据根（本地保留，未提交）：`<evidence-root>`
- 证据：`<evidence-root>/logs/`（每步原始输出）、`<evidence-root>/evidence/`（只读探测）、各步 `*.json`（record-check 结论）
- 真实协议映射：`<evidence-root>/protocol.json`（从 0.2.10 dist 反查，仓库内 `protocol.json` 未改未提交）

## 总结论

**不能推广。** 阻塞项（详见第 6 节）：

1. **Qoder 已被接受的中途停止轮没有记录**（0.2.57 重点修复未生效，2 次独立复现），且**已完成的 Qoder 轮被记成 `interrupted`**。
2. **记录版本漂移**：70 条记录里 **27 条由 recorder 0.2.56 写出**（Pi 扩展优先用 `~/.local/bin/scry`，命中陈旧 staging 副本 0.2.56），而 `scry --version` 与 `scry-upload doctor` 都报 0.2.57 —— 现有版本门禁查不出这个问题。
3. **S18 hook 路径首测 FAIL**：notify p95 1562 ms > 1500 ms 门限（复测 1283 / 1476 ms，机器 load 40–55）。
4. **OpenCode 在本机跑不起来**（第 0 步 Provider 登录 FAIL），相关步骤未执行。
5. **隐私/推广文档缺口**：文档没写清"会上传哪些内容"和"不要在不可信仓库启用"；权限位检查字面不通过。
6. **（用户授权补充处理后新增，见第 11 节 F8）缺失的内容 blob 让导出游标永久卡死**：用户 <user-workspace> 工作区有 38 条记录引用的内容文件全都不存在，uploader 无"内容缺失"隔离路径，`discovery_blocked` 每 60 秒重复，导出游标停在 2725 不再前进。

通过的部分：uploader 0.2.10 的合成场景 19/20 通过（S18 除外）、多仓库并发、开关与放行、定时补传、登录失效、卸载与恢复都正常；Qoder **已有记录的 2 条全部 upload 成功、死信 0**（第二个重点项在"有记录"的范围内成立）。

## 1. 版本

| 项目 | 值 | 证据 |
| --- | --- | --- |
| 全局 `scry` | **0.2.57**（`~/.nvm/versions/node/v24.18.0/bin/scry`，Node 24.18.0） | `logs/step2-doctor-a.json`、本次执行 |
| 测试用 uploader | **0.2.10**（`$(npm root -g)/<uploader 包名>/dist/cli.js`，gitHead `6ce58e37`） | `evidence/01-registry.txt` |
| 记录实际 recorder | **0.2.57 ×43 条、0.2.56 ×27 条** | 各仓库 `.scry/records/*.json` 的 `recorderVersion` |
| `scry-upload doctor` 自报 | `checks.scry.value.version = 0.2.57`、`healthy: true` | `logs/step2-doctor-a.json` |
| `~/.local` 上的 uploader | 验证期间 **0.2.8**（未动）；用户授权后已升到 **0.2.10**（第 11 节） | `evidence/00-versions.txt`、`before-daily/local-uploader-version.txt` |
| `~/.local/bin/scry` | 验证期间 0.2.53 启动器，re-exec `~/.local/lib/.scry-cli-updates/…/0.2.56-JK58P5`；授权后已是 **0.2.57** 本体 | `evidence/00-versions.txt`、第 11 节 |
| macOS / arch | 27.2 / arm64 | `evidence/00-versions.txt` |
| codex / qodercli / opencode / pi | 0.166.0 / 1.1.81 / 1.18.31 / 1.2.0 | `evidence/03-provider-auth.txt` |

安装动作（用户授权后执行，唯一一次改日常环境）：

```sh
npm install -g <recorder 内部包名>@0.2.57 <uploader 包名>@0.2.10 \
  --registry=https://<internal-npm-registry>     # exit 0
```

`scry-upload doctor --workspace <evidence-root>/a --json`（exit 0）：`healthy: true`，`checks.scry.value.version=0.2.57`，
`checks.mcp = {server: <internal-trace-service>, tool: <真实上报工具名>, argumentStyle: named}`（与 `<evidence-root>/protocol.json` 一致）。

## 10. 现场与副作用声明

- `<evidence-root>` 保留：`<evidence-root>`（含 7 个测试仓库、`prefix`、`prefix-old-0.1.0`、`prefix-old-0.2.0`、`logs`、`evidence`、各步 JSON、本报告）。
- 唯一的环境改动是用户授权的 `npm install -g <recorder 内部包名>@0.2.57 <uploader 包名>@0.2.10`；`~/.local` 的 0.2.8 未动。
- launchd plist、登记列表、Pi 设置已按 `<evidence-root>/before/` 逐字节恢复；主工作区计数与备份一致。
  （恢复后我又在 `<evidence-root>/probe2` 跑了一次 `scry-upload init` 以取证 F2 的 `cli-path` 解析；它会自动登记该工作区，已 `unregister`，登记列表现与备份逐字节一致。）
- 未 push、未开 PR、未建远端条目；测试仓库的 remote 只用于生成仓库标识。
- 未代替用户登录/授权任何 Provider。
- 为读清单分支新增 worktree `<evidence-root>/checklist-worktree` @ `45bdb5b1`；不需要时 `git -C <scry-repo> worktree remove <evidence-root>/checklist-worktree`。
- 测试仓库产生的记录已真实上传到 `<internal-trace-service>`（repo 标识 `<internal-git-host>/scry-rollout-test/*`、`scry-rollout-test-2/*`），需要服务方按约定清理。

---

本目录按责任拆分：结论与版本 → 合成脚本与 Agent 步骤 → 发现与放行条件 → 日常环境跟进 → 第二轮验证。


## 附录：第一次尝试为何停在版本检查

首次执行时本机全局 `scry` 为 **0.2.56**、uploader 为 **0.2.8**，与任务要求的 0.2.57 / 0.2.10 不符。按"版本不对就停下报告，不要自己升级降级日常环境"，当时未执行任何步骤、未消耗任何 Provider 轮次，只做了只读核对（`<evidence-root>/evidence/*.txt` 即那次留下的证据）。用户随后授权安装，才有了本次完整执行。该次证据保留，可用于说明"版本未部署"不是被测版本的结论。
