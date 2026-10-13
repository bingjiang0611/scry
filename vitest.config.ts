import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 让 vitest 与 app 构建对齐：automatic JSX runtime（组件不 import React）+ @shared 别名。
export default defineConfig({
  test: {
    // Skills、设计稿、G0 实验和 .local 验收源码副本不作为 App Vitest suite 收集。
    // 尤其 node:test、SwiftPM checkout 与旧 Electron fixture 不能再执行一遍。
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/designs/**', '**/experiments/**', '**/.{idea,git,cache,output,temp,claude,agents,pi,scry,local}/**'],
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.bench.{ts,tsx}', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json', 'json-summary', 'html']
    }
  },
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  }
})
