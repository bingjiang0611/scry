# Batch 3 · P1 final review 修复记录

## R1 能力诚实性——完成

先扩展 `host-process.test.ts`，通过真实 mTLS-over-unix 读取 desktop info 与 Provider metadata。旧实现失败：daemon 明明只会抛 `daemon_capability_unavailable`，却广告 `sessionActions/sessionFork/sessionDelete`。

修复后，`RemoteHostRuntime` 的 session action/fork/delete 能力为可选；`createHostRuntime` 只有拿到真实实现才向 controller 注册对应 handler。Electron main 仍提供原实现，行为不变；daemon 不再提供 throwing stub，并让 Provider discovery 的 `forkSession` 恒为 false。测试同时断言 desktop info 不含三个 capability，Codex metadata 不含 `forkSession: true`。

门禁：main+daemon+host-runtime 2905 passed（3 skipped）；typecheck、build、完整 `test:desktop-remote`、串行重建后的 `--dev` security smoke 全绿。
