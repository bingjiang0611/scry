import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sweepStalePrivateMcpConfigs, writePrivateMcpConfig } from './private-mcp-config'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-private-mcp-test-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('private MCP config file', () => {
  it('writes the exact servers to a 0600 file in a fresh 0700 directory and removes it once', () => {
    const servers = { remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer secret' } } }
    const config = writePrivateMcpConfig(servers, root)!
    const path = config.extraArgs['mcp-config']
    expect(dirname(dirname(path))).toBe(root)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: servers })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    config.dispose()
    config.dispose()
    expect(existsSync(dirname(path))).toBe(false)
  })

  it('writes nothing when no server is authorized', () => {
    expect(writePrivateMcpConfig({}, root)).toBeUndefined()
  })

  it('sweeps only real directories of owners that are gone', async () => {
    const dead = join(root, 'scry-mcp-config-999999-abcDEF')
    const live = join(root, 'scry-mcp-config-424242-abcDEF')
    const own = writePrivateMcpConfig({ local: { command: '/bin/echo' } }, root)!
    const unrelated = join(root, 'scry-mcp-config-notapid-abcDEF')
    const target = join(root, 'target')
    const link = join(root, 'scry-mcp-config-999998-abcDEF')
    for (const path of [dead, live, unrelated, target]) mkdirSync(path)
    symlinkSync(target, link)

    const removed = await sweepStalePrivateMcpConfigs(root, (pid) => pid === 424242)

    expect(removed).toBe(1)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(own.extraArgs['mcp-config'])).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
    expect(existsSync(link)).toBe(true)
    expect(existsSync(target)).toBe(true)
    own.dispose()
  })
})
