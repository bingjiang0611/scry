# 028: Retain hooks before applying them and replay at least once

**Status:** Accepted (documents existing behavior)

An observational hook must not hold up the Provider. Sample arrival before the lock wait. When contention prevents applying the event, publish the attention marker and durably enqueue the event under the attention lock, not under the busy session lock. The same rule protects an incoming prompt before a fallible seal of its predecessor: a degraded previous turn can be recovered, but a lost new prompt cannot. Unlink an inline copy only after it is incorporated. Log queued work that actually remains pending rather than transient inline copies. Diagnostic write failure must not block a hook or another session.

Each replay pass uses arrival order under the session lock. At-least-once replay relies on lifecycle identities, prompt fingerprints and committed-turn checks; unlink failure is not a failed apply. A failed older event must not block later arrivals. Persist attempt state before quarantining or moving the original bytes. Preserve unreadable entries and counters for repair; only a confirmed missing entry is ignorable. Exhausted or unreadable work remains visible without keeping an idle daemon spinning. A directory's session key identifies its lock even when the first payload is unreadable.

Claims carry their validated context and host ancestry into the queue. A capture event can wait for a queued claim, then resolve the resulting capture at apply time. Revalidate Provider and session identity. External replay must enforce the live path's stop fences, synthetic/title filtering, subagent tagging and repository discovery. Timestamp ties normally use a per-session sequence. The sequence is not synced, so durable same-tick order across a crash is not guaranteed ([#158](https://github.com/bingjiang0611/scry/issues/158)).

Recover queued arrivals before deciding the open turn's outcome. Use the attention index for normal recovery and reconcile authoritative directories when the index is missing or explicit repair is requested. A failed repair must not starve known work. Keep the existing callback activation and fingerprint gate, and drain notifications only within the established hook or background budget.

See [inbox.ts](../../src/core/turn-recorder/inbox.ts), [recorder-hook-queue.ts](../../src/core/turn-recorder/recorder-hook-queue.ts), [recorder-hook-locked.ts](../../src/core/turn-recorder/recorder-hook-locked.ts), and [recorder-inbox.test.ts](../../src/core/turn-recorder/recorder-inbox.test.ts).
