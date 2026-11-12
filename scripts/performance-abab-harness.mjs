// Files copied from the candidate worktree into the baseline worktree. Production source files
// are deliberately absent: both workers execute their own revision's production modules.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [candidate, baseline, ...extra] = process.argv.slice(2)
  if (!candidate || !baseline || extra.length) throw new Error('Usage: performance-abab-harness.mjs <candidate> <disposable-baseline>')
  for (const file of performanceAbabHarnessFiles) {
    const target = join(baseline, file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(candidate, file), target)
  }
}
