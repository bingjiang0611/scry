# 015: Give each visible run its own bounded live trace

**Status:** Accepted (documents existing behavior)

The legacy focused channel can assign an arriving event to the first unbound view. Concurrent conversation views cannot use that channel for their independent runs. Subscribe by run and give each view its own stream. A subscription only changes what is rendered; it does not focus, move, or control a run. The renderer allocates the subscription ID before asking to subscribe because events can arrive before the reply. Main validates the run ID and owns registration.

A subscribed view receives a bounded authoritative snapshot. Only its owner ACKs a batch, once and after committing it to the store. Main advances the delivery generation after reattachment or resync, rejecting stale receipts; the view must not append events older than its applied snapshot. When backpressure drops evidence, report degradation and use the resync receipt only after applying the authoritative snapshot. Reaching the two-view limit means no stream was allocated, not an empty trace. A terminal event with no snapshot falls back to authoritative history paging.

Buffer scoped trace, question, stop and terminal events in arrival order until the initial snapshot lands. Resync is serialized; a new generation drops older events and queued credits, while late replies from a stopped or superseded view cannot update it. Do not confirm a snapshot the view rejected. A completed snapshot is sufficient terminal evidence; a running snapshot cannot reopen a settled view. Apply terminal events synchronously before the view can switch to history, but leave unsubscribe to teardown so late terminal evidence can still arrive. If a subscription reply arrives after teardown, dispose the resulting bridge; main rejects stale batch receipts against its generation and batch ledger.

Main, preload and renderer ship together. Do not substitute global polling when the scoped API is absent. Confirm a resync with the matching token only after applying that snapshot. The legacy focused-run snapshot remains authoritative even after delivery skipped events at settlement. Its full batch crosses the bridge once; invoking the callback is not consumption. If the callback throws, preload returns only that batch's fenced receipt so later delivery is not blocked. That receipt is not evidence that the renderer applied the batch.

A daemon trace response is bounded, even for a live run. The reader must follow chunk cursors instead of waiting for settlement or treating the first response as complete. The [large-trace regression](../../src/daemon/host-process-large-trace.test.ts) proves the response exceeded the single-frame limit, covers delivery before settlement, and reopens through the desktop path.

A daemon question must reach the App under the same canonical run ID returned by start and used by the scoped subscription. A trace marker can arrive before the Provider names its native turn; the native Stop probe and its regression rely on delivery before the run ends. Use a time bound rather than a reply count when waiting for settlement because progress may wake the observer many times.

The first remote catalog establishes a baseline without raising attention. Later catalogs can report a newly terminal fingerprint for the same run ID. If daemon notices were lost, re-read each affected view instead of assuming the incremental feed was complete.

See [run-traces.ts](../../src/shared/run-traces.ts), [remote-session-attention.ts](../../src/shared/remote-session-attention.ts) and [run-trace-router.test.ts](../../src/main/run-trace-router.test.ts).
