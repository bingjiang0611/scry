# Architecture decision records

Record decisions whose rationale would otherwise be lost. Prefer an existing canonical document if it already explains the decision. Otherwise add a short ADR with the context, chosen approach, rejected alternatives, and consequences. Link to owning code and tests rather than quoting them.

- [001: Defer session capture without losing event order](001-deferred-session-capture.md)
- [002: Manage integration hooks by ownership, not command text](002-managed-integration-hook-ownership.md)
- [003: Bound automatic CLI updates without slowing hook delivery](003-cli-auto-updates.md)
- [004: Queue recorder hooks on unknown delivery](004-recorder-hook-delivery.md)
- [005: Deduplicate only comparable transcript usage](005-transcript-usage-dedupe.md)
- [006: Report only observed file operations](006-observed-file-operations.md)
- [007: Separate recorder diagnostics from claims about capture and delivery](007-recorder-diagnostic-contract.md)
- [008: Verify and repair turn evidence without rewriting history](008-turn-store-verification-and-recovery.md)
- [009: Keep CLI integration tests isolated and prove delivery](009-cli-integration-fixture-isolation.md)
- [010: Preserve provider-specific hook delivery contracts](010-provider-hook-contracts.md)
- [011: Keep trace evidence separate by source and lifecycle](011-shared-trace-evidence.md)
- [012: A Git diff proves change, not authorship](012-diff-evidence-and-attribution.md)
- [013: Keep missing evidence and negative evidence distinct in turn records](013-turn-record-evidence-contract.md)

## Source comment ratchet

`npm run check:source-comments` checks JS and TS under `src/cli/` and `src/shared/`, including tests. A comment is grandfathered only if the same text already occurs in the same file. Moving it within a file is fine; copying it, rewriting it, or moving it to another file is not. Git is the baseline: CI uses the PR merge commit's first parent and local runs use the merge base with `origin/main` (fetch it first). Once a deletion reaches main, it cannot grow back.

Compiler and bundler directives, source-map directives, and license notices are not prose. The ratchet does not inspect comment-like strings, embedded scripts, or languages other than JS/TS. The [delete-comment skill](../../.agents/skills/delete-comment/SKILL.md) describes the cleanup workflow. In Pi, invoke it with `/skill:delete-comment` followed by an optional path.
