# Scry iOS workspace

Current target: **ScryRemoteG0** (`com.scry.remote.g0`), an isolated native SwiftUI transport/Keychain verification app. It is **not** the completed Codex-aligned Scry mobile product and cannot start Providers, write project files or operate terminals. Production UI and G1–G5 remain in [the implementation ledger](../../docs/research/scry-ios-remote-implementation.md).

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
