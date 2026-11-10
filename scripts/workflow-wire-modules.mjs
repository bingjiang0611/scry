#!/usr/bin/env node
// Load the production normalizer and workflow projection from source.
//
// The comparison scripts must run the same code the App runs, including the TypeScript
// modules, and must not depend on a stale `out/` build. esbuild (already installed via
// Vite) bundles a tiny entry that re-exports exactly the two functions into a temp ESM file.
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let cached

/** @returns {Promise<{ normalizeSdkMessage: Function, deriveWorkflowRuns: Function, clampFloat?: Function }>} */
export async function loadWorkflowModules() {
  if (cached) return cached
  const dir = await mkdtemp(join(tmpdir(), 'scry-workflow-modules-'))
  const entry = join(dir, 'entry.ts')
  await writeFile(entry, [
    `export { normalizeSdkMessage } from ${JSON.stringify(join(root, 'src/main/normalize.ts'))}`,
    `export { deriveWorkflowRuns, workflowAgentStatus } from ${JSON.stringify(join(root, 'src/renderer/workflow-runs.ts'))}`,
    `export { readWorkflowActivity } from ${JSON.stringify(join(root, 'src/shared/claude-workflow.ts'))}`,
    `export { workflowFixtureMessages } from ${JSON.stringify(join(root, 'src/shared/claude-workflow.fixture.ts'))}`,
    ''
  ].join('\n'))
  await build({
    configFile: false,
    root: dir,
    envDir: dir,
    logLevel: 'error',
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: dir,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      ssr: true,
      lib: { entry, formats: ['es'], fileName: () => 'modules.mjs' }
    }
  })
  // Vite names a lib bundle after its entry; take whatever single module it emitted.
  const emitted = (await readdir(dir)).find((name) => name.endsWith('.mjs') && name !== 'entry.ts')
  if (!emitted) throw new Error('the workflow module bundle produced no output')
  const modules = await import(pathToFileURL(join(dir, emitted)).href)
  cached = { ...modules, cleanup: () => rm(dir, { recursive: true, force: true }) }
  return cached
}
