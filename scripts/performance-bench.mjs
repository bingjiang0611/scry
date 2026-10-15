import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const output = process.argv[2]
if (!output) throw new Error('Usage: npm run performance:bench -- <output.json>')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = resolve(output)
mkdirSync(dirname(target), { recursive: true })
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim().length > 0
const result = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'scripts/performance-baseline.test.ts', '--maxWorkers=1'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SCRY_PERFORMANCE_OUTPUT: target, SCRY_PERFORMANCE_REVISION: `${revision}${dirty ? '-dirty' : ''}` }
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
