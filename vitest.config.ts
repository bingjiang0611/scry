import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 让 vitest 与 app 构建对齐：automatic JSX runtime（组件不 import React）+ @shared 别名。
export default defineConfig({
  test: {
    // Skills、设计稿、G0 实验和 .local 验收源码副本不作为 App Vitest suite 收集。
    // 尤其 node:test、SwiftPM checkout 与旧 Electron fixture 不能再执行一遍。
    exclude: ['src/core/turn-recorder/recorder-tests/**', 'src/main/managed-turn-tests/**', '**/node_modules/**', '**/dist/**', '**/out/**', '**/designs/**', '**/experiments/**', '**/.{idea,git,cache,output,temp,claude,agents,pi,scry,local}/**'],
    // 每个文件用临时 HOME／SCRY_GRANT_DIR，并拒绝让真实 ~/.scry 发生变化。见文件头部说明。
    globalSetup: ['./src/test-support/isolated-home-root.ts'],
    setupFiles: ['./src/test-support/user-home-isolation.ts'],
    maxWorkers: 2,
    // Keep optional experimental providers and Host CLI disabled in ordinary unit fixtures.
    env: {
      SCRY_EXPERIMENTAL_HOST_CLI: process.env.SCRY_EXPERIMENTAL_HOST_CLI ?? '0',
      SCRY_EXPERIMENTAL_PROVIDERS: process.env.SCRY_EXPERIMENTAL_PROVIDERS ?? ''
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}', 'src/**/*.bench.{ts,tsx}', 'src/**/*.d.ts',
        'src/renderer/components/render-tests/**', 'src/renderer/css-test-reader.ts',
        'src/test-support/**'
      ],
      reporter: ['text-summary', 'json', 'json-summary', 'html']
    }
  },
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  }
})
