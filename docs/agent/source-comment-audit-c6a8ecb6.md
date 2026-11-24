# Comment review paths at `c6a8ecb6`

This is the exact scope of one [contextual review](source-comment-audit.md), not a repository-wide completion record. Blob IDs refer to the reviewed source before the cleanup. The counts below include recommendations still in place; `ADR` and `Issue` do not mean those follow-ups were executed.

| Slice | Files | Comment tokens |
| --- | ---: | ---: |
| Bootstrap | 42 | 249 |
| Provider | 21 | 143 |
| Remote | 12 | 148 |
| Total | 75 | 540 |

## Bootstrap

| Path | Git blob (first 12 hex) | Keep | Remove candidate | ADR candidate | Issue candidate |
| --- | --- | ---: | ---: | ---: | ---: |
| `src/main/bootstrap/app-agent.ts` | `e079b5bc4c30` | 1 | 0 | 0 | 0 |
| `src/main/bootstrap/app-daemon-mode-deps.ts` | `e7173d7484cd` | 9 | 1 | 0 | 0 |
| `src/main/bootstrap/archive.ts` | `6f20dd51a1e0` | 11 | 0 | 0 | 0 |
| `src/main/bootstrap/attention-state.ts` | `7243ee291719` | 3 | 0 | 0 | 0 |
| `src/main/bootstrap/conversation.ts` | `394fcb5b126f` | 7 | 5 | 0 | 0 |
| `src/main/bootstrap/daemon-launch.test.ts` | `6d4e16a52cc1` | 0 | 1 | 0 | 0 |
| `src/main/bootstrap/daemon-launch.ts` | `25d70d6a399c` | 7 | 0 | 4 | 2 |
| `src/main/bootstrap/daemon-owned-channels.ts` | `987984ad036c` | 2 | 0 | 0 | 0 |
| `src/main/bootstrap/daemon-run-lazy-restart.test.ts` | `058c364fe4ee` | 2 | 3 | 0 | 0 |
| `src/main/bootstrap/daemon-run-lazy.test.ts` | `56bda2376af2` | 4 | 2 | 0 | 0 |
| `src/main/bootstrap/daemon-run-lazy.ts` | `874349439590` | 4 | 0 | 0 | 1 |
| `src/main/bootstrap/daemon-run-mode.test.ts` | `46648a592162` | 6 | 2 | 2 | 0 |
| `src/main/bootstrap/daemon-run-mode.ts` | `5b45b52574b9` | 4 | 0 | 0 | 1 |
| `src/main/bootstrap/daemon-run-surface.test.ts` | `13150c238ea3` | 7 | 4 | 0 | 0 |
| `src/main/bootstrap/daemon-run-surface.ts` | `89f30758af9b` | 14 | 0 | 0 | 0 |
| `src/main/bootstrap/daemon-workspace-start.test.ts` | `01f21c69df99` | 0 | 4 | 0 | 0 |
| `src/main/bootstrap/host-admin-notifications.test.ts` | `efd854f0d212` | 0 | 1 | 0 | 0 |
| `src/main/bootstrap/host-admin-notifications.ts` | `eb2069e6b5cb` | 3 | 0 | 0 | 0 |
| `src/main/bootstrap/known-project-daemon.ts` | `43f4a710e1bb` | 2 | 0 | 7 | 1 |
| `src/main/bootstrap/mcp-channels.ts` | `8412d91a0c75` | 7 | 1 | 0 | 5 |
| `src/main/bootstrap/mcp-daemon.ts` | `dde37e2fc106` | 4 | 0 | 0 | 0 |
| `src/main/bootstrap/mcp-trust-early-startup.test.ts` | `0c6beb5099dd` | 1 | 0 | 0 | 0 |
| `src/main/bootstrap/new-session-daemon.ts` | `f31209573e69` | 1 | 0 | 0 | 0 |
| `src/main/bootstrap/pairing-channels.ts` | `ff75935f4186` | 5 | 1 | 0 | 0 |
| `src/main/bootstrap/pi-profiles.ts` | `ca9ef8ec136c` | 2 | 0 | 0 | 0 |
| `src/main/bootstrap/query-channels.test.ts` | `1453acfeb8c4` | 2 | 0 | 0 | 0 |
| `src/main/bootstrap/query-channels.ts` | `d84a0c48a558` | 12 | 1 | 5 | 1 |
| `src/main/bootstrap/recovery-admission.test.ts` | `0007902468b4` | 1 | 0 | 0 | 0 |
| `src/main/bootstrap/remote-connections.test.ts` | `f64bca0919fe` | 0 | 1 | 0 | 0 |
| `src/main/bootstrap/remote-connections.ts` | `dc09bff5d711` | 7 | 1 | 0 | 0 |
| `src/main/bootstrap/remote-history.ts` | `65d7b9ce2c52` | 1 | 0 | 0 | 0 |
| `src/main/bootstrap/remote-relay.ts` | `20edf5e6c1bc` | 9 | 0 | 0 | 0 |
| `src/main/bootstrap/renderer-restart.ts` | `6149c518509e` | 2 | 0 | 0 | 0 |
| `src/main/bootstrap/terminal-channels.ts` | `b421fd263739` | 0 | 0 | 0 | 4 |
| `src/main/bootstrap/terminal-daemon.test.ts` | `d9005eab9dc4` | 1 | 0 | 0 | 1 |
| `src/main/bootstrap/terminal-daemon.ts` | `e03ebf58e774` | 6 | 0 | 4 | 0 |
| `src/main/bootstrap/terminal-runtime.ts` | `17a83cca7e7f` | 1 | 1 | 0 | 0 |
| `src/main/bootstrap/trust.ts` | `3d5cde495dea` | 2 | 0 | 1 | 0 |
| `src/main/bootstrap/turn-terminal-evidence.ts` | `8a32a9335385` | 2 | 0 | 0 | 0 |
| `src/main/bootstrap/userdata-owner.ts` | `959e805cbfd0` | 5 | 0 | 3 | 0 |
| `src/main/bootstrap/window.ts` | `977fc47d9172` | 11 | 0 | 0 | 0 |
| `src/main/bootstrap/workspace.ts` | `73e7936047c4` | 6 | 2 | 1 | 1 |

## Provider

| Path | Git blob (first 12 hex) | Keep | Remove candidate | ADR candidate | Issue candidate |
| --- | --- | ---: | ---: | ---: | ---: |
| `src/main/providers/argv-recorder.fixture.ts` | `8d6e4954dca9` | 3 | 0 | 0 | 0 |
| `src/main/providers/catalog-performance.test.ts` | `f9589099cbd8` | 0 | 0 | 0 | 2 |
| `src/main/providers/catalog-reuse-counters.test.ts` | `ed258b44cfb8` | 3 | 0 | 0 | 0 |
| `src/main/providers/continuation-identity.ts` | `ef02650395cb` | 3 | 0 | 0 | 0 |
| `src/main/providers/fixtures/codex-app-server.mjs` | `85366815c1a8` | 5 | 0 | 0 | 0 |
| `src/main/providers/fixtures/fake-agy-acp.mjs` | `a5f0b4f241c2` | 1 | 0 | 0 | 1 |
| `src/main/providers/historical-input.ts` | `1bcb8b52b94b` | 5 | 0 | 0 | 0 |
| `src/main/providers/host-continuation-identity.test.ts` | `4a03e1212785` | 5 | 1 | 0 | 0 |
| `src/main/providers/host-continuation-identity.ts` | `34bac554f0a8` | 10 | 1 | 0 | 2 |
| `src/main/providers/private-mcp-config.ts` | `5151bebe2f8f` | 6 | 0 | 1 | 4 |
| `src/main/providers/provider-historical-input.test.ts` | `4d261a179b6e` | 4 | 0 | 0 | 0 |
| `src/main/providers/provider-warm-pool.test.ts` | `7778cd336042` | 1 | 2 | 0 | 0 |
| `src/main/providers/provider-warm-pool.ts` | `2fc1daa47115` | 16 | 3 | 0 | 2 |
| `src/main/providers/session-fork-boundary.ts` | `687c345c7df9` | 4 | 0 | 0 | 0 |
| `src/main/providers/smoke-concurrency-trace.test.ts` | `45a7cf38af71` | 2 | 0 | 0 | 0 |
| `src/main/providers/smoke-history-reader.test.ts` | `3e3755011b59` | 1 | 0 | 0 | 1 |
| `src/main/providers/smoke-history-reader.ts` | `2841f6cee20f` | 7 | 3 | 0 | 1 |
| `src/main/providers/smoke-paced-stream.ts` | `ed791848d670` | 9 | 0 | 0 | 0 |
| `src/main/providers/smoke-scenarios.ts` | `a5568c3c1bdc` | 6 | 0 | 0 | 3 |
| `src/main/providers/smoke.ts` | `c063bc3dd457` | 4 | 1 | 0 | 2 |
| `src/main/providers/types.ts` | `373fcb20d46c` | 18 | 0 | 0 | 0 |

## Remote

| Path | Git blob (first 12 hex) | Keep | Remove candidate | ADR candidate | Issue candidate |
| --- | --- | ---: | ---: | ---: | ---: |
| `src/main/remote/history-context.ts` | `8e83a241065a` | 5 | 0 | 0 | 0 |
| `src/main/remote/history-reader.test.ts` | `5cd6ff13996c` | 2 | 1 | 0 | 0 |
| `src/main/remote/history-reader.ts` | `9de9a1322f2d` | 18 | 0 | 4 | 2 |
| `src/main/remote/pairing-file.ts` | `180b2741863c` | 8 | 0 | 0 | 1 |
| `src/main/remote/pairing-retention.test.ts` | `290a31e69d67` | 5 | 0 | 0 | 2 |
| `src/main/remote/pairing-retention.ts` | `20d9c1c3f9f6` | 7 | 0 | 0 | 0 |
| `src/main/remote/pairing-state.ts` | `c2f1f1338c65` | 9 | 0 | 0 | 11 |
| `src/main/remote/pairing-transport.test.ts` | `587b2bfe2607` | 1 | 4 | 0 | 1 |
| `src/main/remote/pairing-transport.ts` | `ae2230d1271f` | 20 | 0 | 13 | 6 |
| `src/main/remote/session-history-display.test.ts` | `123d90475b48` | 2 | 0 | 0 | 0 |
| `src/main/remote/session-ledger.test.ts` | `51b9ca2154dd` | 10 | 6 | 0 | 0 |
| `src/main/remote/session-ledger.ts` | `d44144932df2` | 10 | 0 | 0 | 0 |
