# Proposal A: selected Provider discovery (2026-10-21)

Scope: isolated worktree `perf/provider-control-20261021T115356Z`, offline/local fixtures only. No App installation, Provider account, phone device, or user data was used.

## Change

- `providers` metadata requests return descriptor/profile rows without control probes.
- A selected request carries `providerId`, optional `agentProfileId`, and the requested cwd. The host checks peer authorization, provider/profile metadata, and canonical workspace before calling the adapter.
- Desktop and iOS request metadata for the picker, then request controls only for the selected context. The old omitted-detail request remains an explicit all-controls compatibility path.
- Selected reads deduplicate identical in-flight context requests only. Results are not retained after completion; adapter-owned freshness/reload rules remain authoritative.
- A failed selected read is represented as unavailable and cannot enable submit. Late renderer/iOS replies are fenced by the selected context/generation.

## Evidence

The baseline commit was inspected directly: `src/main/index.ts:4774-4784` used `Promise.all` over every descriptor/profile and called `providerRegistry.runControls` for each snapshot refresh. This is the negative-control behavior removed from the new metadata path.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed (Node + web TypeScript) |
| Focused remote/preload/renderer tests | Passed: 5 files / 91 tests |
| Selected gateway negative controls | Metadata list did not call selected adapter; unauthorized provider and malformed cwd were rejected before selected callback |
| Desktop selected request | Focused client test observed `{op: "providers", detail: "selected", providerId, cwd}` |
| Same-context dedup | `provider-discovery.test.ts` proves one operation, independent contexts proceed, and failed/completed entries are removed |
| Swift package build/tests | Built transport changes; existing package test run hit the retained pre-existing `TLSLayerTests.testNoHostCloseAfterWebSocketUpgradeRetainsItsCause` fatal leaked-promise failure. No retry is claimed. |
| Locked timing harness | Ran `provider-discovery-focused`; 38 tests passed, wall 2547 ms, `highLoad: true` (load 28.43→28 on 10 cores). L2 timing is unavailable and no latency conclusion is drawn. |
| Build/install | No production build or install by request. |

`highLoad` and L2 timing are therefore unavailable, not zero or an inferred improvement. No performance budget or ratchet was changed.
