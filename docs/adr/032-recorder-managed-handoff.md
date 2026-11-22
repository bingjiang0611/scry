# 032: Recover managed turns from durable handoff evidence

**Status:** Accepted (documents existing behavior)

The App's canonical journal follows Provider settlement; it is not another observation of a live turn. Preserve exact identity, evidence and generation across a crash. A provisional open can be abandoned only when the caller knows its run is no longer alive and neither a native turn ID nor a canonical handoff can recover it. Leave managed runs owned by the active execution path alone. A journal with proven identity can reserve a fresh generation if the provisional state disappeared; persist a recoverable open before advancing derived indexes. Derived indexes may be stale but cannot authorize reusing a crash-reserved or committed generation.

Compare a replay after the same capture-policy and envelope normalization used at commit. Canonical capture must not reference bytes absent from the recorder's own store. Persist full bodies when policy permits; otherwise keep a bounded summary or mark the missing evidence honestly. A locally observed interrupted launch is not a Provider terminal. Only authoritative timing, model and role evidence can make those fields exact; a known attachment-only prompt can have exact empty text, unlike omitted evidence. For managed App recovery, detach downstream notification work from launch/finalization; the standalone CLI can await its bounded drain before exiting.

See [managed.ts](../../src/core/turn-recorder/managed.ts), [managed-recovery.ts](../../src/core/turn-recorder/managed-recovery.ts), [managed-capture.ts](../../src/core/turn-recorder/managed-capture.ts), and [ADR 031](031-recorder-content-custody.md).
