import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 让 vitest 与 app 构建对齐：automatic JSX runtime（组件不 import React）+ @shared 别名。
export default defineConfig({
  test: {
    // Skills、设计稿和 G0 实验有独立 runner/依赖，不作为 App Vitest suite 收集。
    // 尤其 node:test 与 SwiftPM checkout 不能由 Vitest 再执行一遍。
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/designs/**', '**/experiments/**', '**/.{idea,git,cache,output,temp,claude,agents,pi,scry}/**'],
    maxWorkers: 2
  },
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  }
})
