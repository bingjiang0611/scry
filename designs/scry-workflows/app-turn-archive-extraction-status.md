# App terminal archive responsibility split

Partial M2 prerequisite, following [restricted authoring](workflow-authoring-status.md). This is not complete M2/M1–M6.

`src/main/app-turn-archive.ts` now owns terminal snapshot construction, progress persistence and final archive/managed commit. Main retains lifecycle, active runs, ingestion, dispatch, settlement and the decision to pin an authoring capture policy. Main supplies its App-owned `userDataDir` through the existing archive argument record; no renderer API or arbitrary-path authority was added.

The moved functions retain all managed Recorder guards, authoritative timing/turn-ID requirements, provenance, capture policy, `beforePersist` ordering and progress cleanup. No scheduler, singleton, new dependency, Core change or additional asynchronous boundary was introduced. Fork-prefix cloning remains in Main.

## Evidence

Root: `/tmp/scry-workflow-task-entry.V7ObQf/`.

| Check | Result | Evidence |
| --- | --- | --- |
| Full source comparison | Three complete moved function bodies match, except exports and explicit App data path; type adds only `userDataDir`; all 243 remaining Main statements match except two argument constructors | `m2-app-turn-archive-equivalence.json` |
| Negative source control | An in-memory change to `requireManaged` is rejected | Same comparison script/result |
| Types, tests, build | Node/web pass; 21 files, 257 tests pass; build passes | `m2-app-turn-archive-gates.log` |
| Current isolated production IPC | Original ownership/direct-task controls, authoring configuration challenge, one planning call despite duplication, zero workers and cold metadata/output checks pass with the explicitly synthetic Provider | `m2-app-turn-archive-app.log`; scene `scry-electron-smoke-AeenYv` |
| Existing counter regression | Five original samples: 1 IPC message, 10,536 JSON bytes and 41 parses; ratchet passes | `m2-app-turn-archive-counter/measure.json` |

The counter uses the existing `archive-turns=120;page=40` workload. It does not measure native structured-clone bytes or prove this extraction is faster. No comparison, profiling, new performance experiment, metric change or threshold relaxation was performed.

The pre-run identity manifest is `m2-app-turn-archive-app-identities.json`: Main `2b49534d9e41d5dbd8a6669897075c05275635f934d1259ae97b1f44d2bf566b`, preload `b7f29dbcf075eaf71edf6adb6ab015cf122d1bb8408bb040f6077b147629eadb`. Mechanical equivalence does not prove timing or native enforcement; the App test is separate scoped runtime evidence, not real SDK acceptance. Cleanup-helper return does not prove escaped-descendant or remote-effect closure.

Main decreased from 231,931 to 224,790 bytes. The new module is below 20 KB, but Main still exceeds the authored-file limit and is not staging-ready. All prior native/deadline failures and the remaining M1–M6 work remain open as recorded in earlier status documents. No commit, push, installation, version bump, daily-App restart, real Provider/account/model/Jev call or business-workspace write was performed.
