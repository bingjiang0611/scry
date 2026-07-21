import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { billingRowsFromItems } from './billing-ledger'
import { runCliAgent } from './cli-runtime'
import { prepareRuntimeCapabilities } from './runtime-capabilities'
import { FILE_OP_COLS, SPAN_COLS, USAGE_LEDGER_COLS, spanRowsFromItems } from './span-ledger'
import type { TraceEvent } from '../shared/trace'

const tempDir = (name: string): string => mkdtempSync(join(tmpdir(), name))

function fakeCli(): string {
  const dir = tempDir('scry-runtime-vertical-cli-')
  const file = join(dir, 'fake-qoder')
  writeFileSync(
    file,
    `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"qoder-vertical","model":"auto"}'
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"mcp-a","name":"mcp__alpha__lookup","input":{"query":"needle"}},{"type":"tool_result","tool_use_id":"mcp-a","content":"alpha-result"},{"type":"tool_use","id":"mcp-b","name":"mcp__beta__lookup","input":{"query":"needle"}},{"type":"tool_use","id":"skill-1","name":"Skill","input":{"skill":"project-skill","instruction":"read references"}},{"type":"tool_use","id":"write-1","name":"Write","input":{"file_path":"/tmp/scry-vertical.txt","content":"ok"}}]}}'
printf '%s\\n' '{"type":"result","usage":{"input_tokens":11,"output_tokens":7},"duration_ms":25,"stop_reason":"success","is_error":false}'
`
  )
  chmodSync(file, 0o755)
  return file
}

function writeSkill(root: string, name: string): void {
  const dir = join(root, name)
  mkdirSync(join(dir, 'references'), { recursive: true })
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\nUse references and assets.\n`)
  writeFileSync(join(dir, 'references', 'guide.md'), `# ${name} reference\n`)
  writeFileSync(join(dir, 'assets', 'seed.txt'), `${name} asset\n`)
}

const rowAs = (cols: readonly string[], row: unknown[]): Record<string, unknown> =>
  Object.fromEntries(cols.map((c, i) => [c, row[i]]))

describe('runtime vertical slice（capabilities -> CLI stream -> spans -> ledger）', () => {
  it('keeps Qoder MCP/skill/file usage traceable without using a real model call', async () => {
    const home = tempDir('scry-runtime-vertical-home-')
    const cwd = tempDir('scry-runtime-vertical-cwd-')
    const sampleRoot = join(cwd, '.local', 'opendesign-adapter-samples')
    const cli = fakeCli()
    try {
      writeSkill(join(home, '.claude', 'skills'), 'user-skill')
      writeSkill(join(cwd, '.claude', 'skills'), 'project-skill')
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            alpha: { command: '/bin/echo', args: ['alpha'] },
            beta: { command: '/bin/echo', args: ['beta'], env: { TOKEN: 'secret-token' } }
          }
        })
      )

      const capabilities = prepareRuntimeCapabilities({ runtimeProvider: 'qoder_cli', cwd, homeDir: home })
      expect(capabilities.mcpConfigPath).toBeUndefined()
      expect(capabilities.extraAllowedDirs).toEqual(
        expect.arrayContaining([join(home, '.claude', 'skills', 'user-skill'), join(cwd, '.claude', 'skills', 'project-skill')])
      )

      const events: TraceEvent[] = []
      const handle = runCliAgent('DO_NOT_WRITE_VERTICAL_PROMPT', 'run-vertical', (event) => events.push(event), {
        runtimeProvider: 'qoder_cli',
        executablePath: cli,
        env: process.env as Record<string, string>,
        cwd,
        extraAllowedDirs: capabilities.extraAllowedDirs,
        promptPrefix: capabilities.promptPrefix,
        capabilityMetadata: capabilities.metadata,
        sampleRoot
      })
      await expect(handle.promise).resolves.toMatchObject({ sessionId: 'qoder-vertical' })
      capabilities.cleanup()

      const spanRows = spanRowsFromItems({ runId: 'run-vertical', sessionId: 'qoder-vertical', cwd, items: events, nowMs: 1 })
      const spans = spanRows.spans.map((row) => rowAs(SPAN_COLS, row))
      const fileOps = spanRows.fileOps.map((row) => rowAs(FILE_OP_COLS, row))
      expect(spans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'tool', tool: 'mcp__alpha__lookup', mcp_server: 'alpha' }),
          expect.objectContaining({ kind: 'tool', tool: 'mcp__beta__lookup', mcp_server: 'beta' }),
          expect.objectContaining({ kind: 'skill', tool: 'Skill', name: 'project-skill' }),
          expect.objectContaining({ kind: 'harness', stage: 'result', tokens_in: 11, tokens_out: 7 })
        ])
      )
      expect(fileOps).toEqual([
        expect.objectContaining({ op: 'write', path: '/tmp/scry-vertical.txt', source: 'tool-input', confidence: 'exact' })
      ])

      const ledgerRows = billingRowsFromItems({
        runId: 'run-vertical',
        sessionId: 'qoder-vertical',
        cwd,
        items: events,
        nowMs: 1,
        runtimeProvider: 'qoder_cli',
        billingProvider: 'qoder'
      }).usageLedger
      const ledger = rowAs(USAGE_LEDGER_COLS, ledgerRows[0])
      const metadata = JSON.parse(String(ledger.metadata_json)) as Record<string, unknown>
      const capabilitiesMeta = metadata.capabilities as {
        skills: Array<Record<string, unknown>>
        mcpServers: Array<Record<string, unknown>>
      }
      expect(ledger).toMatchObject({
        provider: 'qoder',
        source: 'qoder_cli_result',
        cost: null,
        cost_source: 'provider_reported',
        confidence: 'provider_reported'
      })
      expect(metadata).toMatchObject({
        runtimeProvider: 'qoder_cli',
        rawUsage: { input_tokens: 11, output_tokens: 7 }
      })
      expect(String(metadata.samplePath)).toMatch(/\/\.local\/opendesign-adapter-samples\/qoder\//)
      expect(capabilitiesMeta.skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'project-skill', references: ['guide.md'], assets: ['seed.txt'] }),
          expect.objectContaining({ id: 'user-skill', references: ['guide.md'], assets: ['seed.txt'] })
        ])
      )
      expect(capabilitiesMeta.mcpServers).toEqual(
        []
      )

      const providerDir = join(sampleRoot, 'qoder')
      const sampleDir = join(providerDir, readdirSync(providerDir)[0])
      const commandSummary = readFileSync(join(sampleDir, 'command-summary.json'), 'utf8')
      const environmentSummary = readFileSync(join(sampleDir, 'environment-summary.json'), 'utf8')
      expect(commandSummary).not.toContain('DO_NOT_WRITE_VERTICAL_PROMPT')
      expect(commandSummary).toContain('$TMPDIR')
      expect(commandSummary).not.toContain(sampleRoot)
      expect(environmentSummary).not.toContain('secret-token')
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
      rmSync(cli.replace(/\/fake-qoder$/, ''), { recursive: true, force: true })
    }
  })
})
