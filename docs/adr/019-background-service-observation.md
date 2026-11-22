# 019: Report what the App observed about its background service

**Status:** Accepted (documents existing behavior)

An in-process runtime has no background service. An unanswered daemon query leaves PID, start time, device count and run count unknown; do not display zero. Count paired devices, not the App's own local grant. Distinguish a source/build mismatch from refusal of a local grant; a refused daemon may not report its version. Use build labels when version numbers coincide. Expose only effective non-secret remote policy, including when an adopted daemon differs from the App environment. Report that drift and service-manager fallback in both Settings and run/send.

Launcher identity is self-reported and may be absent from older or ad-hoc launches. On Linux, verify a service-managed launch against systemd's main PID and the daemon-reported supervisor PID. Include status observation time so the UI can communicate freshness. Only report orchestration or CLI approval state where the daemon actually provides it. Reject saving a local grant if secure storage is unavailable or resolves to Linux plaintext storage; report what was observed, not an inferred keyring diagnosis.

The settings bridge exposes fixed operations, with a boolean only for login-start configuration. Main owns service paths and definitions and presents native confirmations.

The supervisor reports its bundled version; service definitions need no version pin to survive upgrades. An explicit environment version must agree with the bundle; unbundled launchers supply it themselves. The daemon receives its version from the supervisor. Launcher type is optional for compatibility with older launchers, but unknown explicit values are rejected. On startup, use stable machine reasons to distinguish conditions that need operator action from retryable failures; do not persist free-form exception text as the reason.

The App and login service share package and user-data path derivation. Do not install a persistent login service from a mounted disk image or a translocated App. Test overrides require explicit test mode and cannot name the production service. Ignore relative `XDG_CONFIG_HOME` values. Precreate the shared append log with owner-only modes on creation instead of inheriting the service manager's umask; keep existing diagnostic content. Bounded retention is tracked in [#165](https://github.com/bingjiang0611/scry/issues/165).

Background work is an observation stream, not a task inventory or process audit. Its start time describes received launch evidence. Losing observation is not proof that work stopped. Use a monotonic per-run revision when present; older archives may not carry it.

See [background-service.ts](../../src/shared/background-service.ts), [background-work.ts](../../src/shared/background-work.ts), and [background service status tests](../../src/main/background-service-status.test.ts).
