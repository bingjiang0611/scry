# Main entry split status

`src/main/index.ts` is the only currently changed/new authored file over the 20,000-byte budget, and `scripts/check-staged-file-size.mjs` does not grandfather existing files: any commit that stages it is blocked. It was 226,103 bytes (4,734 lines) at HEAD `c9386b6` plus WIP. The earlier seven-module checkpoint was 200,990 bytes; current size after the IPC, recovery, edit preparation, run-diff, session-publication and template-edit receipt-history increments is **159,738 bytes**, with **0** direct literal trusted-handler registrations. The Main-owned trusted wrapper still registers all extracted handlers. This file still blocks staging-ready delivery.

## Extracted so far

| Module | Bytes | Contents | Proof |
| --- | --- | --- | --- |
| `src/main/provider-trust.ts` | 11,197 | Codex Hook trust, OpenCode project plugin trust, recorder commit hook environment, MCP execution authorization (235 lines) | Moved text identical to the original except eight injected dependencies; `npm run typecheck` passes; 73 trust/registry tests pass; actual App run passes with five synthetic Provider calls and six ownership refusals |
| `src/main/terminal-ipc.ts` | 5,486 | Eleven `terminal:*` trusted handlers (94 lines) | Moved text identical except four injected reads; `npm run typecheck` passes; 44 terminal/trust tests pass; the same actual App run passes |
| `src/main/app-ipc.ts` | 1,804 | Four `app:*` handlers (theme, clipboard, performance sample) | Moved text identical except the window getter; typecheck passes; covered by the same App run |
| `src/main/workspace-ipc.ts` | 5,827 | Thirteen `workspace:*` handlers including the ambiguous same-path chooser | Moved text identical except seven injected reads; typecheck passes; 48 workspace/home-file/chrome tests pass; same App run passes |
| `src/main/agent-context-ipc.ts` | 3,742 | Seven `agent:*` context handlers: provider descriptors, recent folders, folder choice, clipboard image, `setCwd`, `newSession` | Moved text identical except seventeen injected reads; typecheck passes; 61 store/registry/badge/history tests pass; same App run passes |
| `src/main/mcp-ipc.ts` | 7,398 | Four `agent:*` MCP handlers: snapshot, test, reauthenticate, guard scan (104 lines) | Moved text identical except seventeen injected dependencies; typecheck passes; 60 MCP/OAuth/registry/trust tests pass; same App run passes |
| `src/main/remote-ipc.ts` | 2,363 | Eight `remote:*` pairing handlers plus `requireRemoteHost` | Moved text identical except the host-service getter and one single-read status branch; typecheck passes; 17 remote/trust tests pass; same App run passes |

These modules receive dependencies explicitly. No extraction grants new authority, widens a channel or intentionally changes an ownership fence. The table above records the earlier checkpoint, not fresh validation of every path. The first table describes the earlier seven-module checkpoint. Later extractions group synchronous registrations; they do not execute handlers at registration. Live getters preserve current window, recovery and run authority rather than registration-time snapshots.

## Current extracted modules after further IPC increments

| Module | Current bytes | Scope |
| --- | --- | --- |
| `session-catalog-ipc.ts` | 5,681 | Eleven project/session catalogue and metadata handlers; local and remote callers share the live ownership/adoption barrier |
| `provider-discovery-ipc.ts` | 6,068 | Four discovery/Pi-profile handlers; retains two-phase discovery, cached discovery lifetime, RPC handshake and live store/window/cwd getters |
| `session-fork-ipc.ts` | 5,719 | Legacy fork handler; retains operation lease, current startup recovery, both ownership checks, trust snapshots, archive boundary and post-fork publication order |
| `analytics-ipc.ts` | 1,950 | Eight analytics/performance/billing handlers with the same queries and live userData/run getters; no query runs at registration |
| `agent-context-ipc.ts` | 4,799 | Original context handlers plus four provider capability/context operations |
| `run-ipc.ts` | 5,580 | Thirteen run start/observation/control handlers; completion, physical settlement and stop acknowledgement remain separate |
| `session-deletion-ipc.ts` | 14,040 | Two deletion handlers and the shared deletion helper, with canonical ownership, recovery, live unsettled-run and deletion fences |
| `recorder-content-ipc.ts` | 1,790 | Source/reference-based content reads and workspace rechecks; no arbitrary renderer path authority |

The child performed source maintenance only. Parent typecheck first caught a missing normalizer dependency; the fork module now imports the existing pure normalizer directly instead of injecting it. Newly moved dialog/error text is in dedicated shared copy modules. Parent then ran the checks below; child completion alone was not treated as proof.

`ConversationStore` now owns its fork lifecycle methods (`findFork`, `beginFork`, `finishFork`) instead of its storage foundation. Exact method bodies use the same inherited admission/ownership/persistence state. This also resolves the newly found 20,616-byte foundation blocker: foundation **15,814 bytes**, concrete store **16,682 bytes**. Planning-route record validation now lives alongside the existing store artifact validators, with the same checks and centralized error text; `workflow-store.ts` is 19,169 bytes. The full changed/untracked-file scan currently finds only `index.ts` above 20,000 bytes.

Parent evidence at the earlier 193-test checkpoint (superseded for current Main source; see next section):

- Typecheck and production build pass. Focused submission/routing/consent/receipt/catalogue/discovery/fork/performance suites: **20 files, 193 tests passed** after the template-edit/analytics increments. Earlier store/fork/ownership regression: **8 files, 106 passed**, before the subsequent discovery/fork move; do not sum overlapping runs.
- Production ownership IPC after all three extractions: six owned/orphan refusals, three unowned controls, exactly two offline operations, retained startup-failure publication, committed archive/workspace output and restart readback. This exercises the moved legacy fork handler, not a real Provider account.
- Current routing/composer App evidence: `scry-workflow-mode-app-zyCUoP/routing.json` (manual/auto routing, unapproved drafts, one-shot controls, source-aware template edit and cold no-replay); command UI fixture: `scry-conversation-readback-g1vqsT/result.json`.
- Negative catalogue ownership control: disabling only the live adoption check makes the focused test fail (`/tmp/scry-session-catalog-negative.log`). No weakening of sender/frame/origin registration is intended; those checks remain on the production wrapper.
- Production analytics reads after extraction return ready stats/7-day analytics, reject an invalid range, return history/live shapes and cause zero additional Provider calls. Remote billing sync/import were not driven. Credits UI fixture (real temporary SQLite/archive, scripted bridge) passes; it is not proof of every Main billing handler.
- Existing `analytics.stats` counter fixture: five runs, one JSON stringify each, ratchet passed (`/tmp/scry-analytics-ipc-performance/measure.json`). This is transfer-workload evidence, not real App query latency or a speedup. No workload/ratchet/deadline change.
- Existing performance collectors for `navigation.catalog` and `send.codex-fixture` report **unavailable** (no matching collector), not zero/pass. No workload, ratchet, deadline or profiler was changed; no speed claim is made.

## Run/deletion/recorder checkpoint (before recovery extraction)

- Typecheck and production build pass. Combined regression: **36 files / 328 tests passed**, with the original deadlines (`/tmp/scry-zero-inline-ipc-regression.log`). New tests cover duplicate start receipts, live focus/adoption, completed-but-unsettled snapshots, question sender/broker identity, stop acknowledgements, recorder workspace changes, and deletion admission/cancellation.
- Negative controls fail when the question sender check or the recorder post-location workspace check is removed. Both protections were restored. The production wrapper rejection suite also covers start, questions, recorder reads and both deletion channels, and proves the privileged listener is not invoked.
- Current production App log: `pi-bash-a18d20d0367506a7.log`. Ownership: six refusals, three positive controls and exactly two offline operations. Routing: `scry-workflow-mode-app-OdITJP` preserves manual/auto/override/template-edit/cold readback and ten final offline calls. Native stop: `scry-workflow-node-stop-app-xo2vdj` proves one real fixture process ran, its registered stop scope settled, the process was absent, and the source stayed unchanged. Native question/badge fixture also passed in a foreground isolated instance. These are not real Provider/account probes.
- Parent fixed the source-only child's early `runs` read and incorrect Set type with a live unsettled-runs getter and the existing Map contract. The temporary two-step deletion forwarding variable was removed; conversation calls directly close over the one registered helper. Moved UI/error copy is centralized without changing messages/codes.
- The artifact-equality check after final type-only narrowing did not match Main bytes. Build identity hashes all `src` files, including tests (`performance-build-id.ts`), so source/test changes alter identity even when erased types do not alter behavior. No byte-equivalence claim was made: all four App probes were replayed on the final rebuilt artifact. Initial new-test type/receipt-status mistakes were corrected against their existing contracts; no deadline or production contract changed.
- `controls.stop-lifecycle` has no matching performance collector and remains **unavailable**, not zero/pass. Host load was high; no speed claim, profiler, workload, metric or ratchet change.

## Startup recording-recovery phase

`app-run-recording-recovery.ts` is **5,740 bytes**. It owns only trace/journal/progress/recorder recovery and returns the same enablement/environment objects plus recovery counts. Main retains the live-owner predicate (including exact native turn identity), admission, blocked-session map, trust checks, run registration and physical settlement. userData and ownership remain live callbacks across recovery awaits. The moved error text is centralized; no new runtime-context, factory or execution loop was added.

- Combined current regression: **41 files / 438 tests passed** (`/tmp/scry-recording-recovery-regression.log`); typecheck and production build pass. Ten new orchestration tests prove authoring exclusion, recovery even when new recording is disabled, ordering, exact snapshot/environment identity, pending maximum rather than addition, live callback/getter reuse, and no provisional abandonment while either canonical layer is pending. Initial fixture typing incorrectly returned undefined from the environment resolver; it now follows the existing `Promise<ProcessEnv>` contract.
- Removing the provisional-abandonment gate makes all three pending-layer controls fail (`/tmp/scry-recording-recovery-provisional-negative.log`); the gate was restored. No deadline or assertion was weakened.
- Against frozen `workflow-ipc-decomposition.by5uzfgr`, all eight moved statements have identical normalized TypeScript ASTs after explicit dependency/getter, type-alias, identical-copy and property-shorthand substitutions (`/tmp/scry-recording-recovery-equivalence.log`). This is phase-body evidence, not whole-function equivalence. The first comparison's shorthand-only difference is retained separately.
- Current isolated production App log: `pi-bash-f2ee5e748c8471e3.log`. Ownership, manual/auto/composer/template-edit/cold readback (`scry-workflow-mode-app-N3cr4l`), native node stop (`scry-workflow-node-stop-app-B70cdJ`) and foreground native questions pass on the rebuilt artifact. Offline adapters do not prove real Provider/account acceptance. Host load was high; no speed claim is made.
- `send.codex-fixture` performance collection remains unavailable: no matching collector. No profiler, cache/prewarm, workload, ratchet or deadline change.

## Last-turn edit preparation

`app-run-edit-last-turn.ts` is **5,315 bytes**. It retains the existing archive/head/previous-boundary checks, native fork, synchronous prefix copy, sole-first-turn reset and interrupted-local-only restart eligibility. Main retains the session maps and synchronous commit callback, captured source identity, admission, trust acquisition, final context/revision/run/deletion fence and later dispatch MCP recheck. Ordinary sends do not invoke or await the helper. Capability/MCP/userData getters remain deferred at the original read points; no retry or fallback was added.

- Typecheck and production build pass (346 Main modules). The initial new fixture incorrectly used a string model; it was corrected to the existing `AgentModelRef { id }` contract. Focused **7 files / 84 tests pass**; ten new cases use actual temporary archive I/O and a mocked native facet to prove exact boundaries, deferred trust/capability reads, synchronous copy→commit, unknown/missing-ID/copy-error no-commit/no-replay, first-turn reset and all-interrupted restart.
- Adding an `await` between prefix copy and commit makes the ordering case fail; the source was restored byte-identically (SHA-256 `ed20e026950a2b1d21aa719538b3ceb2040e796f1e3b8fab21785ef80b6e8d30`). No assertion/deadline/workload was weakened.
- The expanded original-scope regression is **49 files passed / 1 failed; 547 tests passed / 1 timed out at 5000ms** (`/tmp/scry-edit-last-turn-regression.log`). The failing existing `llm-performance-history` corruption/bounds/deduplication case makes 1003 measured appends; its source and both production modules match the verified baseline byte-for-byte. An isolated original-workload diagnostic passes all five cases, but does not erase the 50-file failure or establish its sole cause. Host load snapshot was 39.71/219.75/217.81 on ten cores. No profiler/optimization experiment or timeout change was performed.
- Against the frozen recovery checkpoint, Main outside the phase/import relocation is byte-identical. The remaining phase AST matches after explicit dependencies/getters, identical copy, model/permission forwarding, stable post-I/O facet capture, non-null archive access and separately checked bookkeeping substitution. A wrong-native-prompt in-memory control does not match (`/tmp/scry-edit-last-turn-equivalence.log`). This is scoped evidence, not whole-runtime equivalence.
- Current production routing/composer/template-edit/analytics/cold checks pass in `scry-workflow-mode-app-MY7tPh`; native stop, node-test, policies, exact read-only ledger inspection and cold no-replay pass in `scry-workflow-node-stop-app-c19qQI`. Offline calls remain ten/four, with zero additional calls from inspection. Four/three launches respectively report four registered resources closed each; escaped descendants/remote effects are not proven closed. These replay ordinary sends, not native last-turn forking through a real Provider.
- `send.codex-fixture` collector remains unavailable. App timing wrappers report high host load; no speed claim is made. The then **19,943-byte** source catalogue was subsequently split into an ordered manifest and discovery/interaction data (**438 / 6,699 / 13,418 bytes**), without changing the assembled sixteen paths, operations, sources, exclusions or order. Both fragments and the loader are included in native harness fingerprints. See `docs/performance-catalogue-layout.md`; no benchmark/metric/workload/ratchet was changed.

## Run diff lifecycle

The run-scoped turn/session Git lifecycle now lives in the 9,650-byte `app-run-diff.ts`; Main retains capture start, live session promotion, registration/startup barriers, settlement and physical release ownership. Verification, negative control, production App evidence and limits are in [`run-diff-lifecycle-status.md`](run-diff-lifecycle-status.md).

## Run session publication

The provisional-to-native session publication sequence now lives in the 5,279-byte `app-run-session-publication.ts`. Main retains the session revision predicate, Provider callback registration, settlement and physical release ownership. Focused contracts, the negative control, partial performance evidence and the retained failed native App probe are in [`run-session-publication-status.md`](run-session-publication-status.md).

## Remaining structure

The historical starting point had ninety-four `handleTrusted` registrations. **No direct literal handlers remain in the entry module**; the trusted wrapper and registration wiring remain in Main. The file is still 159,738 bytes because Provider execution, terminal recording and remote-host lifecycle implementation remains there. The following line ranges are historical locations only:

| Group | Line range at `c9386b6` | Handlers |
| --- | --- | --- |
| `app:*` | 856-865 | 4 |
| `agent:*` context, sessions, catalog | 872-1002 | provider/context, MCP, catalogue, fork and deletion handlers extracted |
| `workspace:*` | 1006-1067 | 13 (done) |
| `terminal:*` | 1070-1155 | 11 (done) |
| `agent:*` runs, usage, billing, traces | 1165-3883 | handlers extracted; `startAppRun` and lifecycle logic remain |
| `remote:*` | 4117-4132 | 8 (done) |

The original `startAppRun` region spanned roughly lines 2150-4092; its line numbers have moved, but it still closes over most of the module. Reaching the budget therefore now needs cohesive run-pipeline phase modules, each receiving explicit domain-specific dependencies, not a giant runtime-context or global/bootstrap workaround. Per-domain extraction is mechanical but not free: every group threads dozens of existing closures, and each step needs its own typecheck, focused tests, build and actual App replay.

## Historical verification of the first split

The extractions are behaviour-preserving moves, so the evidence is: text equivalence against the pre-move file, both typechecks, the focused suites named above, the production build, and one actual isolated App run exercising the ownership, desktop-task, authoring, planning-receipt and template workloads (five synthetic Provider calls total, zero added by either extraction). Historical logs are `main-split-*.log` under `/tmp/scry-workflow-task-entry.V7ObQf/` (provider-trust, terminal, app-workspace, remote), retained by the earlier `main-entry-split._ds_nh1h` checkpoint. The earlier store-validation build/UI/ownership/routing log is `/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/pi-bash-fa8874ce04361c03.log`; current-source evidence is listed above. Older archives are not rewritten.

Not verified: the terminal handlers and trust gates are not driven through the real UI or a real Provider in this run; they are covered by their unit suites and by module import at startup. No commit, push, installation, version bump or daily-App restart was performed.
