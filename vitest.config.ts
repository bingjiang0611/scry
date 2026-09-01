import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 让 vitest 与 app 构建对齐：automatic JSX runtime（组件不 import React）+ @shared 别名。
export default defineConfig({
  test: {
    // 项目级 Skill 自带独立测试/依赖，且 .agents 中还有同源 symlink；它们不属于 Scry test suite。
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/.{idea,git,cache,output,temp,claude,agents}/**'],
    maxWorkers: 2
  },
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  }
})
