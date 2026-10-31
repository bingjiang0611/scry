import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import base from '../electron.vite.config'
import { providerHookSource } from '../src/cli/workspace-hook-sources'

// Benchmark-only adapter injection. Production main/preload/renderer stay unchanged.
export default defineConfig({
  ...base,
  main: {
    ...base.main,
    plugins: [
      ...(base.main?.plugins ?? []),
      {
        name: 'concurrent-performance-fixture',
        enforce: 'pre',
        transform(code, id) {
          if (id !== resolve('src/main/providers/smoke.ts')) return
          const marker = '      recordCall(\'run\', request.runId)'
          if (!code.includes(marker)) throw new Error('Smoke adapter injection point changed')
          return {
            code: `import { runConcurrentFixture } from '../../../scripts/fixtures/concurrent-performance-provider'\n` + code.replace(marker,
              `${marker}\n      if (request.prompt.startsWith('concurrent performance ')) return runConcurrentFixture(request, providerId)`),
            map: null
          }
        },
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'concurrent-provider-hook.sh', source: providerHookSource() })
        }
      }
    ]
  }
})
