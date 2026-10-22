import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '../..')

export default defineConfig({
  root: repoRoot,
  test: {
    include: [resolve(here, 'fixture.test.ts')],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**'],
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 30_000
  },
  esbuild: { target: 'node20' },
  resolve: { alias: { '@shared': resolve(repoRoot, 'src/shared') } }
})
