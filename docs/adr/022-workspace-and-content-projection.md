# 022: Project observed state without granting authority or copying payloads

**Status:** Accepted (documents existing behavior)

Repository and terminal grouping keys are not permission. A structural workspace request still needs host-side Git checks, canonical path validation and project authority. Accept only full local or already-fetched remote-tracking refs, recheck the selected ref's HEAD at preparation, and use a locally available origin/main as the preferred default. Ref search is capped; refine a capped query rather than assuming absence. Compute workspace diff totals and patches from the same immutable trees. Multiple push destinations are not writable through this contract; hide credentials in the displayed destination. GitHub identity is not transport auth. Keep operation results tied to authoritative receipts, and recheck PR status at dispatch rather than treating partial checks as passing.

Worktree progress is evidence, not an estimate: publish metadata readiness only after preparation succeeds and checkout progress only from Git or completed checkout. Cancellation ends before Provider launch; details are bounded and sanitized. The same contract crosses the desktop transport.

The paired device receives a bounded, read-only projection of the same panels as the Mac, not remote execution or a scan request. Keep unknown values null with reasons; missing live state is not disconnection. Rank model rows with known costs before capping, keep estimation markers, and preserve coverage counters. Project findings without evidence paths, key names or hashes. A static scan that did not run is not a clean result.

A content reference names a scoped body, not permission to read an arbitrary path. Preserve the schema-v1 compatibility name; absence can mean an older producer, not full capture. Full bodies are separate from bounded previews; check redaction provenance. Manifest descriptors carry the root and totals without materializing the tree; main validates contents, counts and byte bounds. Stored Provider evidence is verbatim: credential masking is for display, not evidence sinks. A local session title is a catalog label, not transcript content.

Terminal replay offsets are bytes in the UTF-16LE recording. Do not leak other workspace identities when metadata reads fail. After renderer reload, surface the last observed restart reason once so an interrupted view is not mistaken for continuous execution.

See [workspace-selection.ts](../../src/shared/workspace-selection.ts), [source-control.ts](../../src/shared/source-control.ts), [tool-panel.ts](../../src/shared/tool-panel.ts), and [tool-content.ts](../../src/shared/tool-content.ts).
