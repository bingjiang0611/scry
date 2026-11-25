# Source comment audit — current-tree reconciliation at a45e9540

Base: `e3355f86`. Audit source pin: `a45e9540`. The verification below carries the earlier `c6c615be` coverage forward; it is not a fresh review of unchanged files.

| JS/TS cohort | Paths | Evidence |
|---|---:|---|
| Unchanged | 2,492 | Exact path and Git blob match to the prior coverage manifest |
| Changed or added, no parsed comments | 30 | Parsed pinned blobs |
| Changed or added, with comments | 196 | Token and source-context reconciliation below |
| Deleted | 4 | Removed files are not live review targets |

The live first-party JS/TS total is **2,718**, including 201 changed and 25 added paths. The selector includes nested test fixtures and non-generated experiment source; it excludes root documentation, captured fixtures, third-party assets, vendored BudouX and generated G0 bindings.

Of the retained historical tokens in the 226 live delta paths, 1,253 had matching nearby code tokens and eight more were in files with unchanged comment-free syntax. Another 172 matched the upstream-delta ledgers by path and exact text. Of the remaining 212 new or rewritten tokens, 179 matched a verified first-parent audit edit and 18 matched restored upstream fixture bytes. These are bounded joins, not proof of identical behavior when a caller elsewhere changes. Tool directives are not counted as prose dispositions.

## Context recheck

The remaining 15 new or rewritten tokens and 24 retained tokens with changed neighboring syntax were reviewed in the following groups. Lines refer to the source pin, before the three small wording/placement fixes in this pass.

| Source | Disposition and evidence |
|---|---|
| `git-capture.ts:94`; `git-repository-location.ts:88`; `store.ts:86`; `turn-repository-location.ts:28,32` | Keep. `git-compute.ts:338–342` calls the after-tree hook only for a non-shared capture; `recorder-segment-diff.ts:93` supplies the next-segment freezer. Config continuations are explicitly unsupported. Reservation precedes the record write; the watermark supplies the next allocation floor. The location projection and its tests distinguish a detached `null` from an absent branch at each endpoint. |
| `host-metrics-parsers.ts:109`; `host-metrics.ts:78,80,83,101` | Keep. The parser maps PSI `avg10` to the display bands. `ps` selects `ucomm` rather than the argument vector. The sampler caps and folds Provider rows and reuses a completed snapshot within the larger cache/interval budget. This does not establish in-flight coalescing or an independently verified minimum interval; see #197. |
| `llm-performance-history.ts:120`; `llm-performance.test.ts:91`; `span-ledger-usage.ts:324`; `llm-performance.ts:164` | Keep. Cache expiry is shortened for the recent unresolved Antigravity subset, not every history row. The timing fixture deliberately uses different turn and call counts. Pricing estimates are constructed during the read projection; no historical ledger amount is rewritten. The comparison projection retains coverage while omitting metrics from failed history rows and filtering settled in-memory entries. |
| `history-reader.ts:121` | Keep. The bounded estimate is calculated on display projections after materialization, not an allocation cap for building them (ADR 040). |
| `scripts/fixtures/{lists-smoke,llm-performance-smoke,session-cache-smoke}.tsx` | Seven tokens. Keep the isolated-bridge descriptions: these fixtures inject in-memory responses into mounted renderer components. Revise two history tokens to describe synthetic inputs, not measurements. |
| `scripts/lists-ui-checks.mjs:86–89`; `scripts/llm-performance-ui-checks.mjs:78`; `scripts/structure-ui-checks.mjs:38–41` | Keep nine tokens. The list checks assert prior reasoning is hidden until reveal and the skill header remains visible. The visibility statement describes the synthetic event path, not the optional native path. The first-frame preview assertions check expected selection, preview source, no authoritative body, and disabled execution controls in the fixture only. |
| `query-channels.ts:99`; `startup-channels.ts:84,101` | Keep the two ownership notes: the App rechecks the selected workspace after the response, and the new-session result updates the window badge separately from the daemon reset. Reattach the control queue JSDoc to its handler factory rather than the price import. |
| `db-stats.ts:110`; `qoder-credits.ts:286` | Keep. The persisted scopes are projected before the fallback read, and the projected credits are not assigned to an auto-routed model. |
| `llm-performance-data.ts:50`; `analytics-copy.ts:11`; `format-usage.ts:1` | Keep the axis and stale-range explanations: the scale uses the measured peak rather than clipping it, and the stale-data note supplies the visible range. Clarify that numeric totals and observed-usage presence are separate checks, not that all partial totals are absent. |

The three source files edited in this pass kept identical non-comment text, emitted JS/JSX and tool directives. Three focused tests and the source comment ratchet passed. The serialized-fixture checks elsewhere in the audit compare bytes, not a live application run.

## Limits and handoff

The pinned non-JS/TS cohorts include 151 Swift (with the generated wire exclusion), 15 Python, 11 Xcode config, 119 JSON/resolution, 10 HTML, 87 CSS, and 29 shell/config paths (27 first-party, two documentation-tree ignore files). The last cohort includes both the workspace test's interpreter and its generated stub's interpreter, left intact. These are source/config checks, not iOS build or runtime evidence.

Separate test and behavior candidates remain in the linked [historical](source-comment-audit-388eb882.md) and [upstream](source-comment-audit-840f77cd.md) ledgers. Their disposition is to preserve the local guards and verify the behavior separately, not to claim a reproduced failure or silently change a test in this PR. No private defensive details are added here.
