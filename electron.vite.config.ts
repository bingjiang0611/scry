import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// externalizeDepsPlugin：把 dependencies（尤其 @anthropic-ai/claude-agent-sdk）排除出 main bundle，
// 保留在 node_modules 里——SDK 的 query() 底层要 spawn 它自带的 cli.js，被 bundle 进去就 spawn 不了。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    }
  },
  preload: {
    build: {
      // Electron's sandboxed preload loader executes CommonJS even when the app
      // package is ESM. An .mjs preload is parsed as a classic script in the
      // packaged app and never exposes the contextBridge API. Keep this as one
      // bundled file: sandboxed preload can only require Electron and built-ins.
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs', inlineDynamicImports: true }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    },
    plugins: [react()]
  }
})
