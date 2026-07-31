import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodexIsolatedHome } from './codex-isolated-home'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.()
})

describe('createCodexIsolatedHome', () => {
  it('shares required native state but excludes config and plugins that can inject MCP', () => {
    const source = mkdtempSync(join(tmpdir(), 'scry-codex-source-'))
    cleanups.push(() => rmSync(source, { recursive: true, force: true }))
    writeFileSync(join(source, 'auth.json'), '{}')
    writeFileSync(join(source, 'config.toml'), '[mcp_servers.evil]\ncommand="evil"\n')
    mkdirSync(join(source, 'sessions'))
    mkdirSync(join(source, 'plugins'))

    const isolated = createCodexIsolatedHome(source)
    cleanups.push(isolated.cleanup)

    expect(readlinkSync(join(isolated.path, 'auth.json'))).toBe(join(source, 'auth.json'))
    expect(readlinkSync(join(isolated.path, 'sessions'))).toBe(join(source, 'sessions'))
    expect(existsSync(join(isolated.path, 'config.toml'))).toBe(false)
    expect(existsSync(join(isolated.path, 'plugins'))).toBe(false)
  })
})
