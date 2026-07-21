import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareRuntimeCapabilities } from './runtime-capabilities'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-runtime-cap-'))

function writeSkill(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(join(dir, 'references'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\nUse references and assets.\n`)
  writeFileSync(join(dir, 'references', 'guide.md'), `# ${name} guide\n`)
  writeFileSync(join(dir, 'assets', 'seed.txt'), `${name} asset\n`)
}

describe('runtime capability preparation', () => {
  it('injects multiple enabled skills with references/assets metadata and readable dirs', () => {
    const home = tempDir()
    const cwd = tempDir()
    try {
      writeSkill(join(home, '.claude', 'skills'), 'design-skill')
      writeSkill(join(cwd, '.claude', 'skills'), 'audit-skill')
      const prepared = prepareRuntimeCapabilities({ runtimeProvider: 'qoder_cli', cwd, homeDir: home })
      expect(prepared.extraAllowedDirs).toEqual(
        expect.arrayContaining([join(home, '.claude', 'skills', 'design-skill'), join(cwd, '.claude', 'skills', 'audit-skill')])
      )
      expect(prepared.promptPrefix).toContain('### Skill: design-skill')
      expect(prepared.promptPrefix).toContain('### Skill: audit-skill')
      const metadata = prepared.metadata as { skills: Array<Record<string, unknown>> }
      expect(metadata.skills).toHaveLength(2)
      expect(metadata.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'design-skill',
            injectionStrategy: 'prompt+add-dir',
            references: ['guide.md'],
            assets: ['seed.txt']
          }),
          expect.objectContaining({
            id: 'audit-skill',
            injectionStrategy: 'prompt+add-dir',
            references: ['guide.md'],
            assets: ['seed.txt']
          })
        ])
      )
      expect(metadata.skills.map((skill) => skill.order).sort()).toEqual([0, 1])
      for (const skill of metadata.skills) {
        expect(skill.bodyDigest).toEqual(expect.any(String))
        expect(skill.referencesDigest).toEqual(expect.any(String))
        expect(skill.assetsDigest).toEqual(expect.any(String))
      }
      prepared.cleanup()
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('leaves Qoder MCP ownership to Qoder instead of injecting Claude MCP config', () => {
    const home = tempDir()
    const cwd = tempDir()
    try {
      mkdirSync(home, { recursive: true })
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            tracker: { command: '/bin/echo', args: ['hi'], env: { SECRET_TOKEN: 'secret-value' } },
            search: { command: '/bin/echo', args: ['search'] }
          }
        })
      )
      const prepared = prepareRuntimeCapabilities({ runtimeProvider: 'qoder_cli', cwd, homeDir: home })
      expect(prepared.mcpConfigPath).toBeUndefined()
      expect(JSON.stringify(prepared.metadata)).not.toContain('secret-value')
      const metadata = prepared.metadata as { mcpServers: Array<Record<string, unknown>> }
      expect(metadata.mcpServers).toEqual([])
      prepared.cleanup()
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('uses Codex per-run config args and reports env-backed MCP as capability failure', () => {
    const home = tempDir()
    const cwd = tempDir()
    try {
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            plain: { command: '/bin/echo', args: ['ok'] },
            needsEnv: { command: '/bin/echo', args: ['no'], env: { SECRET_TOKEN: 'secret-value' } }
          }
        })
      )
      const prepared = prepareRuntimeCapabilities({ runtimeProvider: 'codex_cli', cwd, homeDir: home })
      expect(prepared.codexConfigArgs.join(' ')).toContain('mcp_servers.plain.command')
      expect(prepared.codexConfigArgs.join(' ')).not.toContain('secret-value')
      const metadata = prepared.metadata as {
        mcpServers: Array<Record<string, unknown>>
        capabilityFailures: Array<Record<string, unknown>>
      }
      expect(metadata.mcpServers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'plain', injected: true, failureReason: null }),
          expect.objectContaining({
            id: 'needsEnv',
            injected: false,
            failureReason: 'unsupported Codex MCP config'
          })
        ])
      )
      expect(metadata.capabilityFailures).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'mcp', name: 'needsEnv', reason: 'unsupported Codex MCP config' })])
      )
      prepared.cleanup()
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('records duplicate skill and MCP names as capability failures instead of silently overwriting them', () => {
    const home = tempDir()
    const cwd = tempDir()
    try {
      writeSkill(join(home, '.claude', 'skills'), 'same-name')
      writeSkill(join(cwd, '.claude', 'skills'), 'same-name')
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            dup: { command: '/bin/echo', args: ['user'] }
          }
        })
      )
      writeFileSync(
        join(cwd, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            dup: { command: '/bin/echo', args: ['project'] }
          }
        })
      )

      const prepared = prepareRuntimeCapabilities({ runtimeProvider: 'codex_cli', cwd, homeDir: home })
      const metadata = prepared.metadata as {
        skills: Array<Record<string, unknown>>
        mcpServers: Array<Record<string, unknown>>
        capabilityFailures: Array<Record<string, unknown>>
      }
      expect(metadata.skills).toHaveLength(1)
      expect(metadata.mcpServers).toHaveLength(1)
      expect(metadata.capabilityFailures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'skill', name: 'same-name', reason: 'duplicate skill name' }),
          expect.objectContaining({ kind: 'mcp', name: 'dup', reason: 'duplicate MCP server name' })
        ])
      )
      prepared.cleanup()
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('records unreadable skill references as capability failures without aborting the run preparation', () => {
    const home = tempDir()
    const cwd = tempDir()
    const locked = join(home, '.claude', 'skills', 'fragile-skill', 'references', 'locked')
    try {
      writeSkill(join(home, '.claude', 'skills'), 'fragile-skill')
      mkdirSync(locked)
      writeFileSync(join(locked, 'secret.txt'), 'unreadable')
      chmodSync(locked, 0)

      const prepared = prepareRuntimeCapabilities({ runtimeProvider: 'qoder_cli', cwd, homeDir: home })
      const metadata = prepared.metadata as {
        skills: Array<Record<string, unknown>>
        capabilityFailures: Array<Record<string, unknown>>
      }
      expect(metadata.skills).toEqual([expect.objectContaining({ id: 'fragile-skill', enabled: true })])
      expect(metadata.capabilityFailures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'skill',
            name: 'fragile-skill',
            resource: 'references'
          })
        ])
      )
      prepared.cleanup()
    } finally {
      try {
        chmodSync(locked, 0o700)
      } catch {
        /* ignore */
      }
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
