# Same-root revision foundation — bounded validation

This is a bounded implementation increment, **not M3 or M1–M6 acceptance**. The implementation worker wrote source only. The parent subsequently ran the checks below; dynamic controls and production revision UI/IPC remain open.

## Implemented seam

`WorkflowService.revise(preview, approval, { expectedRevision }, commandId)` is main-only. It validates the complete frozen candidate, current runtime capabilities, root settlement and observed state version. It enters the existing Runner → Interpreter; it does not create a scheduler, replacement root, IPC command/path surface or synthetic Provider outcome.

A revision claim appends an epoch/control segment and a governing revision snapshot. File storage writes content-addressed immutable governing artifacts before atomically publishing their references in the root manifest. Existing intents, outcomes, system ledgers, approvals and prior programs remain historical facts. Missing or hash-invalid governing artifacts fail closed. Legacy roots without revision artifacts remain readable; their untouched first revision is retained without inventing an earlier approval.

The root keeps its ID, non-refundable 1000-intent budget, existing per-revision logical task identities/six-attempt ceiling, 256 control-segment limit and 16384 system-effect ceiling. No new revision is admitted while any historical intent lacks an outcome, any scope is unsettled or any historical business outcome is unknown, including removed nodes. Stop receipts do not establish settlement. Existing same-program continuation equality is unchanged; a program change is accepted only by the explicit revision/CAS branch retaining the complete prior snapshots.

## Bounded historical result reuse

Supported revision programs contain only static `sequence`, `parallel`, `call`, `bind`, `return`, without replica calls. Static dependencies include call input references, bind expression references and consumed container outputs. Local definitions, transitive effective IR inputs, workspace/goal and full frozen role/runtime identity must match. Mere launch-order changes do not invalidate independent call facts. A changed B invalidates B and an actual consumer D, not independent A/C.

A reusable call must also have a canonical admitted, observed-model, settled successful outcome; a main-issued completed control frame and hash-verified output/value; and matching main-observed workspace manifests before/after the original call and again at new consumption. Requested/observed model aliases that cannot be shown equal are conservatively not reused. Original attempt/frame/value/revision provenance is retained. No new attempt, usage, external receipt, zero cost or fresh Provider execution is invented.

Production `WorkflowSystemHost` automatically observes ordinary Agent inputs. Before evidence is saved before executor invocation; after evidence is acquired only after scope settlement. Scanner/metadata/observation failures are explicitly unavailable and do not block an otherwise admissible original Agent call. They forbid reuse. Roots without a main Host and old records without these observations are not reusable. Missing/corrupt artifacts that claim availability reject revision recovery instead of rerunning under fake evidence.

Repository HEAD/root metadata uses the existing read-only, environment-scrubbed Git transport; non-repository directories need no Git CLI. The existing bounded manifest scanner excludes `.git`/`.scry` content and rejects unsupported links/entries. Git revision observation supplements those exclusions; it is not a complete Git config/index/recorder read-set.

**These observations do not prove read-only execution, absence of external effects, a sandbox, exact file read-sets, or freshness of undeclared network/outside-workspace inputs.** Reuse means a bounded historical result under matching declared IR inputs and observed workspace/runtime, not a statement that external facts are current. Native trust/fingerprint checks remain in the original App execution chain for every newly dispatched call. Catalog runtime identity and workspace observations do not attest external executable/config freshness. This ordinary result reuse cannot mint replica/path authority or supply a current quality-check/independent-verification pass.

## Explicit limitations and next seam

- Dynamic `map/branch/loop/collect`, check/replica/verification revision programs explicitly reject; no generalized dynamic-consumer invalidation is claimed.
- Any observed ambient workspace change can prevent all reuse. This is deliberately coarser than an exact Provider read-set.
- Unchanged admitted failures/stops without canonical pre-Provider non-dispatch proof cannot be replayed merely by changing another node/revision. Generic failure restart, watchdog/stall recovery and replay of unknown external effects remain unsupported.
- The Service method has no renderer/preload/UI wiring or candidate-planning endpoint yet. Existing snapshot, list, check, verification and control endpoints are retained.
- Observation I/O and Git metadata cost need parent performance measurement. Scans are bounded by the existing scanner limits but are additional work on call admission/settlement and reuse consumption.
- Full revision snapshots are immutable artifacts; hydrated reads and journal/value artifacts still enforce existing size limits. This is not unlimited history storage.

For a dynamic extension, keep the existing revision namespace for newly expanded frames and retain original successful item facts separately. Derive dependencies from actual committed branch/iteration/collection references and stable item keys, not array positions or old whole-revision input keys. Revalidate sealed manifests and effective consumer inputs before importing a fact. Until those authorities and invalidation tests exist, keep dynamic revisions unavailable. Owned-copy/quality results additionally need typed source/output/verification authorities, not ordinary Agent reuse.

## Parent verification

- Node/web typechecks passed. Serial current Workflow suite: **42 files, 464 tests passed**,175.87s,10cores,load11.47→10.01/highLoad=true. A subsequently added targeted stable-after counterexample passed; the combined465-case suite has not yet been rerun. Full build + production conversation IPC and Chromium Workflow UI passed on the same runtime sources. These App checks retain old entrypoints; they do not prove a revision UI/IPC that does not exist.
- First check exposed a method left in the wrong Service split layer; moved `planningSettled` to the shared lifecycle foundation. Scheduler fixtures had placeholder revisions/noncanonical root bodies or Pi profiles. They now normalize/hash the same canonical program shape, add the required terminal return/profile IDs, and retain all dispatch/stop/output assertions. Early14/12 fixture failures and their5000ms waits are preserved in logs; production validation was not weakened.
- The1000-attempt case then genuinely exceeded its original5000ms deadline (7992ms,6496ms). CPU profile identified repeated immutable governing-program validation/serialization and snapshot AST cloning. Validated programs and governing histories now deep-freeze once; a weak identity cache stores their exact serialization. Private MemoryStore snapshots share only these verified immutable parts; public loads still clone. Fresh loads, replacements, outer identity and journal fences remain checked. This is one hypothesis, not a collector/workload or timeout change. Tests prove deep freeze including previously shallow-frozen objects, tamper/clone/replacement rejection and public-load independence. A later controlled case was2881ms,load8.41/highLoad=false; broad suite passed at high load. No App-wide speedup/L3 claim.
- First negative targeting writers was insensitive because every call changed the workspace, also exercising the separate current-hash guard. Added a serial counterexample where only A writes and its final bytes remain current: with before==after protection it dispatches A/B/D again and reuses only C. Disabling that exact predicate makes it fail (negative exit1); original source restored byte-identically. Real temporary Git test proves HEAD changes are observed even with identical workspace file bytes.
- Logs and CPU profiles: `/tmp/scry-workflow-template-editor.ZnkC6L/m3-revision-*`. No assertion/deadline/gate relaxation, no real Provider involved in these Workflow checks. The separate approved real Jev transport probe uses only integer7 and is not App/M6 acceptance. Historical unrelated CLI/seven deferred gates and missing providers.catalog collector are not closed by this suite.

### Retained validation commands

1. `npm run typecheck`
2. `npm run test:unit -- src/main/workflow-revisions.test.ts src/main/workflow-retry.test.ts src/main/workflow-recovery.test.ts src/main/workflow-recovery-process.test.ts src/main/workflow-store.test.ts src/main/workflow-service.test.ts src/main/workflow-runner.test.ts src/main/workflow-control.test.ts src/main/workflow-input-snapshot.test.ts src/main/workflow-system-agent.test.ts src/main/workflow-system.test.ts`
3. Source-named negative controls for revision CAS, historical unknown, source observation and successful-sibling reuse; existing deadlines/acceptance assertions stay unchanged.
4. `npm run build`, `git diff --check`, file-size/import and independent review gates, then relevant performance/production IPC gates under the parent delivery plan.

The new test source covers static B/D invalidation with A/C reuse, reordered siblings, bind consumers, changed/missing workspace evidence and runtime, observations unavailable without blocking original execution, old unknown/unsettled/intent-only removed nodes, concurrent claims and cold receipt deduplication, approval/CAS/program tampering, missing/tampered governing artifacts, root budget preservation and the six-attempt ceiling in a new revision. Remaining acceptance must cover the explicit limitations above; these passing static checks do not satisfy them.
