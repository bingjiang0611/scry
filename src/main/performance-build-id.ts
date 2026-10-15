import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Build-time only. Hash source + dependency/config identity, not the user's workspace at runtime. */
export function performanceBuildId(root: string): string {
  const hash = createHash('sha256')
  const add = (relative: string): void => {
    hash.update(relative).update('\0').update(readFileSync(join(root, relative))).update('\0')
  }
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) add(path)
    }
  }
  walk('src')
  for (const file of ['package.json', 'package-lock.json', 'electron.vite.config.ts']) add(file)
  return hash.digest('hex')
}
