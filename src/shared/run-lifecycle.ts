/**
 * The terminal run lifecycles, as plain strings so both Electron main and the orchestration core can
 * use one list. `host-runtime/orchestration/run-transitions.ts` re-exports these with its own narrow
 * types; main may not import that module (Layer 3 single-writer), so the fact lives here.
 */
export const TERMINAL_RUN_LIFECYCLE_NAMES: readonly string[] = [
  'settled',
  'failed',
  'cancelled',
  'interrupted',
  // D5: a rolled-back run is finished. Leaving it out let one rolled-back run block its session.
  'rolled_back'
]

export const TERMINAL_RUN_LIFECYCLE_SQL = `(${TERMINAL_RUN_LIFECYCLE_NAMES.map((state) => `'${state}'`).join(', ')})`
