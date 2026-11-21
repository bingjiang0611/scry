# Workspace sessions

Choose a project, branch or separate worktree before sending a coding request, then inspect that session's changes.

## Sub-features

- Start a new draft from the project sidebar.
- Choose current workspace, existing worktree or a new worktree and base ref.
- Search/page branch choices; dismiss with Escape or click outside.
- Send through the composer; reopen an existing worktree session.
- Inspect workspace/turn diffs and recorder evidence.

## How to get to it (user POV)

Use the project's new-session button in the sidebar. Open the workspace and branch controls above the composer. For an existing worktree, select its session row. Saving a choice is not sending a request and must not switch the current branch immediately.

## Driving it with Electron CDP

After building, use the repo's existing isolated App harness:

```sh
npm run test:workspace:ui:prebuilt
```

Read `scripts/workspace-session-ui-checks.mjs` and its `workspace-session-ui-open.mjs` / `workspace-session-ui-run.mjs` helpers for the current journey. Stable handles include `.sb-proj-new[aria-label$="<fixture cwd>"]` (the harness inserts its actual generated cwd), `[data-workspace-menu="workspace"]`, `[data-workspace-menu="refs"]`, `.workspace-ref-search input`, `.workspace-choice` and `textarea`. Native pointer receipts must show trusted input and matching targets.

Proof requires unchanged branch/index bytes and mtime while merely choosing/cancelling; a real prepared worktree only after send; the fixture Provider receiving the selected canonical cwd exactly once; correct persisted recorder records and reopened session identity. Read the command's final JSON and retained `scry-workspace-session-ui-*` evidence directory, not just its process exit.

## Gotchas

- Not executed during this skill's generation. Re-run on the current revision before claiming acceptance.
- This harness uses the existing non-network Provider fixture. It proves production UI/main/preload/worktree integration, not actual Provider login, model behavior, token usage or billing.
- No fixture branch/worktree is a precondition failure, not permission to skip that entry. The harness creates them in `prepareWorkspaceSessionFixture`.
- Existing smoke launch policy differs from the new runner (including GPU flags). Report that environment distinction; do not silently apply it to daily Scry.
- Do not call `window.scry.start` directly to replace the composer path. Do not modify the real project or its hooks to make fixture assertions pass.
