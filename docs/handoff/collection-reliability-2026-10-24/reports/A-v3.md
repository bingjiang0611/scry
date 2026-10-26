## V3 修改记录

用户已批准本次策略：hook skip 按最近 24 小时分级。实现/原始验证基线 `e70b27e0`；最终测试提交 `17a5333f`（原本地 `782dd61c`），修复提交 `830b010e`（原本地 `112f9414`）。只改诊断汇总/doctor，不改 shell 快路径、hook 退出码、fsync 或 trust gate。

手验期间远端新增了 E 计划与 B 核验两条纯文档提交。推送前已将本次未推送的三个提交 rebase 到 `25ba1251`，没有改写远端历史；`git diff 112f9414 HEAD -- src` 为空，确认已验证的源码/测试未变。没有实施 E 或修改 B。

- `readHookSkips` 新增 `recentCount`，按当前保留的两代日志中的行时间戳计算，不按 mtime；24 小时边界包含在内。时间无法解析及未来时间均保守计 recent，避免时钟异常把问题隐藏。
- `count` 仍是保留窗口总数，不是终身计数。`lastAt` 只返回可解析且符合原有安全格式的时间，不导出任意日志内容。
- doctor：recent > 0 为 `hook.skips=fail`、`status=error`、退出 5；仅旧条目为 warn，不因它改变退出码。没有其他问题时仍 healthy/0；已有 pending 等问题仍按原合同 degraded/5，损坏/未启用配置的退出码也未改。
- recorder status 和 support-bundle 复用同一汇总，均输出 recentCount；不复制第二套统计逻辑。
- 不需要 integrations repair。已有 daemon 的 hook 协议未变；诊断要用升级后的 CLI。本次要求的 A 手验另用 `a21110c`，**那个版本没有 V3，不能用它验证新告警策略**。

### 旧实现失败输出

```sh
npm run test:unit -- src/cli/hook-skip-recency.test.ts
```

`/tmp/scry-V3-before.log`：7 项失败。固定时钟 `2026-10-25T12:00:00Z`，覆盖 1 小时前、25 小时前、混合、坏时间戳、恰好 24 小时、无历史、旧条目与其他 pending 共存。输出中的关键差异：

```text
× hook skip severity uses a rolling 24-hour window > 'one hour ago'
  → expected { count: 1, …(3) } to match object { count: 1, recentCount: 1, …(2) }
× hook skip severity uses a rolling 24-hour window > '25 hours ago'
  → expected 5 to be +0 // Object.is equality
  → expected { schemaVersion: 1, …(16) } to match object { status: 'healthy', …(3) }
× hook skip severity uses a rolling 24-hour window > 'both old and recent'
  → expected { count: 2, …(3) } to match object { count: 2, recentCount: 1, …(2) }
× hook skip severity uses a rolling 24-hour window > does not mask an unrelated pending warning when all skips are old
  → expected { schemaVersion: 1, …(16) } to match object { status: 'degraded', …(2) }
Test Files  1 failed (1)
Tests       7 failed (7)
```

上面是原输出的字段差异节选；完整本机日志保留在上述路径，未包含 Provider 原文。原有 scry.test.ts 的固定日期样本改用固定 Date 时钟，避免测试随日历过期；没有删除或降低断言。测试提交前 typecheck 通过；全量仅新增 7 项失败，原有 3927 项通过、4 项既有跳过。

### 修复后验证

| 检查 | 结果 | 日志 |
|---|---|---|
| focused：hook-skip-recency、hook-diagnostics、scry 三个测试文件 | 55 通过 | `/tmp/scry-V3-focused.log` |
| `npm run typecheck` | node / web 通过 | `/tmp/scry-V3-typecheck.log` |
| `npm run build:cli` | 通过；仅本地忽略产物，未安装 | `/tmp/scry-V3-build.log` |
| 提交前 `npm run test:unit` | 3934 通过、4 项既有跳过；325 文件通过 | `/tmp/scry-V3-unit.log` |
| `git diff --check` | 通过 | 提交前检查 |
| 纯文档远端同步后重跑上述三个 focused 文件及 typecheck | 55 通过；node / web 通过；源码与原全量通过版本一致 | `/tmp/scry-V3-after-rebase-focused.log`、`/tmp/scry-V3-after-rebase-typecheck.log` |

环境：macOS arm64、Node v24.18.0、Vitest 3.2.7。所有夹具使用临时 workspace。四个既有跳过仍是 performance-correlation、billing-admin-real、p0-integration、p1-integration；没有新增 skip 或修复无关失败。focused 首次命令多传了不存在的 support-bundle.test.ts，Vitest 实际执行的是表中三个文件；support-bundle 由新测试直接调用真实 collectSupportBundle 验证，未把不存在的文件算作通过。

用户明确批准了本次 V3 / 手验报告的既有大文件提交门禁临时豁免；未改持久 hook 配置或运行时信任校验。
