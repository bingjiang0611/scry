# 031: Preserve full content before budgeting its preview

**Status:** Accepted (documents existing behavior)

Resolve the same capture policy before the App's first write, including synchronous archive and outbox writes. An unavailable trace must not replace a richer canonical call list with an empty list. Honor disabled categories and preserve redaction provenance: selecting raw capture does not undo a historical redaction. Inspect a tool payload without invoking its getters or serialization callbacks. Shorten JSON as values so its preview stays valid; label historical fragments honestly.

Persist complete bodies and coalesced model text before applying field and turn budgets. Captured aliases point to previews, not another source. Apply policy to each field, not the tool event name. A clipped preview without a durable reference must downgrade evidence; one with a verified reference can still describe complete content. Keep section metadata and byte accounting even after bodies no longer fit. Use the evidence priority in [ADR 026](026-recorder-record-store-durability.md) for transport trimming.

Store content by digest and verify digest and length on reads. Publish without replacing an existing address. Validate both the canonical record's reference and its supplied bytes before repair; report a corrupt existing blob separately, without overwriting it. A repair dry run computes what could be copied; the applied result counts only successful writes. Deduplicate copies but keep field locations of unresolved references. The App trace store is an optional source, not proof a missing blob can be restored.

See [content-policy.ts](../../src/core/turn-recorder/content-policy.ts), [content-store.ts](../../src/core/turn-recorder/content-store.ts), [content-repair.ts](../../src/core/turn-recorder/content-repair.ts) and [record-content-budget.ts](../../src/core/turn-recorder/record-content-budget.ts).
