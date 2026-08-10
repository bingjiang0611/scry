import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 让 vitest 与 app 构建对齐：automatic JSX runtime（组件不 import React）+ @shared 别名。
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/.{idea,git,cache,output,temp}/**'],
    maxWorkers: 2
  },
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  }
})
