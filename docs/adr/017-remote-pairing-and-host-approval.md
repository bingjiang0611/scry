# 017: Keep device approval local and distinct from transport

**Status:** Accepted (documents existing behavior)

The local pairing screen needs the short-lived, single-use code and host trust anchor so a device can reach and verify the host. Do not expose the stored verifier, private keys, or issued client certificates to that screen. The relay code is absent when no relay route is advertised. This does not rule out a separately configured Desktop connection. A device proves possession first; the operator then confirms its displayed fingerprint. Keep revocation in durable host state even when the UI omits revoked devices. Relay counts only cover the host's own connections and do not prove relay-side capacity or availability.

Host CLI support and permission to approve via CLI are separate. The feature defaults to enabled unless explicitly switched off; the approval switch itself defaults off and requires native App confirmation. Readers had to accept approval provenance before writers published it. With the feature off, do not expose its switch or admin socket or write approval provenance. A notice may record the operation and a display-only fingerprint prefix, not secrets, invite strings or private keys. Managed provider and terminal environments carry a marker to prevent accidental host-admin operations; this is not a sandbox.

Remote host enablement is one dependency-light rule shared by App, daemon and CLI. An unset value permits remote access in packaged builds, not in development. Report disabled rather than presenting an empty ready host.

See [remote.ts](../../src/shared/remote.ts), [remote-host-policy.ts](../../src/shared/remote-host-policy.ts), [experimental-host-cli.ts](../../src/shared/experimental-host-cli.ts) and [host-admin.ts](../../src/shared/host-admin.ts).
