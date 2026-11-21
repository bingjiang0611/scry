# File links and preview

Open a file referenced in a conversation, inspect its actual contents, and distinguish editable workspace files from read-only links.

## Sub-features

- Markdown link actions **打开文件** and **在右侧文件面板打开**.
- Encoded/non-ASCII paths, sibling files, extensionless files and symbolic links.
- Markdown preview → **展开源码**.
- External-open handoff for non-previewable files.
- Reject forged file references and writes through read-only references.

## How to get to it (user POV)

Click a file link in a conversation. For supported files, inspect the right file panel. Markdown opens as a preview; use **展开源码** to view bytes. Opening in the system default application is a different action from previewing.

## Driving it with Electron CDP

After building:

```sh
node scripts/electron-security-smoke.mjs --dev-files-only
```

The source is `scripts/electron-security-files.mjs`. It generates its own files and conversation fixture. Native file-link targets are `.md-file-ref` with titles such as **rotom-team/docs/NATIVE-DELIVERY.md · 在右侧文件面板打开**. Observe `.workspace-preview h1`, `.workspace-editorbar`, and `textarea[aria-label="查看 NATIVE-DELIVERY.md"]`.

Proof: preview/source matches the actual fixture bytes; readonly textarea remains readonly; both file-link entry actions reach the expected file; forged references and unauthorized writes reject; external-open receipts name the exact canonical target. Save action traces, screenshots, file contents and the harness's reported receipts before deleting any failed-run scratch.

## Gotchas

- Not executed during generation. Existing script mixes native file-link clicks with direct preload setup/security checks and a DOM click for source expansion. Those parts are not full native UI acceptance. Replay source expansion with native input before declaring that user path verified.
- A non-network Provider fixture supplies the conversation. Missing link output is a failed precondition; do not invent successful tool evidence.
- The dev entry stubs `shell.openPath` at the OS boundary and records receipts. This proves handoff arguments, **not** that a real external app opened or an executable ran.
- Do not run the packaged `--files-only` variant as a substitute without reviewing its external-open effects. Scry's production file-open policy can execute programs.
- A single-file read reference must not authorize sibling files, directory traversal or writes. Preserve those rejection checks.
