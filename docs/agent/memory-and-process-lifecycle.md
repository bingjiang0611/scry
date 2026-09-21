# Tool bodies and owned Provider processes

## Memory boundary

- Main persists tool input/result bodies using the existing content-addressed recorder format under App `userData/trace-content-v1/<sha256(canonical cwd)>/`. This does not require or initialize a workspace `.scry` recorder.
- Live trace and loaded history carry at most 8 KiB per tool field plus a content reference. The existing pager reads at most 64 KiB per request; App requests are scoped by main's selected workspace, never a renderer-supplied path. Managed recording also writes its own copy so the CLI remains independent of App data.
- A body persistence failure retains raw evidence in main/archive and logs the failure; a bounded UI preview is not advertised as complete. Original legacy archive files are not rewritten when projecting their content.
- Limits: legacy JSON still has to be parsed on first load, and Provider RPC can transiently deliver one large message. This fixes long-lived tool-body retention, not every allocator high-water mark or arbitrary model/attachment payload. If large legacy-file load peaks remain problematic, extend the existing indexed/streamed archive reader rather than truncating evidence.
- App content bodies are not automatically garbage-collected. Deleting a session does not currently purge shared body files; a future disk reclamation operation must prove reference liveness across surviving archives before deletion.

## Process boundary

- OpenCode close waits for exit: TERM, then KILL after 1 second, then a 1-second confirmation deadline. Unconfirmed exit is an error; owned handles/managers remain registered for another shutdown sweep. Idle retirement, startup errors, replacement, auth cleanup and adapter disposal use this path.
- A sudden production App SIGKILL cannot run JavaScript cleanup. This change does not claim parent-death supervision for every native Provider descendant.
- Packaged security smoke enables only its fake Codex adapter and disables the remote host. Before intentional crash/restart and final cleanup it snapshots the test App's descendant identities externally, revalidates start time/command before signaling, and confirms the registered tree has exited. Unknown cleanup preserves the temporary fixture and fails the smoke; it does not authorize a name-based process sweep.

## Focused checks

```sh
npm run test:unit -- src/main/trace-tool-content.test.ts src/main/session-history.test.ts src/main/providers/opencode-server-lifecycle.test.ts scripts/owned-app-processes.test.mjs
npm run pack:artifact
```

The packaged smoke includes a 12 MiB fake tool result, bounded history IPC, complete-tail content paging, and a foreign-workspace denial through production handlers. No real Provider account is required.
