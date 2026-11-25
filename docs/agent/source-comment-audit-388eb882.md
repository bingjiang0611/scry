# Source comment audit — wording and evidence candidates at 388eb882

All 209 candidates from the seven-report ledger matched exactly by path and comment text at `388eb882`. The contextual review found 40 useful explanations, 138 wording candidates, and 31 follow-up candidates. These counts are tokens, not issues. A follow-up flags a claim to verify against code or a test oracle; it does not establish a reproduced defect.

The first cleanup batch handles six wording candidates and preserves one adjacent rationale in revised wording. It corrects what a history page proves about I/O, distinguishes redirected daemon output from the consumed child event, describes partial process-table output accurately, and removes a comment that described the spool cap as a sum. The four changed files have matching comment-free source and emitted JavaScript. The comment gate and 30 focused tests passed.

At `906adb081`, the second batch resolved 38 of the 132 remaining wording candidates across 20 files. It distinguishes measured arrivals from inferred causes, fixture actions from assertions, and reused trace hashes from newly hashed suffixes. The 25 comment groups touched 50 source lines before and 45 after. Exact edit replay, comment-free emit, unchanged directives, the ratchet, and 58 focused tests passed. No packaged smoke or benchmark was run for this batch.

At `f1f268fb`, the third batch handled 64 of the 94 remaining wording tokens across 39 files. The changes distinguish fixture evidence from production guarantees, including packaged artifact selection, startup timing, Recorder caches and machine metrics. Exact edit replay and comment-free emit matched; the comment ratchet and 75 targeted tests passed. The 30 remaining tokens include trust-related rationale that needs care in shortening and claims that require separate validation. No live smoke or benchmark was run.

At `c104dd5b`, closed the remaining 30 wording decisions: 22 revised and eight retained for their local fixture or authority rationale. A separate ADR reconciliation closed 20 exact wording tokens (19 grouped review entries; the Qoder note contains two tokens). The combined changes cover 14 source files; exact edit replay, non-comment source, emit, directives, the ratchet, and 211 focused tests passed. No runtime or assertion changes were made. The 31 evidence follow-up tokens in this ledger are separate.

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
| `scripts/steer-ui-smoke.mjs` | — | — | — | 90 |
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

- **Recorder and session evidence:** separate predicate results, actual recovery reads, and UI publication. A fixture that collects events does not prove production delivery or reload behavior.
- **Timing and packaged validation:** distinguish observed readiness from expired waiting, layout and version checks from freshness, and repeated reads from proof of index reuse. Preserve the benchmark record without claiming unmeasured latency.
- **Host and Provider checks:** distinguish test fixture setup from independently asserted cleanup, output attribution, or identity.
- **Metrics and remote history:** separate local cache and sampling behavior, the contents of a page, and when text was actually delivered. Keep existing trust and redaction requirements in place pending defensive review.

See [issue #192](https://github.com/bingjiang0611/scry/issues/192) for spool short writes and [issue #197](https://github.com/bingjiang0611/scry/issues/197) for overlapping metrics sampling. This comment pass did not change either behavior.
