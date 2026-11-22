# 008: Verify and repair turn evidence without rewriting history

**Status:** Accepted (documents existing behavior)

`turns verify` keeps a stable pass/fail contract for team CI: sequence, deduplication and record readability determine the result (0 or 4). Identity coverage and outstanding turns are advisories, not extra failure criteria. Failed record reads make identity coverage unknown; sequence errors alone do not invalidate identity on readable records. Keep the internal max sequence out of the public result. A temporary artifact left by an interrupted write is not a record; list skipped artifacts instead of silently dropping evidence. An unreadable file with a valid record name is a real failure.

Archive only a contiguous prefix, so the archive floor can explain what moved. Refuse to advance over corrupt records or records a configured callback has not acknowledged. The archive CLI reports 0 for success, 2 when the recorder is unavailable, 3 when approval is required or nothing can be selected, and 5 when the operation is refused.

Recovery cannot expire an open turn solely because it is quiet. For forced expiration require recorded host-process evidence; a targeted session allows recovery without deciding unrelated sessions. Keep `--expire-open` registered as a boolean for automated callers such as CodeLens; see the [CLI lifecycle contract](../../packages/turn-recorder-cli/docs/lifecycle.md#0275-recover---expire-open-可用性与收尾门槛). Notification draining respects persisted retry due times even with unlimited attempts. An unreadable delivery backlog is not proof of success. The separate `commit-hook` command reports 0 for trusted, host-provided or absent configuration; 2 for unavailable recorder storage/config; and 5 for invalid bundles. The authorization contract remains in [the project rules](../../AGENTS.md); `--yes` remains accepted for older scripts.

Repair missing record bodies from the App trace store without editing records. Discover the App data root using the desktop platform's conventions, dry-run by default, and validate size and digest before applying recovered bytes. A missing or corrupt body both leave an unsatisfied reference (exit 3), but report which happened.

See [records-command.ts](../../src/cli/records-command.ts), [recorder-command.ts](../../src/cli/recorder-command.ts), and [scry-record-scan.test.ts](../../src/cli/scry-record-scan.test.ts).
