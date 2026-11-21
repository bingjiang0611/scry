// Lane names and their response policy (split out of desktop-lane.ts to keep it
// under the per-file size limit).
export type DesktopLaneName = 'control' | 'workbench' | 'terminal' | 'long' | 'status' | 'watch' | 'bulk' | 'events' | 'targetWork' | 'localHistory'

export const LANE_POLICY: Record<DesktopLaneName, { responseTimeoutMs: number; abortOnCancel: boolean }> = {
  control: { responseTimeoutMs: 30_000, abortOnCancel: false },
  // A write: cancelling the caller must not tear down a write whose bytes may have landed.
  workbench: { responseTimeoutMs: 30_000, abortOnCancel: false },
  // Input is a write: cancelling must not tear down a keystroke that may have landed.
  terminal: { responseTimeoutMs: 30_000, abortOnCancel: false },
  // The OAuth loopback waits 2 minutes for the browser; a test may install a server first;
  // a billing sync reads pages of 20 s each.
  long: { responseTimeoutMs: 5 * 60_000, abortOnCancel: false },
  watch: { responseTimeoutMs: 40_000, abortOnCancel: true },
  status: { responseTimeoutMs: 40_000, abortOnCancel: true },
  events: { responseTimeoutMs: 40_000, abortOnCancel: true },
  targetWork: { responseTimeoutMs: 40_000, abortOnCancel: true },
  bulk: { responseTimeoutMs: 30_000, abortOnCancel: true },
  localHistory: { responseTimeoutMs: 30_000, abortOnCancel: false }
}
