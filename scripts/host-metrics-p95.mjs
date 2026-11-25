// 显式跑 P8 §4 的采样性能门限，并把结果写进证据目录。
// 用法：node scripts/host-metrics-p95.mjs <output.json> [samples]
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const output = process.argv[2]
if (!output) throw new Error('Usage: node scripts/host-metrics-p95.mjs <output.json> [samples]')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = resolve(output)
mkdirSync(dirname(target), { recursive: true })
const result = spawnSync(process.execPath, [
  resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'src/daemon/host-metrics-p95.test.ts', '--maxWorkers=1'
], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    SCRY_HOST_METRICS_P95: '1',
    SCRY_HOST_METRICS_P95_OUTPUT: target,
    ...(process.argv[3] ? { SCRY_HOST_METRICS_P95_SAMPLES: process.argv[3] } : {})
  }
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
