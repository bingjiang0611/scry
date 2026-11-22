# 001: Defer session capture without losing event order

**Status:** Accepted (documents existing behavior)

In an opt-in workspace, the recorder must not open sessions the host never claimed. The host hook also has a five-second budget; doing recorder work synchronously or spawning a second CLI for the event that proved the claim can lose that event.

Require explicit capture mode. For deferred delivery, write the claim and the event that proved it to the same inbox, in that order, from one invocation. Writing the inbox is the durability boundary; waking a recorder is a notification, not a wait for processing. The daemon owns opening the turn, taking the Git baseline, and replaying subsequent events in arrival order. A queued ACK means the promise is durable, not that a turn is already open. Keep ACKs machine-readable; stderr is diagnostic only.

Use the live recorder fast path when available. Fall back to local application only when non-application is proven (no connection or an explicit pre-apply refusal); an unknown delivery outcome is not permission to reapply or replace a live recorder.

See [capture-command.ts](../../src/cli/capture-command.ts) and [capture-inbox.test.ts](../../src/cli/capture-inbox.test.ts).
