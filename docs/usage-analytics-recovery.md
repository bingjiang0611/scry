# Managed usage analytics recovery

## Scope and evidence

Analytics covers Scry-managed sessions. This repair does not import unrelated external CLI sessions.

- Custom upstream IDs (for example `cc-switch`) remain separate billing dimensions. A Claude model name does not prove that its upstream is Anthropic.
- Missing provider identity is shown as `unknown`; its retained usage is not discarded.
- Pi catalogue dollars are estimates. An unpriced catalogue zero is not evidence of a free request. Qoder uses its separate request-level Credits instead.
- Credits use the existing base-plan equivalent, `1 Credit = $0.01`. This is an estimate, not a provider-reported dollar charge or a complete account bill.
- Failed/aborted requests with observed usage remain included. Transport failure before settlement preserves the observed lower bound once, without marking the run successful. Unobserved in-flight consumption remains unknown.

## Historical repair

SQLite migration V16 reconstructs missing ledger entries from retained result spans and model usage, joined to managed session references. It handles every retained upstream, not only Claude and Qoder. Pi and OpenCode resolve per-model upstream identity; native Codex keeps its runtime billing identity.

The migration is transactional and insert-only. Existing canonical rows, including native runtime attribution and aggregate results, take precedence. Missing quantities remain null. Reconstructed cost provenance is explicitly inferred; historical Qoder/ambiguous Pi catalogue zeros are not treated as dollar charges. Original per-model reasoning and cost provenance cannot be recovered from this SQLite projection.

A later canonical replay replaces reconstruction for that exact result. It must not leave an old unknown aggregate beside new model rows.

## Pi Qoder metering

The reader validates the native session header, canonical file containment and exact archived user-entry identities. It reads `qoder-credit-observation-v1` entries independently of assistant token usage. It covers all attributed branches, deduplicates request IDs and marks conflicting/invalid observations unknown. Copied fork observations and untracked user continuations are not assigned to Scry runs by text or timestamp.

An unfinished final JSONL entry does not invalidate the complete prefix. The projection remains partial and reports the unfinished tail. Corruption within completed JSONL is not silently accepted.

Each refresh reads at most 200 Pi sessions and 64 MiB in total, with the existing 64 MiB per-file ceiling. All remaining scopes retain unavailable coverage; scan-limit reasons are included in the Credits tooltip. Ownership lookup is memoized. A session beyond these limits requires an identity-validated streaming/indexed reader, not higher silent limits or a claim of complete coverage. Native Qoder retains its existing separate scan budgets.

## Verification snapshot (2026-10-15)

On a private copy of the local database (not the live database), the repair added 285 missing usage rows: 49 `cc-switch`, 186 Qoder, 49 unknown-identity results and one native Claude result. All 1,300 retained managed model-usage rows were represented exactly once; the original 1,106 ledger rows were unchanged. These are retained record counts, not a claim that a provider exposed every physical request.

In the copied seven-day scope, 38 Claude/`cc-switch` model rows and 31 Qoder turns were visible. The Pi metering projection found 517.411698 Credits (about $5.17 equivalent), with 266 metered requests and seven requests without valid metering. Unlinked observations and subagent consumption are not inferred into these totals.

Checks include migration rollback/idempotence and legacy native attribution, OpenCode same-model/different-upstream repair, mixed Pi providers including failed requests, interrupted transport, metering duplicates/conflicts/zero/unknown/forks/torn tails, a 5,000-request chain, and scan-budget coverage. The isolated Electron analytics fixture exercises the production SQLite/archive query, Pi/native Qoder mixing, custom Claude rendering, visible custom chart series, refresh, range/model/day controls and canonical replay over reconstructed usage. No paid provider call is required.

Final focused checks: 193 tests in 10 files passed; typecheck, production build, shell tests and the Electron analytics fixture passed. Disabling the custom-provider mapping, historical repair and Pi metering read produced four regression failures; the guards were restored before the final checks.

The working-tree full unit run was not green: 3,025 tests passed, three opt-in probes were skipped, and three tests timed out in source-control commit operations and OpenCode server shutdown. A diagnostic focused run passed those original timeout cases but encountered two new `base is not defined` failures in concurrently edited source-control tests. Neither their assertions nor timeouts were changed for this repair. Focused analytics checks and the full-suite outcome must be reported separately.
