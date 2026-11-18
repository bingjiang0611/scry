# Scry verification runbook

Read before executing a journey. Commands run from the repository root.

## Launch

Use Node >=22.12, Git and a working macOS/Linux graphical session. Development normally uses `npm run dev`; verification uses a fresh production build without HMR, packaging or installation. No real Provider login, credentials or paid request is needed for the default journey.

From a clean checkout:

```sh
npm ci
# README.md's documented recovery if Electron is not downloaded:
node node_modules/electron/install.js
# Match native SQLite to Electron, not the invoking Node ABI:
./node_modules/.bin/electron-rebuild -f -w better-sqlite3
npm run build
node .agents/skills/verify-scry/scripts/run.mjs
```

Do not run `npm ci` against another task's shared dependency tree. If dependencies already exist, inspect their state first. Native rebuilds change this checkout's ABI; before subsequent Node SQLite tests use `npm rebuild better-sqlite3 node-pty` as documented in `docs/agent/verification.md`.

`run.mjs` is one-shot: **launch → Doctor → source-control journey → evidence → teardown**. It prints `EVIDENCE=/absolute/path` immediately. `READY: owned production renderer, preload and fixture session verified` means the expected page, preload API and selectable session exist, not merely that a debug socket answered. Final exit 0 plus `result.json.status = passed` is success.

The helper starts `electronDevLayout().executable` with a loopback CDP port and a generated entry that sets a unique `userData` before importing `out/main/index.js`. It preserves sandboxing and GPU defaults. `hidden-electron-windows.cjs` prevents focus stealing; this is a real Electron renderer, not jsdom or a standalone preview page.

Every run creates fresh HOME, XDG paths, userData, workspace and a local bare Git remote. It seeds `recent-folders.json` and one catalog row in `app-sessions.json` using the existing smoke fixture contract. Both workspace **and local remote** are selected-directory fixture preconditions. App startup owns storage initialization. This does not test first-run directory selection or migration from old user data. All Providers are disabled; no fake conversation result is injected. Never substitute the user's daily profile, repo or remote.

## Doctor

The runner calls the read-only Doctor before the first UI action. Whenever a live run looks wrong, run:

```sh
node .agents/skills/verify-scry/scripts/doctor.mjs "$EVIDENCE"
```

Use the exact printed evidence path. Doctor verifies PID start time/command, the unique entry and port arguments, recorded build hashes, exactly one expected renderer URL, Scry title, renderer isolation, preload API and selectable fixture session. It makes no state-changing IPC calls. After cleanup, Doctor **must fail**: an old evidence folder is not a live instance. Its startup result remains in `doctor.json`.

Do not drive a different process after a stale/mismatched identity, missing preload, missing fixture or changed build. Read `app.stderr.log`, `final-dom.json` and `result.json`; repair the specific precondition and start a new isolated run. Never disable sandbox/trust checks or increase timeouts to turn a failure green.

## Drive

Default:

```sh
node .agents/skills/verify-scry/scripts/run.mjs
```

This reuses `scripts/source-control-ui-checks.mjs` rather than maintaining alternate selectors. It clicks the catalog session, opens **右侧工作区 → 添加 Surface → 源代码管理**, then exercises commit selection, cancellation, unstage, partial-index preservation, confirmed commit, blocked hook, local push, draft restoration and highlighted diff worker output. Details: [source control](../features/source-control.md).

The harness measures and hit-tests current DOM targets, then dispatches native `Input.dispatchMouseEvent`/keyboard events. DOM evaluation is for observation and explicit instrumentation, not a replacement for the user action being proved. Preload reads and direct Git inspection supplement the UI; they do not count as clicks or sends.

Negative control (expected exit 1):

```sh
node .agents/skills/verify-scry/scripts/run.mjs --negative-control
```

This suppresses native mouse release. The journey must fail its UI wait, not report success from a screenshot or pre-seeded state. Inspect `actions.jsonl` for `suppressed: true` and `result.json` for failure and cleanup. Other failures do not validate this control.

Other features have existing commands and explicit coverage limits in the map. Do not claim that this one journey proves them. A feature with multiple mapped entry points needs each relevant entry exercised; retain failures when fixture preconditions are missing.

## Evidence

Evidence survives teardown under `${os.tmpdir()}/scry-verification-evidence-*`; the exact directory is printed. Copy that directory to your task artifact store if it must outlive OS temp cleanup. Do not commit screenshots or fixture data.

- `checkout.json`: revision, dirty status/stat, build hashes, host/Node version. Run immediately after rebuilding affected sources; hashes alone do not prove build freshness.
- `instance.json`, `doctor.json`: owned process/build and usable-state checks.
- `actions.jsonl`: timestamped native input dispatches; dispatch alone is not business success.
- `before.png`, `step-*.png`, named screenshots, `final.png`, `final-dom.json`: initial state, intermediate confirmation/history/theme states and final state.
- `checks.json`: assertions from the shared journey, including native diff-worker messages.
- `git.json`: actual commits, status, local/remote refs and hook marker, captured before scratch deletion.
- `app.stderr.log` / `app.stdout.log` when emitted; `result.json`: outcome and owned-process cleanup. Capture errors are explicit and fail the run.

Proof requires **action + visible result + independent side effect**. The journey checks commit contents, untouched files and preserved partial staging; it compares pushed local-remote refs with HEAD and checks the hook marker is absent. It does not treat an empty screen as “no evidence” or a successful dispatch as completion.

This is **not a dry-run**: it creates real fixture commits and pushes to a local bare remote. Inspect `git.json.remotes` and `remoteRefs`; do not infer safety from the command name. It does not click GitHub PR creation, run paid Providers or prove real network/auth behavior. External boundaries in other mapped harnesses may be stubbed; state exactly which ones. No mocks of production main/preload/renderer are allowed for the default proof.

## Cleanup

Normal success and thrown failures both close CDP, call the existing `stopOwnedApp(child)` process-tree helper, then delete only the run's scratch directory. It rechecks owned identities; never use `pkill`, process-name matching or stop the daily Scry instance. Do not hard-kill the runner while its `finally` is collecting evidence and stopping children.

After every run, read `result.json`; require successful cleanup and `scratchRemoved: true`. Confirm the evidence directory and screenshots still exist. A cleanup error is a failed run, not a warning. If the runner was forcibly killed, use `instance.json` plus the repository's `scripts/owned-app-processes.mjs` identity checks to inspect the exact PID/tree before any signal; do not delete scratch until the owned process is gone. Never delete the evidence directory during cleanup.

## Helpers

Both shipped `.mjs` files are executable; invoke them with Node as shown above. `run.mjs` owns lifecycle and evidence; `doctor.mjs EVIDENCE_DIRECTORY` is read-only and live-instance-only. They reuse repository CDP, platform layout, process ownership and source-control journey helpers. No new dependency or app runtime flag is required.

Maintenance: use `/maintain-verification-skill` when routes, labels, persistence contracts or feature entry points change. Update the canonical map and rerun affected journeys; do not patch the discovery symlink copy.
