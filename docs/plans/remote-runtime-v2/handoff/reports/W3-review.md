结论：通过

# W3 核验（核验方，2026-11-19）

提交：`085c33c8`（实现与测试）、`122fbbd4`/`f95b7fb1`（报告）。

- `approvedVia` 只接受 `'app' | 'host_cli'`，只出现在 remote grant 上（无 `scope` 的旧 grant 按 remote 处理）；值为 `undefined` 的自有键也拒绝。
- 所有 grant 变更都展开 `...g`，字段不丢；配对清理按对象身份过滤，字段保留；新 grant 不写入该字段（发布 1 的要求）。
- 测试覆盖非法值、local grant 上出现、往返、daemon 启动与入网。

复跑（Linux，root 容器）：`npx vitest run src/main/remote/pairing src/daemon/host-process-pairing` 通过；`npm run typecheck` 通过。

未验证：无（本任务不涉及真机）。
