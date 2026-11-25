# Source comment audit — final dispositions for the two upstream deltas

At `840f77cd`, 87 remaining candidates matched exactly by file and comment text in the [repository-location and analytics delta](source-comment-audit-675733ea.md) and the [Codex usage-baseline delta](source-comment-audit-5a5914c4.md). IDs below refer to those reports. The decisions cover these candidates, not every historical follow-up from the whole-repository audit.

| Report | Keep local | Revise | Move to existing ADR | Separate validation |
|---|---|---|---|---|
| `5a5914c4` | 2, 3, 35–37, 43, 44 | — | 19, 20, 27, 28 | 13, 15, 40 |
| `675733ea` — Recorder | 32, 33, 42, 43, 49, 50, 52, 54, 56, 59, 60, 63, 64 | — | — | 40, 41, 46, 53 |
| `675733ea` — main and shared | 151, 153, 154, 159, 161–163, 170–172, 175, 176 | 78, 79, 83, 85, 86, 91, 92, 95, 97, 99 | 167–169 | 101, 112, 117, 147, 148, 157 |
| `675733ea` — other | 1, 3, 6, 16–19, 21, 24 | 10, 11, 65–70, 127–129, 132, 135, 136 | — | 7, 138 |
| **Total** | **41** | **24** | **7** | **15** |

[ADR 013](../adr/013-turn-record-evidence-contract.md) carries the writer allowlist rollout rationale; the fixture still asserts the fixed reason and absent code. [ADR 021](../adr/021-usage-observation-and-billing.md) carries the usage analytics grouping decision and distinguishes legacy inference from provenance. Recorder and shared changes delete only the migrated comments. Analytics comments now separate fixture data, what tests actually assert, and read-time estimates.

Nine initially revised UI smoke tokens were restored. The campaign serializes the enclosing functions, so these comments must keep their exact upstream bytes. They are not evidence for the statements in their text.

Separate validation candidates are not reproduced defects. The open questions are usage-baseline evidence, repository-location timing, analytics grouping and cost evidence, and chart test coverage. Preserve the existing local guardrails. Defensive review of evidence placement stays private; this pass makes no claim of a security failure.

Exact edit replay, comment-free source, emitted JS/JSX and tool directives matched in 19 source files. The source comment ratchet passed against `e3355f86`; 304 focused tests passed, including the two affected Recorder cases through `recorder.test.ts`. No live smoke, packaged build, or benchmark was run locally for this batch.
