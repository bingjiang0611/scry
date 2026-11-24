# 020: Verify the running build; advise on Provider versions

**Status:** Accepted (documents existing behavior)

App and daemon compatibility is a hard check. A reinstall can leave an old daemon running with the same package version, so compare version and build identity. Inject the source hash and package version once at build time into all main entry points, including daemon and supervisor; do not hash files at runtime. Two unbundled peers compare versions only; a bundled peer and an unbundled peer do not match. For equal-version mismatches show both build IDs.

Packaging checks and smoke launchers use the same [package layout resolver](../../scripts/packaged-app-layout.mjs). This keeps verification and launch pointed at the same executable on macOS and Linux, rather than relying on independently assembled paths. The bundled CLI launcher resolves the corresponding executable from its own installed location; the [wrapper fixture](../../scripts/scry-cli-wrapper.test.mjs) checks that contract. This is a path contract, not proof of build identity.

Independently released Provider CLIs require a revisable compatibility policy, not hard-coded checks in adapters. A recommendation is advisory, not observed evidence or permission to block a run. Report its source and preserve the prior valid policy if a fetch or full-manifest validation fails. Choose the newest valid manifest, keeping the current one on ties; evaluate the first matching rule for the Provider and applicable Scry version. Unparseable versions or ranges are unknown. Recognize a semantic version within native version output, retain prerelease ordering, and support intersection and union of comparison ranges.

Distinguish intentionally disabled Providers from configured Providers whose adapter could not be described; keep the latter visible with unavailable capabilities. Report account verification separately. List exact OAuth targets only for Provider-native flows the App can drive. Experimental Providers are enabled by default; an explicit list selects which of them to enable. Only cancel a diagnostic if it owns the process it would cancel; stopping the wait on a shared server is not cancellation. Bulk deletion progress is observed, not predicted, and changed catalogs invalidate the confirmation.

Codex stdio launch files use single-quoted assignments and are read on each server start; retain them for that launch lifetime and clean them up afterward. HTTP header values go in the server environment and the CLI config contains references by name, not the values. Preserve the adapter's configured home when the launcher supplies a minimal environment.

The Antigravity ACP client bounds each incoming stdio line to 16 MiB by default. Its frame parsing and handshake are live protocol evidence, separate from a registry version advisory.

See [build-identity.ts](../../src/shared/build-identity.ts), [provider-compatibility.ts](../../src/shared/provider-compatibility.ts) and [provider.ts](../../src/shared/provider.ts).
