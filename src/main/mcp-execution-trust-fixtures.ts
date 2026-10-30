import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function fixture(): { root: string; homeDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'scry-mcp-trust-'))
  const homeDir = join(root, 'home')
  const cwd = join(root, 'repo')
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  return { root, homeDir, cwd }
}

export function displayWidth(value: string): number {
  return [...value].reduce((width, char) => width + (char.codePointAt(0)! > 0x7f ? 2 : 1), 0)
}

export { chmodSync, realpathSync, rmSync, writeFileSync, join }
