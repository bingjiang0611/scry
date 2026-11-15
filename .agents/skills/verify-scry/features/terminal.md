# Terminal continuity

Use a real shell inside the workspace while switching conversations without losing its working directory or process.

## Sub-features

- Add a terminal surface to the right workspace.
- Enter commands and observe PTY output.
- Switch conversations/projects while keeping each terminal's cwd and scope.
- Close only the terminal owned by the selected surface.

## How to get to it (user POV)

Select a session, show **右侧工作区**, click **添加 Surface**, then **终端**. Type a harmless command, switch to another conversation, return and check the same shell remains alive. Closing the surface must not close another conversation's terminal.

## Driving it with Electron CDP

The existing backend integration baseline is:

```sh
node scripts/electron-security-smoke.mjs --dev-terminal-only
```

Read `scripts/electron-security-dev-terminal.mjs`. It starts real PTYs via typed preload APIs, writes split shell markers (`printf '__ALIVE_%s__:%s\\n' A "$PWD"`) and checks that actual output, not input echo, contains the expected canonical home/workspace. It verifies two distinct scopes and active PID identities, then closes its own sessions.

For user-path acceptance, additionally drive `button[title="右侧工作区"]`, `[aria-label="添加 Surface"]`, the **终端** menu item and the focused xterm input via native CDP keys. Capture command dispatch, rendered output, selected session and terminal PID/cwd before and after switching. The IPC baseline alone is not that UI proof.

## Gotchas

- Not executed during generation; native terminal-entry acceptance is not implemented by the shipped runner.
- No xterm input or fixture session means fail and record the missing precondition. Do not replace the UI step with `terminalStart` and label it UI verification.
- Commands run with local-user privileges; this is not a sandbox. Use only the temporary fixture directories, no credentials/network/destructive commands.
- Native `node-pty` must match the runtime. Follow the repository rebuild guidance rather than disable sandboxing or fake terminal output.
