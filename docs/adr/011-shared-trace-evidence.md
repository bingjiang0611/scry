# 011: Keep trace evidence separate by source and lifecycle

**Status:** Accepted (documents existing behavior)

Trace consumers receive live updates, final Provider results and historical events. One event may carry useful evidence without proving a stronger claim:

- Replace run-cumulative usage snapshots; do not add them to final usage. Use the Provider's per-model usage for results when it is authoritative. Bind context occupancy and window size to the reported model and upstream Provider, never to array order. An inferred window remains inferred. A main-agent call's local duration and time to first content (including thinking) describe speed, not billing; omit first-content time if there is no matching signal. Keep the SDK's final API duration separate from these local timings.
- A Provider hook notification does not prove that a script ran or exited successfully. Leave its command and outcome unobserved when the Provider supplies only the dispatch event. A Pi tool explicitly ending execution does not prove Goal completion. An extension ACK without an observed model turn is not agent settlement. Older Pi archives may report completed compaction through the raw lifecycle instead of a canonical event.

Normalize observed MCP calls in one place for live events, historical replay and the turn recorder. Accept native tool names, calls recognized in the known shell bridge, and the observed Qoder wrapper. Account for the escaped wrapper quotes in Codex app-server command strings. Unwrap only object-shaped arguments, otherwise preserve the original input. Keep the first MCP call in the compatibility fields and the full list for counts; a shell execution still has one lifecycle. Older archives can reconstruct the list from their saved command. Treat failure envelopes as evidence only when a complete JSON value or line carries a recognized status. An arbitrary use of the word “error” is not a failure, and even a successful process exit does not rule out a business-level failure.

See [trace.ts](../../src/shared/trace.ts), [trace.test.ts](../../src/shared/trace.test.ts), and the [evidence checklist](../agent/change-checklists.md#trace--usage--evidence-改动).
