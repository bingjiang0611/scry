// Files copied from the candidate worktree into the baseline worktree. Production source files
// are deliberately absent: both workers execute their own revision's production modules.
export const performanceAbabHarnessFiles = [
  'scripts/performance-abab-harness.mjs',
  'scripts/performance-abab-protocol.mjs',
  'scripts/performance-abab-worker.test.ts',
  'scripts/performance-baseline.test.ts',
  'scripts/performance-baseline-fixture.ts',
  'scripts/performance-baseline-scenarios.ts',
  'vitest.config.ts',
  'src/main/providers/fixtures/codex-app-server.mjs',
  '.agents/skills/scry-performance-climb/scripts/timing-run.mjs',
  '.agents/skills/scry-performance-climb/scripts/timing-observation.mjs'
]
