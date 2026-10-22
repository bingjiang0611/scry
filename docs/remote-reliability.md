# Remote refresh recovery

This change concerns read-only discovery/catalog refreshes, not automatic task delivery.

## Failure evidence

Home keeps the last complete all-host refresh time. Each failed operation retains its host, stage, original typed error and per-host verified catalog time. Details are a value snapshot: a later recovery cannot rewrite the request the user opened. Discovery uses the gateway control lane; session pages use the bulk lane; cache failures identify local storage. Healthy hosts keep publishing their own lists while another host fails.

Diagnostics are not persisted or uploaded. The existing desktop `RemoteStatus.relay` optionally exposes host-observed outer-leg counts: opening, waiting, active and total limit. Waiting means the local outer connection opened, **not** that the relay accepted admission or that an inner-mTLS request succeeded. Relay-side `no_host_leg` rejections are not observable in those counters and are not reported as zero.

## Recovery contract

- Home visibility, foreground and a satisfied changed network route govern catalog recovery. A route change resets stale lanes before requesting a new read.
- One refresh is in flight. A transient failure can start at most three delayed recovery reads (1, 3, 8 seconds). After that, the user retries, or a new foreground/network event starts another burst. There is no perpetual catalog polling.
- Only failed, recoverable operations are repeated during a recovery burst. An explicit refresh can retry a previously denied operation; automatic recovery cannot use a filter change to bypass that restriction.
- TLS, authorization, malformed replies, WebSocket policy failures, protocol incompatibility and cache errors do not automatically retry. Timeouts, disconnection and selected transient WebSocket close codes can recover. A target-hop denial never implies replacing the phone's gateway grant.
- Backgrounding/leaving Home invalidates recovery work, including work already awaiting discovery. It cannot start later target batches. It does not cancel host tasks or reset unrelated target lanes.
- A local-only filter does not wait for optional target discovery. In all-host refreshes, local and target reads can complete independently. An all-host timestamp advances only after the selected aggregate refresh succeeds.

The catalog scheduler never submits, stops, answers or approves a task. Existing durable intent reconciliation and transport write-uncertainty rules are unchanged.

## Discovery and rolling upgrade

New hosts accept only `op`, `keepAlive` and validated `deviceLabel` for discovery. Metadata does not become target authority. The phone reuses its authenticated control lane and validates the returned gateway identity and target bindings.

An already-running older host rejects the transport metadata with exactly `invalid_request`. For this **read alone**, the phone then performs one unwrapped one-shot `{op: executionTargets}` request. It validates that response in the same way and propagates its failure. No recursive fallback occurs. Authorization, TLS, timeout, malformed replies and `unknown_op` do not enter this compatibility path. A newly installed desktop bundle does not update a running host until it is restarted.

Network route identity uses the interfaces actually selected by `NWPath.usesInterfaceType`, plus path status and relevant route properties, not the list of interfaces merely available on the phone.

## Concurrent catalog snapshots

Session page snapshots are immutable and keyed by authenticated peer, archive filter, source revision and snapshot hash. A second first-page refresh does not replace an in-progress walk. Retention is capped at 32 snapshots with a 30-second inactivity TTL; active page reads extend the TTL. Expired/evicted snapshots fail explicitly rather than rebuilding from current rows under an old cursor.

Every page re-authorizes the device. Production workspace-authority revisions invalidate older snapshots. Sources without a revision cannot withdraw frozen display metadata before TTL/cap eviction; selecting content still requires its own current authorization.

Production relay capacity is unchanged: run pool warm reserve 4 / total 16; pair pool reserve 2 / total 8. Diagnostics distinguish local opening/outer-ready/consumed legs without starting inner TLS on an idle WSS leg. Raising limits requires real capacity evidence; these changes do not claim it was the cause of an observed phone failure.

## Focused verification

```sh
npm run test:unit -- src/main/remote/remote-gateway.test.ts src/main/remote/relay-client.test.ts src/main/remote/remote-host-service.test.ts src/main/remote/inner-mtls-host.test.ts
swift test --package-path experiments/remote-g0/swift --filter 'WireTests|LaneHandlerTests'
python3 apps/ios/Checks/catalog-refresh.py
```

The native catalog check uses production coordinator/store/cache code with isolated fixture readers. It covers recovery, the finite budget, host isolation, foreground/filter transitions, TLS/auth non-retry and cancellation after discovery starts. It is not proof of real Wi-Fi/cellular handover. Phone replay uses a physical device and iCTRL, never a simulator; real handover and intermittent failure acceptance must retain the first failure and its diagnostic.
