# 025: Index recovery candidates without making the index authoritative

**Status:** Accepted (documents existing behavior)

Session files are authoritative; the attention and quarantine indexes are derived. A lifecycle hook queues under lock contention before the Provider's deadline. The workspace maintenance gate covers admission only: release it before working under the session lock so unrelated sessions can progress. Recovery can lock a corrupt inbox by its session directory key instead of trusting a payload.

Publish quarantine index entries before their authoritative state under the shared lock. Rebuild attention from open state, queued hooks and quarantine in legacy or restored workspaces. An interrupted or unreadable scan must not mark the index ready or empty. Recheck under the lock before pruning a candidate, including candidates published after a scan began. Legacy markers use the readable session-key prefix and its 12-character digest. Accept only directories as recovery candidates; missing entries are decided by the locked recheck, not the legacy scan. Count corrupt or non-retryable state as pending evidence even when it needs manual repair. On finalization, remove attention only when no work remains to replay. Index cleanup cannot change the acknowledgement for an already durable record.

Diagnostics read event and transcript clocks rather than treating turn age as inactivity. Event names preserve arrival time across repair; invalidate a cached observation when open state changes and do not cache a failed scan. Reuse one process table for the diagnostic, only when needed. Open, closing and quarantined work are distinct. Keep filesystem diagnostics off the hook hot path. [Issue #156](https://github.com/bingjiang0611/scry/issues/156) tracks making unreadable transcript timestamps distinguishable from absent timestamps; neither is evidence of Provider termination.

See [runtime-state.ts](../../src/core/turn-recorder/runtime-state.ts) and [runtime-state.test.ts](../../src/core/turn-recorder/runtime-state.test.ts).
