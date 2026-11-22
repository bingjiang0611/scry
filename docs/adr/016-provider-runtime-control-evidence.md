# 016: A stop request is not proof of Provider termination

**Status:** Accepted (documents existing behavior)

Track the operator's stop intent separately from Provider settlement. A failed interrupt does not erase the intent. After the grace period, only a proven run-scoped handle may be force-killed; killing shared transport could terminate unrelated runs. Distinguish a shared transport, an unavailable handle and a failed kill. Even after escalation times out, the Provider may still be running. Only actual settlement proves termination; ended-without-outcome reasons do not prove the run achieved its goal. A partial assistant reply in history is not a completion marker.

Approval modes have distinct semantics. Use the default mode unless asked otherwise, and reject unsupported modes instead of silently weakening them. Display only risk reasons supplied by the Provider. Treat that text as data: scrub credentials, control sequences and excess length before display. Native free-text requests do not invent choices; preserve separate editor content and placeholders. Pi sends stable option values (legacy clients may supply labels) and treats input-stage replies as text even when they match a choice.

A caller-supplied command ID makes launch idempotent; omitting it makes no such request. Keep the comparison label independent of network config. Use registered launcher identity for a Pi Agent Profile; legacy discovery IDs describe native sessions, not registered profiles. Native steering acceptance proves admission, not that the model followed the instruction. Validate image input with a linear scan without relying on an unbounded whole-string regexp; the independent test oracle uses only small inputs.

See [runtime-types.ts](../../src/shared/runtime-types.ts), [runtime-input.ts](../../src/shared/runtime-input.ts), [runtime-provider.ts](../../src/shared/runtime-provider.ts), [session-history.ts](../../src/shared/session-history.ts) and [run-stop-lifecycle.test.ts](../../src/main/run-stop-lifecycle.test.ts).
