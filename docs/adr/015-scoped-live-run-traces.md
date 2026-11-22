# 015: Give each visible run its own bounded live trace

**Status:** Accepted (documents existing behavior)

The legacy focused channel can assign an arriving event to the first unbound view. Concurrent conversation views cannot use that channel for their independent runs. Subscribe by run and give each view its own stream. A subscription only changes what is rendered; it does not focus, move, or control a run. The renderer allocates the subscription ID before asking to subscribe because events can arrive before the reply. Main validates the run ID and owns registration.

A subscribed view receives a bounded authoritative snapshot. Only its owner ACKs a batch, once and after committing it to the store. Main advances the delivery generation after reattachment or resync, rejecting stale receipts; the view must not append events older than its applied snapshot. When backpressure drops evidence, report degradation and use the resync receipt only after applying the authoritative snapshot. Reaching the two-view limit means no stream was allocated, not an empty trace. A terminal event with no snapshot falls back to authoritative history paging.

The first remote catalog establishes a baseline without raising attention. Later catalogs can report a newly terminal fingerprint for the same run ID. If daemon notices were lost, re-read each affected view instead of assuming the incremental feed was complete.

See [run-traces.ts](../../src/shared/run-traces.ts), [remote-session-attention.ts](../../src/shared/remote-session-attention.ts) and [run-trace-router.test.ts](../../src/main/run-trace-router.test.ts).
