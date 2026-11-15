# Source control

Inspect changes, choose a commit scope, preserve unrelated work, commit and explicitly push.

## Sub-features

- Open/reopen a source-control surface and navigate file diffs.
- Empty-index commit entry and disabled zero-file confirmation.
- Select candidate files without staging them; cancel without creating a commit.
- Explicit unstage, preserve partially staged bytes, confirm exactly two files.
- Push blocked by an untrusted pre-push hook; push to a selected local bare remote after removing the fixture hook.
- Commit draft restoration, operation history, light/dark captures and native syntax-highlight worker.

## How to get to it (user POV)

1. Select a session in the left sidebar.
2. Show **右侧工作区** if hidden.
3. Click **添加 Surface**, then **源代码管理**.
4. Use **提交改动…**, file selection checkboxes and confirmation dialogs.
5. After committing, use **推送分支…**. Closing **关闭 源代码管理** and reopening through Add Surface is a separate mapped entry.

## Driving it with Electron CDP

Run from the repo root after the skill's Launch steps:

```sh
node .agents/skills/verify-scry/scripts/run.mjs
```

The shared journey is `scripts/source-control-ui-checks.mjs`. It uses native pointer/keyboard input against:

- `button.sb-sess`, `button[title="右侧工作区"]`, `[aria-label="添加 Surface"]`.
- `.surface-menu [role="menuitem"]` with text **源代码管理**.
- `[aria-label="纳入本次提交 selected.txt"]`, `[aria-label="取消暂存 reversible.txt"]`.
- `.sc-commit-dialog textarea`; **确认提交 2 个文件** in the modal.
- **确认推送到 feature**, and `[aria-label="关闭 源代码管理"]`.

Wait for `.sc-panel[aria-busy="false"]` and the expected next action. Proof: two actual commits, exact committed file bytes, unstaged remainder and untouched files retained, local remote branch equals HEAD, hook marker absent, three successful operation records, restored draft, file-scheme worker initialization and diff responses. Screenshots alone are insufficient.

## Gotchas

- The workspace and **local remote** must both be selected-directory fixture entries. A run with only the workspace seeded reached commit but failed push with **工作目录尚未通过 Scry 目录选择器授权**. The generated runner seeds both; it does not bypass the authorization check.
- macOS temp paths must be canonicalized before passing them to the shared journey. Otherwise real main returns `/private/var/...` and exact path assertions correctly fail.
- The runner does not prove initial directory selection. It starts with empty userData plus explicit persisted selection/catalog fixtures.
- This makes real commits and local pushes, not a dry-run. It never creates a GitHub PR. Do not replace the fixture remote with a real remote.
- Provider runs and real credential/network behavior are outside this proof. Filesystem seeding and worker observation are explicit test setup, not proof of user interaction.
- Negative control suppresses mouse release; expected result is a UI timeout plus cleanup, not a green run.
