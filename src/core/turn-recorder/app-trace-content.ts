import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * App 侧 trace 正文库的布局。App 写入、读取与 `scry recorder content repair` 必须落在同一批字节上，
 * 所以路径规则只有这一份；recorder core 不依赖 Electron，平台默认目录由 CLI 决定。
 */
export const APP_TRACE_CONTENT_DIR = 'trace-content-v1'

/** 一个 catalog 工作区在 App 正文库里的内容根（`content/sha256/...` 的父目录）。 */
export function appTraceContentRoot(userDataDir: string, cwd: string): string {
  return join(userDataDir, APP_TRACE_CONTENT_DIR, createHash('sha256').update(cwd).digest('hex'))
}

/**
 * 这台机器上已存在的 App trace 内容根。缺失的目录不是错误：没跑过 App 的机器没有这条通路，
 * 修复命令只能报告未命中。
 */
export async function appTraceContentRoots(appDataDir: string): Promise<string[]> {
  const base = join(appDataDir, APP_TRACE_CONTENT_DIR)
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const roots: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const root = join(base, entry.name)
    try {
      if (!(await stat(join(root, 'content', 'sha256'))).isDirectory()) continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    roots.push(root)
  }
  return roots.sort()
}
