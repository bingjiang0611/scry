# 035: Share host composition without sharing run ownership

**Status:** Accepted (documents existing behavior)

Electron main and the daemon assemble the same run pipeline. Main supplies values and callbacks for App-owned paths, shell environment, history, and tool panels; the shared assembly does not import Electron at runtime. A headless host omits outbound desktop execution rather than advertising an unusable target. The App retains read-side registry and trace views in daemon mode, but its pipeline refuses both direct and workspace starts: a local fallback would run outside the daemon ledger. Loss of a renderer during workspace progress delivery does not fail the launch.

Keep daemon-local controls off the device endpoint. If submitter scope cannot be proven, keep device semantics. Main can confirm deletion of an unarchived session for the App's local grant; a device grant still requires it to be archived. A settled run's evidence normally comes from the archive. Only the App's local settled-tail read can use the recently departed registry entry, since removal can precede the ledger's settlement notice.

Key remote start receipts and workspace reservations by ledger run ID, not by local IPC command ID. A managed workspace start can report registration before its terminal receipt; only dispatch takes the prepared conversation. Keep host identity, pairing, run ledger and output under the remote state directory, separate from App reader caches and terminal recordings. Resolve session directories once per catalog read, not across reads that could reuse stale paths. Use a worker-backed output store in production; tests can supply one directly.

Test runtime imports with a graph that traverses more than the entry and with Electron main as a positive control. Erased type-only imports are not runtime edges, nor are comments that mention imports. A graph check is not a substitute for constructing the pipeline without Electron. Test execution refusal in both branches even when the read views remain available.

See [host composition](../../src/host-runtime/host-runtime.ts), [execution ownership tests](../../src/host-runtime/run-pipeline-execution.test.ts), and [import-graph follow-up #163](https://github.com/bingjiang0611/scry/issues/163).
