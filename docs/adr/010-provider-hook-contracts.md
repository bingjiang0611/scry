# 010: Preserve provider-specific hook delivery contracts

**Status:** Accepted (documents existing behavior)

The shell bridge must not block a Provider when observation fails. OpenCode's plugin still needs the result: a refused Stop is not an accepted terminal event. Retain the pending event and error evidence for a later idle retry, but do not carry error state into the next turn after delivery. Read stdin before the fast path so fallback can still deliver the original payload. Only HTTP 200 is success on that path; managed delivery bypasses it. Bound suppression history and treat an evicted identity as unknown, not as a duplicate. Hook skip recency comes from event timestamps across both retained generations, not rotation or file mtime.

Register SessionEnd only where observed: Claude and Qoder (verified even when quitting before a model turn); not Codex or OpenCode. Use a shorter timeout than Stop because SessionEnd only persists and queues. Find the hook bridge with shell builtins and stop at the nearest Git boundary; nested repositories must not run a parent workspace's hook.

For Pi, an explicit CLI override outranks the workspace pin. A missing pin permits the default lookup (user-local before PATH), but a present unreadable or dangling pin fails without guessing. Recognize older managed install markers across npm scopes. Clip large JSON values without breaking the JSON structure.

Preserve the existing last-value view of repeated CLI options for callers that cannot read the full value list.

See [workspace-hook-sources.ts](../../src/cli/workspace-hook-sources.ts), [workspace-init.test.ts](../../src/cli/workspace-init.test.ts), [pi-cli-pin.test.ts](../../src/cli/pi-cli-pin.test.ts), and [command-args.ts](../../src/cli/command-args.ts).
