# 002: Manage integration hooks by ownership, not command text

**Status:** Accepted (documents existing behavior)

A generated hook command changes over time, but the workspace files it was written to survive a CLI upgrade. Matching by the exact command would turn an older hook into a false negative and can install a duplicate.

Use the managed handler ID to identify Scry's entries. Repair only already-installed integrations by replacing their entries with the canonical form; uninstall only entries owned by Scry. Leave foreign entries, records, config, and the Git exclude entry alone so uninstall cannot silently discard a team's evidence. Drop a hook group only when empty.

A CLI upgrade does not rewrite the workspace script. Managed drift is `outdated` until init or repair rewrites it. A hand-written bridge is `unmanaged`, not a repair target.

See [workspace-provider-detection.ts](../../src/cli/workspace-provider-detection.ts) and [workspace-integrations.ts](../../src/cli/workspace-integrations.ts).
