import { writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { build } from 'vite'

// Builds the hidden-UI fixtures for session-capability-ui-smoke.mjs into `temp`: one IIFE
// page bundle per fixture, the meta-prompts preload and IPC bundles, and each page's HTML.
// Split from the smoke runner by responsibility (bundling vs. driving the campaigns).
export async function buildCapabilityFixtures({ root, temp, fixtures }) {
  for (const fixture of fixtures) await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: {
        entry: join(root, `scripts/fixtures/${fixture}-smoke.tsx`),
        formats: ['iife'],
        name: 'ScryRegression',
        fileName: () => `${fixture}.js`,
        cssFileName: fixture
      }
    }
  })
  if (fixtures.includes('meta-prompts')) {
    for (const [entry, name] of [[join(root, 'src/preload/index.ts'), 'meta-prompts-preload'], [join(root, 'scripts/fixtures/meta-prompts-ipc.ts'), 'meta-prompts-ipc']]) {
      await build({
        configFile: false, root: temp, envDir: temp, logLevel: 'error',
        build: {
          outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
          lib: { entry, formats: ['cjs'], fileName: () => `${name}.cjs` },
          // The IPC fixture is main-process code (Node built-ins external); the sandboxed
          // preload stays browser-shaped, so a Node import there still fails its build.
          rollupOptions: { external: name === 'meta-prompts-ipc' ? ['electron', /^node:/, ...builtinModules] : ['electron'] }
        }
      })
    }
  }
  for (const fixture of fixtures) await writeFile(join(temp, `${fixture}.html`), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'${['sidebar-activity', 'motion-tokens', 'session-cache', 'overlays', 'lists', 'loading'].includes(fixture) ? '; img-src data:' : ''}"><link rel="stylesheet" href="${fixture}.css"><div id="root"></div><script src="${fixture}.js"></script>`)
}
