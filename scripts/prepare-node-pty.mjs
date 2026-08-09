import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform === 'darwin') {
  const helper = join(
    process.cwd(),
    'node_modules',
    'node-pty',
    'prebuilds',
    `darwin-${process.arch}`,
    'spawn-helper'
  )
  if (!existsSync(helper)) throw new Error(`node-pty spawn-helper 不存在：${helper}`)
  chmodSync(helper, 0o755)
}
