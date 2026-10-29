import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import baseline from './vitest.baseline.config'
import { viteAdapter } from './adapter'

const here = dirname(fileURLToPath(import.meta.url))
const directory = process.env.SCRY_CHECKPOINT_BUILD
if (!directory) throw new Error('SCRY_CHECKPOINT_BUILD is required')
const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as { generatedPath: string; workerPath: string }
export default {
  ...baseline,
  plugins: [viteAdapter({ repository: resolve(here, '../..'), generated: manifest.generatedPath, worker: manifest.workerPath, runtime: resolve(here, 'runtime.ts') })],
  define: { SCRY_WORKFLOW_SQLITE_WORKER: JSON.stringify(manifest.workerPath) },
  test: {
    ...baseline.test,
    setupFiles: [baseline.test.setupFiles[0], fileURLToPath(new URL('./sqlite-setup.ts', import.meta.url)), ...baseline.test.setupFiles.slice(1)]
  }
}
