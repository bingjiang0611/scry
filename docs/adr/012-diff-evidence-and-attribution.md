# 012: A Git diff proves change, not authorship

**Status:** Accepted (documents existing behavior)

A before/after Git diff measures net file changes. It complements the observed file footprint; neither one proves which run wrote a shared worktree. Keep the requested capture directory distinct from the resolved repository root.

## Baselines and previews

- In-flight previews recompute against the same capture without consuming it. A final turn or session snapshot supersedes its preview; do not archive the preview. A session's original baseline is the snapshot before its first turn. If the original is gone, a resumed capture starts at a new anchor and must not claim to cover the entire session.
- A worktree created during a turn cannot use the parent repository's turn-start snapshot. Its baseline comes from its first HEAD reflog entry (creation with an all-zero old ID). Keep baseline source, state and supporting fields together. An available baseline has the creation commit and time. Without a trustworthy baseline, keep the reason and leave files empty instead of guessing. Skip worktrees known to predate the turn.
- Distinguish a missing or noninitial reflog entry from a creation time beyond the turn's upper bound. A missing worktree or Git link, missing checkout, failed capture, and per-turn limit are separate causes.
- The `unchanged` strategy is a cheap status read against a clean baseline, not a full scan. Shared collection metrics belong to the same turn-end capture. Cleanup releases one owner's reference; the shared store lives until its final owner releases it.

## Overlap and exclusions

Scope overlap to other known Scry runs in the same canonical working directory, between baseline creation and evidence collection. The producer orders those runs by start time. Reject invalid windows, deduplicate IDs, and keep a truncation flag when reporting hits the limit. Missing overlap is unobserved or legacy. A fully observed window with no overlap means Scry saw no other Scry run, not that external edits were impossible. Partial coverage includes missing parts of the window or evicted observations.

Diff exclusions are caller-declared. Record only paths actually excluded and the number of omitted files, not their bodies. Absent exclusion evidence means no files were omitted by this declaration. A full patch may use durable content plus a bounded preview; an absent content reference does not establish that the full patch was captured.

See [turn-diff.ts](../../src/shared/turn-diff.ts), [turn-diff-normalize.test.ts](../../src/shared/turn-diff-normalize.test.ts), and the [evidence checklist](../agent/change-checklists.md#trace--usage--evidence-改动).
