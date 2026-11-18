---
name: verify-scry
description: Verify Scry's real Electron desktop app with isolated userData, native CDP input and durable evidence. Use for desktop behavior changes or user-journey reproduction; not unit-only tests, performance benchmarks, packaging, installation or paid Provider acceptance.
---

# Verify Scry

Canonical: `.agents/skills/verify-scry/`; Pi discovers it directly, Cursor uses a symlink. Surface: Electron desktop, not recorder CLI or remote clients.

Read [runbook](references/runbook.md) before execution and [feature index](features/README.md) before choosing a journey. Also read `docs/agent/verification.md`.

## Launch

From repo root, Node >=22.12, Git and a graphical macOS/Linux session:

```sh
npm ci
node node_modules/electron/install.js
./node_modules/.bin/electron-rebuild -f -w better-sqlite3
npm run build
node .agents/skills/verify-scry/scripts/run.mjs
```

Do not reinstall shared dependencies. Dev: `npm run dev`; verification: fresh production build. Runner creates isolated HOME/userData, workspace and local bare remote, seeds selected-directory/catalog preconditions, then launches real Electron with sandbox/GPU defaults. Providers are disabled. First-run selection and old-profile migration are not tested.

It prints `EVIDENCE=...`, then `READY: owned production renderer, preload and fixture session verified`. It automatically drives, captures and tears down.

## Doctor

Before any action the runner performs this read-only check; rerun only while its instance is live:

```sh
node .agents/skills/verify-scry/scripts/doctor.mjs "$EVIDENCE"
```

Checks PID identity, port/entry, build hashes, renderer URL, isolation, preload and usable session. A stale instance must fail. Read logs; never weaken security or retry unknown writes.

## Drive

Default journey: sidebar session → right workspace → Add Surface → source control. It reuses `scripts/source-control-ui-checks.mjs` native input and real Git assertions. Selectors and all mapped entry points: [source control](features/source-control.md). Other mapped features are not proved by this run.

Negative control:

```sh
node .agents/skills/verify-scry/scripts/run.mjs --negative-control
```

Suppressed mouse release must cause UI timeout/exit 1, with cleanup. Unrelated failures do not validate the control.

## Evidence

Printed `scry-verification-evidence-*` directory retains actions, screenshots, Doctor/build identity, Git state, assertions and result. Require exit 0, `status: passed`, action + visible result + independent side effect. No internal setter substitutes for user input. Details and boundary mocks: [runbook](references/runbook.md#evidence).

This is not dry-run: real commits/local pushes occur. Inspect remote refs and absent hook marker. No real GitHub/Provider/network acceptance is implied. Copy artifacts elsewhere if OS temp retention is insufficient.

## Cleanup

Runner closes CDP, uses `stopOwnedApp(child)`, then removes only scratch. Require `scratchRemoved: true` and evidence still present, including after failures. Never kill by name or stop daily Scry. Forced interruption recovery: [runbook](references/runbook.md#cleanup).

## Helpers

Both helpers are executable; invocations are above. No new dependency. Use `/maintain-verification-skill` when paths or contracts change.
