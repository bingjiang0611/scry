# Scry iOS workspace

Two targets live here:

- **ScryRemoteG0** (`com.scry.remote.g0`) — isolated native SwiftUI transport/Keychain verification app. **Not** the product; it cannot start Providers, write files or operate terminals.
- **ScryRemote** (`com.scry.remote`) — the product SwiftUI app (`ScryRemote.xcodeproj`), implementing the selected **v5 · Codex Refined** direction: sign-in, live pairing, flat session catalog, transcript continuation, new task, project/Provider pickers, attachment composer and settings. iOS 17+.

The current desktop host implementation is under `src/main/remote/`; this README is the maintained product and verification guide. It does not claim public deployment or complete Provider acceptance.

## ScryRemote product UI (design v5)

The base structure and interaction decisions live in `designs/scry-ios-remote/brief-v5.md` and `design-notes-v5.md`; the three-way comparison is `Scry iOS Remote v5 Directions.html`.

The current native UI uses the reference-led dark workbench styling: compact tool/reasoning disclosure rows and a flat, two-level composer. See [the design delta and verification limits](../../designs/scry-ios-remote/reference-workbench-2026-10-09.md). `ScryRemote` includes a native XCTest UI target. Current phone interaction acceptance uses an authorized physical device through iCTRL, never a simulator. Compilation, offline native checks and real-device interaction results are separate evidence.

Honesty invariants (enforced by the model and host, not decoration):

- No fabricated sessions, tasks, assistant replies, lifecycle, token/cost values or diffs. Home/history/run output come from the paired host.
- A persisted grant is only “已配对”; the UI shows green “已连接” only after a real host exchange proves reachability.
- The working-directory picker can move up and down inside Mac-authorized project roots and select any canonical descendant; `..`, symlink escapes and paths outside those roots fail closed. The Provider picker lists only host-available values, and the host re-validates both targets on submit.
- The composer accepts up to four bounded image or UTF-8 text/code attachments. Images become native Provider attachments; text files become explicit Provider context blocks. Unsupported or oversized files fail visibly instead of being shown as uploaded.
- Composer model/effort choices are next-turn preferences, not evidence of a running turn's actual model. They persist separately for each session (host/grant, execution target, Provider/Profile, cwd and session identity); new-task preferences are separate. Submitted/outbox routing stays frozen. A missing model/effort remains visible and blocks sending until the user reselects; a catalog refresh must not silently choose auto. The local preference store retains the 128 most recently changed contexts; older evicted contexts reopen with auto. If this bound causes real preference loss, replace the array with paged per-context storage rather than growing an unbounded in-memory map. `-selfTest` includes the model isolation/recovery regressions.
- QR pairing is the only onboarding path; no Apple account or manual-code entry is required/offered. Existing Keychain grants and cached history survive an app update. DEBUG visual fixtures never create a host grant.
- Session headers show current observed run state (including unavailable/unknown); historical-session checks are scoped by provider, profile, canonical cwd and external session ID. “No observed run” is not “completed”.
- The header folder button opens read-only project files and current-worktree vs HEAD diff, including untracked files. File pages are 64 KiB with snapshot-fenced continuation; diff previews are capped at 64 KiB and explicitly marked when incomplete. Device grants and canonical project/path containment are rechecked for every request.
- Live runs use persistent control/watch/bulk inner-mTLS lanes, host long-poll `watch`, explicit `stop` receipts and bounded read-only reconnect. Backgrounding disables polling; delayed discovery cannot restart it. Ordinary foreground history-watch changes can still cancel and restart a poll.
- Messages enter the durable outbox (`outbox.json`) before delivery. A durable attempt marker must succeed before a request starts. In-process transport retries keep the same intentId and backoff; foreground wake preserves those retries. After relaunch, attempted/unconfirmed messages and legacy entries without attempt evidence pause for receipt reconciliation rather than automatic submission. Explicitly never-attempted queued messages still deliver automatically. Unknown outcomes are not proof of nonexecution; host deduplication does not replace this recovery contract. Background deliveries cannot replace the focused message's recovery record. iOS background execution is not requested.
- Pairing scans a real short-lived code, proves device-key possession over inner TLS 1.3/mTLS, waits for Mac confirmation, and only then stores the public connection descriptor.

Focused offline checks (no phone, credentials or Provider execution):

```sh
python3 apps/ios/Checks/new-task-readiness.py
python3 apps/ios/Checks/catalog-refresh.py
swift test --package-path experiments/remote-g0/swift -j 4
```

The native checker explicitly seals and verifies its temporary executable with an ad-hoc test signature. If local execution policy requires a CMS development signature, set `SCRY_IOS_CHECK_SIGN_IDENTITY` to an available local development identity. Signing or verification failure stops the check; no system security policy is changed.

Signed physical-device build (supply device and team at invocation):

```sh
xcodebuild -project apps/ios/ScryRemote.xcodeproj -scheme ScryRemote -configuration Debug \
  -sdk iphoneos -destination "id=$SCRY_IOS_DEVICE_ID" \
  -derivedDataPath /tmp/scry-remote-device-build \
  DEVELOPMENT_TEAM="$SCRY_IOS_DEVELOPMENT_TEAM" CODE_SIGN_STYLE=Automatic build
```

The simulator observations below are historical, not current phone acceptance.

Visual verification (2026-09-15): v5 was built and launched on the iPhone 17 Pro simulator. Home/pair/new-task plus live-chat and transcript layouts were replayed from the **DEBUG-only** harness. Chat verification covers rendered Markdown, collapsed/expanded reasoning, collapsed/expanded long tool output, compact short tool results, attachment bubbles and the Composer. The launch arguments (`-uiPreview [-connected] -route home|new|chat|pair|settings|transcript [-uiMockData] [-uiMockSlash]`) affect screenshots only; they are not authentication, and mock conversation data is compiled out of Release builds.

Conversation positioning and freshness: opening a session starts at the latest message, including history whose Markdown finishes parsing after layout. Tail positioning observes committed content geometry, not the background reader's placeholder size. The conversation remains lazy, but each rendered Markdown message lays out all its blocks so a nested lazy stack cannot leave the live reply's tail viewport empty. Very large single messages can therefore increase layout work; do not reintroduce nested lazy layout or truncate text to optimize that path. An accepted send restores tail-following even when the reader was browsing older messages. While following the tail, source-version changes fetch a fresh recent window (even after loading a full cache or older pages); old and new snapshot pages are never concatenated. While reading older messages, keep that snapshot and position, then reconcile immediately on “回到最新”. Earlier turns remain available through the older-history controls after rebasing. DEBUG `-uiMockLongOutput` plus `-uiMockFirstScreen` cover long live/archived replies; `-uiMockMacStartsLater` runs the same freshness decision against a full cached base.

Preview connection isolation: `RemoteRunStore` blocks access to the persisted host connection under DEBUG `-uiPreview` or mock mode. Foreground/reopen observation, stop actions and paged history therefore cannot use a real pairing, even when fixtures run in an already paired installation. The pairing is preserved for the next normal launch. `-selfTest` includes a paired-descriptor regression for this boundary; it checks client admission, observation/stop and paged/detached paths without issuing requests.

Markdown tables: live assistant output, reasoning and archived replies share the native block renderer. Pipe-delimited tables retain headers, left/center/right alignment, inline Markdown and escaped pipes. Cells wrap at a readable 220pt column width; wide tables scroll horizontally. Short rows are padded and surplus cells ignored, following GFM. This remains a small conversation parser, not a full CommonMark engine (nested block tables are not supported). `-selfTest` checks parsing; `ConversationUITests.testMarkdownTableInLiveOutputAndHistory` uses DEBUG `-uiMockMarkdownTable` / `-uiMockMarkdownHistory` fixtures to check rendering and horizontal gestures without a relay or Provider.

Tool panels: the drawer's tools tab reads three bounded, read-only projections over `op: 'toolPanel'` — analytics (7/30/90-day usage aggregates), LLM performance (running sessions plus persisted per-round samples) and MCP trust. The host shapes each payload with hard caps and keeps unmeasured values null; the phone never folds a gap into `0` or an empty list. MCP trust runs the same static `mcpguard` scan the Mac panel runs (`mode: 'read'`): the device supplies a Provider id only, the scanned path is always the Mac's current workspace, and the report's evidence (config paths, env key names, hashes) is never sent to the device. A scan the host cannot produce reports `scanUnavailable` with a reason instead of "no risks"; unknown op or a missing host source map to explicit copy rather than a blank screen.

Slash commands: the Composer shows a native slash-command menu when the draft starts with `/`. Commands are fetched from the paired Mac over the authorized inner-mTLS channel (`op: 'commands'` → `RemoteGateway.listCommands` → `providerRegistry.listCommands`), scoped by the selected provider and authorized project cwd, deduplicated and bounded. Tapping a command inserts `/name ` (plus its argument hint context); the list filters as you type and refreshes via the menu's refresh control. `-uiMockSlash` seeds a `/` draft so the menu can be captured in the DEBUG harness; it is compiled out of Release builds.

## Architecture

- SwiftUI observes `G0Model`'s public phase/port/anchor-material digest. `G0Service` actor owns Keychain reads, private material and the transport operation. No key bytes are published to views.
- `G0Keychain` stores test credentials as non-synchronizing, AfterFirstUnlockThisDeviceOnly generic passwords. Fixture updates preserve the prior identity on validation failure; generated enrollment keys use a separate insert-only account and cannot be silently replaced by concurrent actors. No UserDefaults/plain-file fallback or Secure Enclave claim.
- `G0Service.prepareEnrollment()` generates/restores a software P-256 key in its credential actor and returns only public CSR/bootstrap material after Keychain save/readback. This method is not yet connected to a pairing UI or network endpoint; generating a key is not pairing.
- `ScryG0Transport` is the same Swift package library used by the verified macOS probe. Keys enter NIOSSL from memory, not temporary key files. Business commands are absent.
- Destination is currently fixed to loopback. Simulator → Mac works because of simulator networking; on a physical phone `127.0.0.1` is the phone itself. The app states this explicitly. Public/LAN test routing needs separate authorization and implementation.
- Imports are size-bounded test JSON, not QR pairing. The two trust anchors and preissued client certificate are fixture material, **not evidence of successful device enrollment**.

## Build

Requires Xcode with Swift 6.2+ (the locked transitive Swift collections package requires it), iOS SDK, and the local package at `experiments/remote-g0/swift`. Probe deployment minimum is iOS 17, not a frozen public-release decision.

```sh
xcodebuild -project apps/ios/ScryRemoteG0.xcodeproj \
  -scheme ScryRemoteG0 -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/scry-g0-xcode-build CODE_SIGNING_ALLOWED=NO build
```

No team, account, key, phone identifier or provisioning profile is stored in the project. Do not enable automatic provisioning against an unrelated team or claim a simulator build is an IPA.

### Real-device verification (2026-09-12, after the user connected and trusted the phone)

With the user's phone connected, trusted and in developer mode, a signed device build and on-device tests were run with the user's Personal Team (pass the team at invocation; it is never committed):

```sh
xcodebuild test -project apps/ios/ScryRemoteG0.xcodeproj -scheme ScryRemoteG0 \
  -destination 'platform=iOS,id=<device-udid>' -derivedDataPath /tmp/scry-g0-device-build \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<personal-team-id> CODE_SIGN_STYLE=Automatic
```

Three XCTests passed on the physical iPhone (fixture bounds, insert-only generated-key persistence, Keychain round-trip + failed-import preservation), proving the non-synchronizing `AfterFirstUnlockThisDeviceOnly` policy on real hardware. `testSimulatorTLSFromKeychain` correctly **skips on device**: it needs a Mac-side live relay reachable from the phone, and `127.0.0.1` on the phone is the phone itself, so real TLS-from-Keychain still awaits an authorized LAN/public relay. This is real-device Keychain evidence, **not** completed device pairing, TLS, lock-screen or cellular proof.

## Isolated simulator verification

Use a dedicated simulator, not an existing user's active device. First list supported runtimes/device types, create a dedicated device and record its returned UUID. The session used a dedicated **Scry Remote G0** iPhone 17 Pro on iOS 26.5; its receipt is local `/tmp/scry-g0-simulator-id`, not a repository constant.

```sh
# Set SIMULATOR_ID to the verified dedicated device's UUID.
xcrun simctl bootstatus "$SIMULATOR_ID" -b
xcodebuild -project apps/ios/ScryRemoteG0.xcodeproj \
  -scheme ScryRemoteG0 -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR_ID" \
  -derivedDataPath /tmp/scry-g0-xcode-build -parallel-testing-enabled NO test
node experiments/remote-g0/ios-smoke.mjs "$SIMULATOR_ID"
```

The first test command installs/launches the actual app and tests fixture bounds, actual simulator Keychain behavior and generated enrollment-key persistence. Its transport test is **skipped without the live fixture**. `ios-smoke.mjs` supplies a temporary live Node host/relay, copies mode-0600 short-lived material into the dedicated app's Documents, and runs all native tests, including the transport test. The test imports to a unique Keychain service, removes the source fixture, performs actual mTLS from the saved identity, and checks that two concurrent model calls cause only one host request. It cleans only its own fixture and unique test Keychain item. No real project/Provider account or default app identity is touched.

The harness retains `.xcresult`, logs and a non-secret report in an OS temporary evidence directory. On failure/timeout inspect the report, process state and fixture ownership before retrying; never delete an unknown previous fixture to make a retry succeed.

## Evidence and gaps (2026-09-12)

- Xcode built the native app for arm64 and x86_64 iOS Simulator with the correct simulator SDK, resolving the uncertainty from the earlier standalone SwiftPM link warning.
- Actual simulator-hosted XCTest: all 4 tests passed with the live harness; includes fixture bounds, Keychain round-trip / failed-import preservation, and generated key persistence / cross-actor insert-only behavior.
- Actual simulator `G0Model → G0Service → Keychain → shared NIOSSL → WSS relay → Node TLS`: passed; one host request for concurrent intents, TLS 1.3, no session reuse.
- No manual visual/VoiceOver, physical iPhone, phone-lock, cellular, APNs, first-pairing/CSR/grant/revocation or public deployment acceptance yet. This diagnostic screen only borrows the compact header style; it is not the three v2 product screens.
- Swift → Node CSR → issued certificate → NIOSSL interoperability and bootstrap rejection passed separately on macOS; see [enrollment evidence](../../docs/research/scry-ios-remote-enrollment-interop.md). This is not a pairing or real-device grant test.
- No paid cloud resources created; proposed costs/conditions are in [the deployment assessment](../../docs/research/scry-ios-remote-test-deployment.md).

## Product app device-side client (2026-09-12)

The product app `ScryRemote` now consumes the proven `ScryG0Transport` package
for real pairing, not UI-only:

- `PairingCode.swift` — parses the Mac's out-of-band code (`scry1:` +
  base64url(JSON)) carrying the relay endpoint, hostId, pairingId, single-use
  secret and the full host anchor PEM the device pins. Fails closed per field.
- `RemoteKeychain.swift` — device private key (insert-only) + granted cert
  (upsertable on renewal); device-only, after-first-unlock, never synchronized.
- `RemotePairingClient.swift` — generates/restores the device keypair, presents
  its self-signed bootstrap cert for TLS possession proof, pins the host anchor,
  and drives `relayPairProve` → (Mac confirms) → re-prove → granted, storing the
  issued cert. Never fabricates a paired state.
- `RemoteSelfTest.swift` — DEBUG `-selfTest` launch-argument harness.

Verified: `xcodebuild ... -sdk iphonesimulator ... build` SUCCEEDED (links
swift-nio/NIOSSL via the local package). Running the app with `-selfTest` on the
dedicated simulator prints, and this session observed:
`enrollment.csr/bootstrap/fingerprint/restore PASS`, `code.parse PASS`,
`code.badPrefix/badBase64/badSecret PASS`, `keychain SKIP
env=unsigned-simulator-missing-entitlement` (errSecMissingEntitlement -34018 on
an unsigned simulator app; the same pattern passes on the signed G0 on-device
build), `DONE failures=0`.

Gaps: the live pairing UI is not wired into `PairView` yet, and full on-device
pairing needs a reachable relay + running host (and, for a public wss relay, the
outer relay CA which the code does not yet carry — an outer-TLS deployment
follow-up, not new crypto). Keychain is exercised only on a signed build.

## Paired device model

The product reads the hardware identifier with `uname`, not `UIDevice.name`.
`RemoteDeviceModel` maps iOS-17-compatible iPhones through the verified iPhone 17e
identifiers to their marketing names. Unknown hardware displays its identifier;
add a mapping only after corroborating the identifier and marketing name in the
sources listed in that helper. Simulator labels are explicitly marked.

New pairings use this model label. After updating both the phone App and Mac host,
the first authenticated request on a reconnected lane also refreshes an existing
label such as `iPhone`; no unpair/re-pair is needed. An offline device keeps its
previous label until it sends a request. The host selects the grant from the
verified TLS peer certificate, never a request-supplied device ID. The bounded
label is self-reported display metadata, not hardware attestation, and does not
change the certificate, expiry, revocation, or owner-device authority.

Focused checks:

```sh
swift test --package-path experiments/remote-g0/swift -j 4 --filter 'DeviceModelTests|LaneHandlerTests'
npm run test:unit -- src/main/remote/pairing.test.ts src/main/remote/inner-mtls-host.test.ts src/main/remote/remote-host-service.test.ts --exclude '.local/**'
```

## History cache

`RemoteHistoryCache.swift` persists complete history in protected, backup-excluded
Caches storage (64 MiB / 20 entries). Previously downloaded history appears before
background verification; unchanged fingerprints avoid full re-downloads. Settings
can clear the cache, and destructive unpair clears it before deleting credentials.
This is disposable history, not a permanent backup or evidence that the Mac is online.

Runs sent from the phone stay visible as a local overlay. Structured turn pages
carry the Scry run id (`runId`), and the phone takes the same id from the run's
`bound` ledger marker. The phone reads host history next to local runs only
when every local run has that id. It hides a local copy only when the host page
contains its id; it never matches by prompt text. Older Macs, transcript-only
turns and runs without ids keep the earlier behavior: the base is unavailable
and the local runs stay visible. The Mac splits each relay WebSocket message at
256 KiB, because the phone rejects WebSocket frames above 1.5 MiB.

DEBUG `-historyCacheTest` exercises isolated temporary cache and store fixtures,
without a relay, real Provider calls or real recovery-checkpoint writes. Run it
separately from `-selfTest`; both print PASS/FAIL and exit. Device protection-class
verification cannot be replaced by Simulator results.
The cache is disposable history, not a permanent backup or evidence that the Mac is online.
