import { isAbsolute } from 'node:path'

/** A project directory named by the renderer: absolute and bounded, nothing else checked. */
export function projectCwdFromRequest(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096) throw new Error('无效的项目目录')
  return value
}
