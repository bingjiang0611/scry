import { afterEach, vi } from 'vitest'

vi.mock('esbuild', async importOriginal => {
  const actual = await importOriginal<typeof import('esbuild')>()
  const { esbuildAdapter } = await import('./adapter')
  const { readFile } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  const directory = process.env.SCRY_CHECKPOINT_BUILD!
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as { sourcePath: string; generatedPath: string; workerPath: string }
  const paths = { repository: resolve(manifest.sourcePath, '../../..'), generated: manifest.generatedPath,
    worker: manifest.workerPath, runtime: resolve(process.cwd(), 'experiments/workflow-checkpoint/runtime.ts') }
  return { ...actual, build: (options: import('esbuild').BuildOptions) => actual.build({ ...options,
    plugins: [...(options.plugins ?? []), esbuildAdapter(paths)],
    define: { ...options.define, SCRY_WORKFLOW_SQLITE_WORKER: JSON.stringify(paths.worker) }
  }) }
})
afterEach(async context => {
  // Let contract suites register their fs fault probes before Runtime/io loads.
  const { closeAll, storageReport } = await import('./runtime')
  await closeAll()
  console.log('CHECKPOINT_SQLITE', JSON.stringify({ name: context.task.name, ...storageReport() }))
})
