# Scry verification feature map

This is the maintained user-journey index, not a list of passing tests. Paths and labels come from the current checkout. Read only the feature under test.

| Feature | Entry points | Harness / coverage |
| --- | --- | --- |
| [Source control](source-control.md) | Session → right workspace → Add Surface → source control; reopen closed surface | Shipped runner; real Electron, local Git and local push |
| [Workspace sessions](workspace-sessions.md) | Project new session → workspace/refs menus; existing worktree session | Existing production-App fixture harness; not run for skill generation |
| [File preview](file-preview.md) | Markdown file links; right file panel; source expansion | Existing production-App file harness; mixed native UI and IPC coverage, not run here |
| [Terminal](terminal.md) | Right workspace → Add Surface → terminal; switch conversations | Existing real PTY/IPC check; native UI journey still required, not run here |

Default acceptance proves source control only. Workspace/file/terminal commands below are starting points, not certification that their entire feature works. No real Provider, phone, Linux target-machine or packaged release acceptance is implied.

Seed failures are failures: do not remove an assertion or silently substitute another entry point. Record missing preconditions in that feature's Gotchas. Promote a mapped path to verified only with versioned action/result/side-effect evidence.
