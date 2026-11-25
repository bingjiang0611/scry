# Source comment audit — wording and evidence candidates at 388eb882

All 209 candidates from the seven-report ledger matched exactly by path and comment text at `388eb882`. The contextual review found 40 useful explanations, 138 wording candidates, and 31 follow-up candidates. These counts are tokens, not issues. A follow-up flags a claim to verify against code or a test oracle; it does not establish a reproduced defect.

The first cleanup batch handles six wording candidates and preserves one adjacent rationale in revised wording. It corrects what a history page proves about I/O, distinguishes redirected daemon output from the consumed child event, describes partial process-table output accurately, and removes a comment that described the spool cap as a sum. The four changed files have matching comment-free source and emitted JavaScript. The comment gate and 30 focused tests passed.

At `906adb081`, the second batch resolved 38 of the 132 remaining wording candidates across 20 files. It distinguishes measured arrivals from inferred causes, fixture actions from assertions, and reused trace hashes from newly hashed suffixes. The 25 comment groups touched 50 source lines before and 45 after. Exact edit replay, comment-free emit, unchanged directives, the ratchet, and 58 focused tests passed. No packaged smoke or benchmark was run for this batch.

At `f1f268fb`, the third batch handled 64 of the 94 remaining wording tokens across 39 files. The changes distinguish fixture evidence from production guarantees, including packaged artifact selection, startup timing, Recorder caches and machine metrics. Exact edit replay and comment-free emit matched; the comment ratchet and 75 targeted tests passed. The 30 remaining tokens include trust-related rationale that needs care in shortening and claims that require separate validation. No live smoke or benchmark was run.

At `c104dd5b`, closed the remaining 30 wording decisions: 22 revised and eight retained for their local fixture or authority rationale. A separate ADR reconciliation closed 20 exact wording tokens (19 grouped review entries; the Qoder note contains two tokens). The combined changes cover 14 source files; exact edit replay, non-comment source, emit, directives, the ratchet, and 211 focused tests passed. No runtime or assertion changes were made. The 31 evidence follow-up tokens in this ledger are separate.

The final byte check restored the `steer-ui-smoke.mjs` wording candidate and its neighboring line: the smoke serializes the whole function. The old text is kept as fixture bytes, not as proof of Provider receipt. This changes the final wording disposition to 129 revised or removed and nine kept.

## Candidate locations

Line numbers refer to the pinned commit, not the cleanup result. Review the current blob and adjacent assertions before applying further changes. Follow-ups belong in separate behavior or validation work if confirmed; consolidate them by contract, not per token.

| Path | Keep | Wording pending | Follow-up | Handled |
|---|---|---|---|---|
| `scripts/check-staged-file-size.test.ts` | 138 | — | — | — |
| `scripts/daemon-mode-smoke.mjs` | — | — | — | 44, 45, 156, 157 |
| `scripts/daemon-mode-smoke/packaged.mjs` | — | — | 7, 8 | 1, 2, 3, 4, 5, 6, 87 |
| `scripts/daemon-mode-smoke/workers.mjs` | 33 | — | 74 | — |
| `scripts/daemon-mode-timing.mjs` | 125, 299 | — | 45, 46, 147, 148, 149, 189, 190, 191, 280, 281, 282, 283 | 41, 56, 79, 172, 211, 212 |
| `scripts/desktop-remote-ui-smoke/scenarios.mjs` | — | — | — | 9 |
| `scripts/electron-security-native-history.mjs` | — | — | 233 | 114 |
| `scripts/external-links-smoke.mjs` | — | — | — | 10, 11 |
| `scripts/history-autoload-ui-smoke.mjs` | 41 | — | — | — |
| `scripts/login-start-macos-acceptance.mjs` | — | — | 146 | 7, 106, 311 |
| `scripts/orchestration-import-bench.mjs` | — | — | — | 2, 220 |
| `scripts/overlays-ui-checks.mjs` | — | — | — | 79, 80, 81 |
| `scripts/owned-app-processes.test.mjs` | — | — | — | 45 |
| `scripts/publish-cli-internal.test.mjs` | — | — | — | 74 |
| `scripts/recorder-engine-bench-fixtures.mjs` | — | — | — | 2 |
| `scripts/recorder-engine-bench-report.mjs` | — | — | — | 8 |
| `scripts/recorder-engine-bench.mjs` | — | — | — | 2 |
| `scripts/recorder-engine.measurement.test.ts` | — | — | — | 266 |
| `scripts/recorder-quiet-revisit-bench.mjs` | — | — | — | 2, 59, 81 |
| `scripts/recorder-record-summary-bench.mjs` | — | — | — | 2, 35, 49 |
| `scripts/remote-trace-read-frequency.mjs` | — | — | — | 8, 9, 10 |
| `scripts/scry-cli-wrapper.test.mjs` | 22, 23 | — | — | — |
| `scripts/sidebar-activity-ui-continuation.mjs` | 114 | — | — | — |
| `scripts/smoke-app-entries.mjs` | 250 | — | — | 121 |
| `scripts/steer-ui-smoke.mjs` | 90 | — | — | — |
| `scripts/unified-conversation-smoke.mjs` | 196 | — | — | — |
| `scripts/workspace-numstat-bench.mjs` | — | — | — | 76 |
| `scripts/workspace-session-ui-checks.mjs` | 180 | — | — | — |
| `src/core/turn-recorder/recorder-quiet-revisit.test.ts` | 46, 119, 135 | — | 99 | 108, 109, 194 |
| `src/core/turn-recorder/recorder.ts` | 325 | — | — | — |
| `src/core/turn-recorder/store-summary.test.ts` | 141 | — | — | 62 |
| `src/daemon/host-metrics-p95.test.ts` | — | — | — | 4 |
| `src/daemon/host-metrics-parsers.ts` | — | — | — | 137, 138 |
| `src/daemon/host-metrics.test.ts` | — | — | 115 | — |
| `src/daemon/host-metrics.ts` | — | — | — | 52, 312 |
| `src/main/background-task-control.ts` | — | — | — | 9 |
| `src/main/bootstrap/daemon-launch.ts` | — | — | — | 78, 79 |
| `src/main/bootstrap/daemon-run-lazy.ts` | — | — | 17 | — |
| `src/main/bootstrap/daemon-run-mode.ts` | — | — | — | 53 |
| `src/main/bootstrap/known-project-daemon.ts` | — | — | — | 12 |
| `src/main/bootstrap/mcp-channels.ts` | — | — | — | 14, 15, 16, 17, 18 |
| `src/main/bootstrap/query-channels.ts` | — | — | — | 99 |
| `src/main/bootstrap/terminal-channels.ts` | — | — | — | 6, 7, 8, 9 |
| `src/main/bootstrap/terminal-daemon.test.ts` | — | — | 54 | — |
| `src/main/bootstrap/workspace.ts` | — | — | — | 105 |
| `src/main/providers/acp-client.ts` | 132 | — | — | — |
| `src/main/providers/antigravity-catalog.ts` | — | — | — | 180, 330 |
| `src/main/providers/antigravity-events.ts` | — | — | — | 27 |
| `src/main/providers/antigravity-launch.test.ts` | — | — | 199 | — |
| `src/main/providers/antigravity-launch.ts` | 298, 330 | — | — | 370 |
| `src/main/providers/antigravity-mcp-paths.ts` | — | — | — | 69, 259 |
| `src/main/providers/antigravity-run.test.ts` | — | — | 172 | — |
| `src/main/providers/catalog-performance.test.ts` | — | — | — | 11, 12 |
| `src/main/providers/fixtures/fake-agy-acp.mjs` | 39 | — | — | — |
| `src/main/providers/host-continuation-identity.ts` | 9 | — | — | 277 |
| `src/main/providers/private-mcp-config.ts` | — | — | — | 88, 111 |
| `src/main/providers/provider-warm-pool.ts` | — | — | — | 113, 114 |
| `src/main/providers/qoder-launch.ts` | — | — | 68 | — |
| `src/main/providers/smoke-history-reader.test.ts` | — | — | 76 | — |
| `src/main/providers/smoke-history-reader.ts` | — | — | — | 15 |
| `src/main/providers/smoke-scenarios.ts` | — | — | — | 82, 83, 84 |
| `src/main/providers/smoke.ts` | — | — | — | 70, 71 |
| `src/main/remote/desktop-attachments.ts` | — | — | — | 194 |
| `src/main/remote/desktop-client-trace-delta.test.ts` | — | — | 107 | — |
| `src/main/remote/desktop-host-reader.fixtures.ts` | 11, 12 | — | — | — |
| `src/main/remote/desktop-host-reader.test.ts` | — | — | — | 121 |
| `src/main/remote/desktop-host-reader.ts` | — | — | 222, 223 | — |
| `src/main/remote/desktop-lane-channel.ts` | — | — | — | 20 |
| `src/main/remote/desktop-lane-real-host.test.ts` | — | — | — | 104, 105, 106 |
| `src/main/remote/desktop-lane.ts` | 90, 91, 92, 93, 175, 176, 187, 188 | — | — | — |
| `src/main/remote/desktop-long-poll.test.ts` | 50 | — | — | 49 |
| `src/main/remote/desktop-trace-delta-hints-controls.test.ts` | 58 | — | — | 57 |
| `src/main/remote/desktop-trace-delta.ts` | — | — | — | 55, 56, 57, 62, 63, 64 |
| `src/main/remote/history-reader.ts` | — | — | — | 151, 152 |
| `src/main/remote/host-controller-surface.ts` | 30 | — | — | 27, 28, 29, 31, 254, 255 |
| `src/main/remote/host-controller-types.ts` | 20, 21 | — | — | 171, 172 |
| `src/main/remote/inner-mtls-dispatch.ts` | 287 | — | 288 | — |
| `src/main/remote/pairing-file.ts` | — | — | — | 94 |
| `src/main/remote/pairing-retention.test.ts` | 187 | — | — | 186 |
| `src/main/remote/pairing-state.ts` | 42, 43, 148, 151, 152 | — | — | 1, 2, 3, 4, 149, 150 |
| `src/main/remote/pairing-transport.test.ts` | — | — | — | 82 |
| `src/main/remote/pairing-transport.ts` | 21, 22, 23, 24 | — | — | 96 |
| `src/main/remote/remote-host-service-deps.ts` | — | — | — | 70, 71, 72 |
| `src/main/session-diff.test.ts` | — | — | 872, 873 | — |
| `src/main/text-spool.ts` | — | — | — | 82 |
| `src/renderer/components/MachineMeters.tsx` | — | — | — | 40 |
| `src/renderer/components/TargetMetrics.tsx` | — | — | — | 1 |

## Follow-up grouping

The 31 evidence tokens were reviewed against callers and assertions at `690953433`. These are internal review IDs, not issue numbers. The table records the disposition; it does not claim that any additional behavior was reproduced or fixed.

| Review IDs | Tokens | Disposition |
|---|---:|---|
| 8, 31, 42, 111, 117, 204–205 | 7 | Corrected test prose. The fixtures establish eligibility after deferral, selected acknowledgement and publication paths, changed-content rejection, and liveness at the asserted checkpoints. They do not establish post-deadline reads, end-to-end renderer delivery, or unobserved process transitions. Assertions stayed unchanged. |
| 200 | 1 | Already tracked by [#197](https://github.com/bingjiang0611/scry/issues/197). Cache reuse alone does not establish the sampling floor or concurrent behavior. |
| 81–82, 85 | 3 | Separate smoke validation: bind artifact evidence to the intended commit, and compare a run-scoped expected output marker across the renderer and worker. Layout and version checks, and nonempty output, are narrower evidence. |
| 92–94, 96–98, 101–104 | 10 | Separate benchmark validation: distinguish observed readiness from an elapsed wait budget, then measure bind latency under controlled App lifetime and daemon history. Existing samples are not a regression verdict. |
| 166 | 1 | No index-reuse claim from repeated page reads. Add a fresh-reader test only if persisted index reuse is an acceptance requirement. |
| 18, 120, 124–125 | 4 | Separate test validation: define the launch paths covered by a stop hold, assert that invalid input is rejected before dispatch, and define the trace timing observation separately from delivery. |
| 87–88, 118, 160, 172 | 5 | Retain existing safeguards and route any additional validation through a private defensive review. No security failure was reproduced or reported publicly by this pass. |

The six source files in the prose batch match after comment removal, including emitted JS and tool directives. Thirty distinct focused tests passed. The standalone ratchet timed out under host load; the same `addedProse` predicate passed on all 288 scoped changed files against `e3355f86` using a batched Git read. No live smoke or benchmark ran.
