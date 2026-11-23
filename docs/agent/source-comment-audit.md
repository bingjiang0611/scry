# Source-comment audit coverage

**Status: in progress.** [PR #143](https://github.com/bingjiang0611/scry/pull/143) is the cleanup branch. The goal is a disposition for each first-party source comment, not a zero-comment repository. The Git ratchet only covers `src/cli/`, `src/shared/`, and `src/core/turn-recorder/`.

## Verified slices

| Scope | Contextual review and disposition |
|---|---|
| `src/cli/`, `src/shared/`, `src/core/turn-recorder/`, `src/preload/` | Previous audit plus the upstream refresh in `cbc6bbbe`. No remaining prose in the current JS/TS inventory. Required tool comments remain. |
| `src/daemon/` and `src/host-runtime/` | Review pinned to `cbc6bbbe`. All 113 daemon and 53 host-runtime prose tokens received dispositions. `424ce862` removed 58 redundant or stale tokens; the rest include rationale to migrate, native constant labels, and comments retained pending follow-ups. |
| `src/renderer/components/render-tests/` and `src/renderer/components/ChatTranscriptTurns.test.tsx` | Review pinned to `56cae030`: 57 tokens in 38 inventoried files. `3bfd3631` removed or migrated 44. The other 13 remain for regression rationale or stronger test evidence. |
| `src/main/` trace router, history, archive and metering slices; renderer chat, composer, and remote-chat slices | The reviewed paths are bounded by the corresponding batches in PR #143; these are not whole-directory reviews. `cf900f90` covers the trace router and its two test files. `804d5ab7` and `feaa5099` cover the daemon frame transport, wake signals, byte-chunk reader and terminal archive regression. At `feaa5099`, the runtime and subscription review assigned dispositions to 164 tokens in 19 files (including their directly related tests); the comment-only cleanup applies the redundant subset. |
| Tracked first-party Python | Review pinned to `cbc6bbbe`: 15 files, 32 prose tokens, and 15 shebangs. Three files changed only by redundant prose removal. The offline iOS checks were not run; [#181](https://github.com/bingjiang0611/scry/issues/181) tracks two broken verification paths. |
| `.github/`, root/build tooling, and `scripts/check-*` / `scripts/ci-*` | Contextual review pinned to `56cae030`. Keep licensing, action provenance, and verification boundaries; inventory-only `removable` is a count of comment-only physical lines, not an eligibility verdict. This does not cover the rest of `scripts/`. |
| iOS Swift | Contextual review pinned to `56cae030` for 11 files under `apps/ios/ScryRemote/`: `ChatView`, `Components`, `ConversationCopy`, `ConversationMarkdown`, `ConversationScrollView`, `ConversationTransitions`, `ConversationTurns`, `RunStore/RemoteRunStoreRunEvidence`, `SessionTranscriptPresentation`, `SessionTranscriptView`, and `Sheets/SessionOverviewSheet` (all `.swift`). Other Swift files remain open. No iOS build or device run was claimed. |
| Overview renderer | At `feaa5099`, the `Overview*` and `overview-*` component review assigned dispositions to 33 groups in 9 production files and one direct test. Removed 18 redundant, stale or already-documented tokens. The Git-only expansion mismatch is tracked separately in [#183](https://github.com/bingjiang0611/scry/issues/183); it was found by static review, not UI verification. |
| ABAB and import-boundary scripts | At `feaa5099`, all 9 tracked files matching `scripts/performance-abab*`, `scripts/main-import-boundary*`, and `scripts/validation-*` were reviewed, including their tests and JSON baseline. No `scripts/validation-*` files matched. |
| iOS run store | At `feaa5099`, 21 of the 33 remaining `RunStore/` Swift files were reviewed in context (167 groups, including one retained `MARK`). The other 12 files were not reviewed in that pass. |
| Shipped Pi JavaScript | Reviewed all 25 comment tokens in the two tracked JS files under `packages/` and `resources/`. Removed two duplicate lines about CLI selection; retained the signal, receipt, usage, and local history-launch contracts in context. |
| Provider adapters | Contextual review pinned to `56cae030` for the Antigravity adapter and ACP transport, plus the shared Provider registry and run-control helpers (28 files including tests and fixtures). This does not cover the other adapters. |

## Inventory and remaining work

At `424ce862`, the parser found 13,497 comment tokens in 2,619 tracked JS/TS files, excluding `docs/`, `third-party/`, `fixtures/`, and `experiments/`. There are 16,749 physical comment-only lines before exemptions. These include retained and unreviewed comments, so the count is not a deletion estimate. `src/main/` (7,475 prose tokens), `scripts/` (4,180), and `src/renderer/` (1,625) are the largest remaining pools; parts of those pools are already reviewed. Swift, CSS, shell and config sources are not covered by this TypeScript inventory.

```sh
node scripts/check-source-comments.mjs --inventory -- . ':!docs/' ':!third-party/' ':!fixtures/' ':!experiments/'
```

Continue with the remaining startup and Provider adapter sources in `src/main/`, renderer components not listed above, unswept scripts, and the other Swift and non-JS/TS sources. Keep non-JS/TS coverage separate and inventory actual comments with the language's lexer. Route implementation changes to issues, not this PR; for example [#180](https://github.com/bingjiang0611/scry/issues/180) tracks recovery of a recorded dispatch without verified body evidence. Mark a slice complete only after its tokens have a contextual disposition, and refresh the slice if upstream changes it.
