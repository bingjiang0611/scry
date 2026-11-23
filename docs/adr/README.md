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
- [014: Side chats copy context, not native session ownership](014-conversation-ownership-and-side-chat.md)
- [015: Give each visible run its own bounded live trace](015-scoped-live-run-traces.md)
- [016: A stop request is not proof of Provider termination](016-provider-runtime-control-evidence.md)
- [017: Keep device approval local and distinct from transport](017-remote-pairing-and-host-approval.md)
- [018: Recover remote Desktop reads without guessing about writes](018-remote-desktop-protocol-evidence.md)
- [019: Report what the App observed about its background service](019-background-service-observation.md)
- [020: Verify the running build; advise on Provider versions](020-build-identity-and-provider-compatibility.md)
- [021: Keep measured speed, recorded usage and account billing distinct](021-usage-observation-and-billing.md)
- [022: Project observed state without granting authority or copying payloads](022-workspace-and-content-projection.md)
- [023: Capture Git evidence without mutating the repository](023-recorder-git-capture-isolation.md)
- [024: Close a recorder turn on its own evidence](024-recorder-terminal-evidence.md)
- [025: Index recovery candidates without making the index authoritative](025-recorder-recovery-attention-index.md)
- [026: Keep canonical records and sequence allocation independent of projections](026-recorder-record-store-durability.md)
- [027: Advance notification ACK only across proven delivery or recorded absence](027-recorder-notification-ack.md)
- [028: Retain hooks before applying them and replay at least once](028-recorder-inbox-replay.md)
- [029: Keep daemon acknowledgements and capture boundaries explicit](029-recorder-daemon-and-capture-boundaries.md)
- [030: Reuse transcript reads without reusing unproven evidence](030-recorder-transcript-windows.md)
- [031: Preserve full content before budgeting its preview](031-recorder-content-custody.md)
- [032: Recover managed turns from durable handoff evidence](032-recorder-managed-handoff.md)
- [033: Keep recorder durability, authorization and observation separate](033-recorder-io-and-configuration.md)
- [034: Test recorder optimizations against independent evidence](034-recorder-regression-oracles.md)
- [035: Share host composition without sharing run ownership](035-host-runtime-composition.md)
- [036: Commit orchestration evidence atomically and fence indeterminate writes](036-orchestration-storage-durability.md)
- [037: Hand off legacy runs without replaying their effects](037-orchestration-legacy-handoff.md)
- [038: Keep orchestration decisions, recovery and delivery evidence separate](038-orchestration-decisions-and-delivery.md)
- [039: Keep login-service ownership separate from daemon liveness](039-daemon-service-lifecycle.md)
- [040: Keep App archive bodies authoritative when indexing or paging history](040-app-transcript-archive-evidence.md)

## Source comment ratchet

`npm run check:source-comments` checks JS and TS under `src/cli/`, `src/shared/` and `src/core/turn-recorder/`, including tests. A comment is grandfathered only if the same text already occurs in the same file. Moving it within a file is fine; copying it, rewriting it, or moving it to another file is not. Git is the baseline: CI uses the PR merge commit's first parent and local runs use the merge base with `origin/main` (fetch it first). Once a deletion reaches main, it cannot grow back.

Compiler and bundler directives, source-map directives, and license notices are not prose. The ratchet does not inspect comment-like strings, embedded scripts, or languages other than JS/TS. The [delete-comment skill](../../.agents/skills/delete-comment/SKILL.md) describes the cleanup workflow. In Pi, invoke it with `/skill:delete-comment` followed by an optional path.
