# 009: Keep CLI integration tests isolated and prove delivery

**Status:** Accepted (documents existing behavior)

Spawn POSIX fixtures in private process groups. Signal only groups owned by the fixture and only once during cancellation: timeout and teardown can overlap while descendant pipes are still open. Observe possible pipe rejection immediately and join the async test continuation before removing its workspace or letting another test use the signal spy. To make a stale socket use a fixture that exits without unlinking it, not an artificial curl status. Use a short temporary socket path: a long `TMPDIR` can exceed the Unix socket address limit and silently test fallback instead of the fast path.

Stub starting a daemon only when the test already owns a peer and the CLI handler itself is under observation. Test fixtures must not reach a user's running recorder. An unprivileged socket-owner test checks the contract; use a separate current-user round trip for acceptance.

When testing the Pi or OpenCode launch scripts, read stdin with shell builtins so a limited `PATH` cannot make an external reader fail after launch. Count delivery only when the stub accepts the payload, not when the process starts. Clear external CLI overrides when exercising workspace pin resolution. Keep the OpenCode test module at the generated module's relative directory depth; its own path resolves the workspace. Exercise a closed child pipe directly rather than adding unrelated Node startup or timing.

See [fixture-processes.test-fixture.ts](../../src/cli/fixture-processes.test-fixture.ts), [hook-fallback.test.ts](../../src/cli/hook-fallback.test.ts), [pi-cli-pin.test.ts](../../src/cli/pi-cli-pin.test.ts), and [workspace-init-opencode-delivery.test.ts](../../src/cli/workspace-init-opencode-delivery.test.ts).
