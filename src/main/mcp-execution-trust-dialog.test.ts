import { mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  McpExecutionTrust,
  buildMcpExecutionSnapshot,
  confirmMcpExecutionAuthorization,
  mcpExecutionAuthorizationDetail,
  mcpExecutionAuthorizationDialogOptions,
  mcpExecutionAuthorizationPages,
  mcpExecutionAuthorizationPrompt,
  mcpExecutionBlockingTargetIds,
  mcpExecutionGuardSummary
} from './mcp-execution-trust'
import { displayWidth, fixture, join, chmodSync, rmSync, writeFileSync } from './mcp-execution-trust-fixtures'

describe('MCP execution trust', () => {
  it('keeps a 15-target authorization readable without hiding targets or secrets', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      const mcpServers = Object.fromEntries(Array.from({ length: 15 }, (_, index) => {
        const name = `server-${String(index + 1).padStart(2, '0')}`
        return [name, index === 0
          ? {
              url: 'https://url-user:url-secret@example.test/mcp?token=query-secret',
              env: { API_KEY: 'configured-secret' },
              headers: { Authorization: 'Bearer header-secret' }
            }
          : { url: `https://mcp-${index + 1}.example.test/api` }]
      }))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }))
      const snapshot = buildMcpExecutionSnapshot({
        cwd,
        homeDir,
        env: { PATH: '/bin:/usr/bin', HOME: homeDir, LANG: 'zh_CN.UTF-8' }
      })

      const detail = mcpExecutionAuthorizationDetail(snapshot, 'run', snapshot.targets)
      const lines = detail.split('\n')
      const pages = mcpExecutionAuthorizationPages(snapshot, 'run', snapshot.targets)

      expect(pages).toHaveLength(1)
      expect(lines.length).toBeLessThanOrEqual(30)
      expect(lines.filter((line) => line.startsWith('• '))).toHaveLength(15)
      for (const line of lines.filter((item) => item.startsWith('• '))) {
        expect(displayWidth(line)).toBeLessThanOrEqual(84)
      }
      expect(detail).not.toContain('继承环境：')
      expect(detail).toContain('MCP（15）')
      expect(detail).not.toContain('项目 .mcp.json')
      for (let index = 1; index <= 15; index++) {
        expect(detail).toContain(`server-${String(index).padStart(2, '0')}`)
      }
      expect(detail).not.toContain('env：API_KEY')
      expect(detail).not.toContain('headers：Authorization')
      expect(detail).not.toContain('query：token')
      expect(detail).not.toContain('值摘要#')
      expect(detail).not.toMatch(/url-user|url-secret|query-secret|configured-secret|header-secret/)
      expect(detail).not.toMatch(/target:|source:|configured env:|\(none\)/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('paginates oversized target lists and keeps cancellation as the default', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      const mcpServers = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
        `server-${String(index + 1).padStart(2, '0')}`,
        { url: `https://mcp-${index + 1}.example.test/api` }
      ]))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const prompt = mcpExecutionAuthorizationPrompt(snapshot, 'run', snapshot.targets)

      expect(prompt.pages.length).toBeGreaterThan(1)
      const combined = prompt.pages.join('\n')
      for (let index = 1; index <= 30; index++) {
        const name = `server-${String(index).padStart(2, '0')}`
        expect(combined.match(new RegExp(name, 'g'))).toHaveLength(1)
      }
      for (const page of prompt.pages) expect(page.split('\n').length).toBeLessThanOrEqual(25)
      const first = mcpExecutionAuthorizationDialogOptions(prompt, 0, 'darwin')
      const last = mcpExecutionAuthorizationDialogOptions(prompt, prompt.pages.length - 1, 'darwin')
      expect(first).toMatchObject({ type: 'warning', defaultId: 0, cancelId: 0, textWidth: 600 })
      expect(first.buttons).toEqual(['取消', `查看下一页（2/${prompt.pages.length}）`])
      expect(last.buttons).toEqual(['取消', '继续'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a target with many configured keys concise and fully redacted', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      const env = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [
        `ENV_KEY_${String(index + 1).padStart(3, '0')}`,
        `secret-${index + 1}`
      ]))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { oversized: { command: '/bin/echo', env } }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const pages = mcpExecutionAuthorizationPages(snapshot, 'run', snapshot.targets)
      const combined = pages.join('\n')

      expect(pages).toHaveLength(1)
      expect(combined).toContain('oversized')
      expect(combined).not.toContain('（续）')
      for (let index = 1; index <= 120; index++) {
        expect(combined).not.toContain(`ENV_KEY_${String(index).padStart(3, '0')}`)
        expect(combined).not.toContain(`secret-${index}`)
      }
      expect(pages[0].split('\n').length).toBeLessThanOrEqual(10)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a target that exactly fills the 18-line budget on one page', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      const env = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [
        `KEY_${String(index + 1).padStart(3, '0')}_${'x'.repeat(28)}`,
        `secret-${index + 1}`
      ]))
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { exact: { command: '/bin/echo', env } }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const pages = mcpExecutionAuthorizationPages(snapshot, 'run', snapshot.targets)

      expect(pages).toHaveLength(1)
      expect(pages[0]).not.toContain('exact（续）')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('maps pages to dialogs and stops immediately when any page is cancelled', async () => {
    const prompt = {
      status: 'warn' as const,
      title: '授权 MCP 执行',
      message: '允许执行？',
      cancelLabel: '取消',
      confirmLabel: '仍然执行',
      pages: ['page-one', 'page-two', 'page-three']
    }
    const seen: string[] = []
    const cancelled = await confirmMcpExecutionAuthorization(prompt, async (options) => {
      seen.push(options.detail ?? '')
      return { response: seen.length === 2 ? 0 : 1 }
    }, 'darwin')
    expect(cancelled).toBe(false)
    expect(seen).toEqual(['page-one', 'page-two'])

    seen.length = 0
    const confirmed = await confirmMcpExecutionAuthorization(prompt, async (options) => {
      seen.push(options.detail ?? '')
      return { response: 1 }
    }, 'darwin')
    expect(confirmed).toBe(true)
    expect(seen).toEqual(prompt.pages)
  })

  it('uses direct confirm semantics for single-page pass and block prompts', () => {
    const base = {
      title: '授权 MCP 执行',
      message: '允许执行？',
      cancelLabel: '取消',
      pages: ['detail']
    }
    const pass = mcpExecutionAuthorizationDialogOptions({
      ...base,
      status: 'pass',
      confirmLabel: '执行 1 个 MCP'
    }, 0, 'darwin')
    const block = mcpExecutionAuthorizationDialogOptions({
      ...base,
      status: 'block',
      confirmLabel: '仍然执行 1 个 MCP'
    }, 0, 'linux')

    expect(pass).toMatchObject({ type: 'info', buttons: ['取消', '执行 1 个 MCP'], defaultId: 0, cancelId: 0, textWidth: 600 })
    expect(block).toMatchObject({ type: 'warning', buttons: ['取消', '仍然执行 1 个 MCP'], defaultId: 0, cancelId: 0 })
    expect(block).not.toHaveProperty('textWidth')
  })

  it('scopes blocking Guard findings to the selected target', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: {
          risky: { url: 'https://risky.example.test/mcp', headers: { Authorization: 'Bearer literal-secret' } },
          safe: { url: 'https://safe.example.test/mcp' }
        }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const risky = snapshot.targets.find((target) => target.name === 'risky')!
      const safe = snapshot.targets.find((target) => target.name === 'safe')!
      snapshot.report.findings = [{
        severity: 'high',
        affectedTargets: [{ targetId: risky.targetId, role: 'subject' }]
      } as (typeof snapshot.report.findings)[number]]
      const riskyGuard = mcpExecutionGuardSummary(snapshot, [risky])
      const safeGuard = mcpExecutionGuardSummary(snapshot, [safe])

      expect(riskyGuard.status).toBe('block')
      expect(riskyGuard.high).toBeGreaterThan(0)
      expect(safeGuard.high).toBe(0)
      expect(safeGuard.status).not.toBe('block')
      expect(mcpExecutionBlockingTargetIds(snapshot, [risky, safe])).toEqual([risky.targetId])
      expect(mcpExecutionAuthorizationPrompt(snapshot, 'run', [risky]).cancelLabel).toBe('禁用并继续')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses only the selected target when authorizing a single MCP test', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: {
          first: { url: 'https://first.example.test/mcp' },
          second: { url: 'https://second.example.test/mcp' }
        }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const detail = mcpExecutionAuthorizationDetail(snapshot, `test:${snapshot.targets[0].targetId}`, [snapshot.targets[0]])

      expect(detail).toContain('操作：测试单个 MCP 连接')
      expect(detail).toContain('MCP：')
      expect(detail).toContain('first')
      expect(detail).not.toContain('second')
      expect(detail).not.toContain('项目 .mcp.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('labels single-target MCP authentication distinctly from connection testing', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { remote: { url: 'https://remote.example.test/mcp' } }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const selected = [snapshot.targets[0]]
      const detail = mcpExecutionAuthorizationDetail(snapshot, `auth:${selected[0].targetId}`, selected)

      expect(detail).toContain('操作：认证单个 MCP')
      expect(detail).toContain('MCP：')
      expect(detail).toContain('remote')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not present a disabled, unscanned test target as Guard pass', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { disabled: { url: 'https://disabled.example.test/mcp' } }
      }))
      writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({
        disabledMcpjsonServers: ['disabled']
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const selected = [snapshot.targets[0]]
      const guard = mcpExecutionGuardSummary(snapshot, selected)
      const detail = mcpExecutionAuthorizationDetail(snapshot, `test:${snapshot.targets[0].targetId}`, selected)

      expect(guard).toMatchObject({ status: 'warn', incomplete: 1 })
      expect(detail).toContain('检测结果：1 个 MCP 未完整扫描')
      expect(detail).not.toContain('未发现风险项')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades a missing executable to a warning and revokes the grant when it appears', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      const missing = join(root, 'missing', 'server.bin')
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { gone: { command: missing }, ok: { command: '/bin/echo' } }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })

      expect(snapshot.errors).toEqual([])
      expect(snapshot.warnings).toHaveLength(1)
      expect(snapshot.warnings[0]).toContain('gone')
      expect(snapshot.warnings[0]).toContain(missing)
      const gone = snapshot.targets.find((target) => target.name === 'gone')!
      expect(gone.config.command).toBe(missing)
      expect(gone.executableIdentity).toBe(`unverified:${missing}`)
      expect(gone.executableError).toContain(missing)
      const trust = new McpExecutionTrust()
      trust.grant('run', snapshot)
      expect(trust.isGranted('run', snapshot)).toBe(true)

      mkdirSync(join(root, 'missing'), { recursive: true })
      writeFileSync(missing, '#!/bin/sh\n')
      chmodSync(missing, 0o755)
      const revived = buildMcpExecutionSnapshot({ cwd, homeDir })
      expect(revived.errors).toEqual([])
      expect(revived.warnings).toEqual([])
      expect(revived.fingerprint).not.toBe(snapshot.fingerprint)
      expect(trust.isGranted('run', revived)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades a command that cannot be resolved on PATH to a warning', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { ghost: { command: 'scry-missing-cmd-9f8d' } }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir, env: { PATH: '/bin:/usr/bin' } })

      expect(snapshot.errors).toEqual([])
      expect(snapshot.warnings).toHaveLength(1)
      expect(snapshot.warnings[0]).toContain('PATH')
      expect(snapshot.targets[0].config.command).toBe('scry-missing-cmd-9f8d')
      expect(snapshot.targets[0].executableIdentity).toBe('unverified:scry-missing-cmd-9f8d')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shows the unverifiable executable warning in the authorization dialog', () => {
    const { root, homeDir, cwd } = fixture()
    try {
      writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: { gone: { command: '/usr/local/scry-missing-bin' } }
      }))
      const snapshot = buildMcpExecutionSnapshot({ cwd, homeDir })
      const detail = mcpExecutionAuthorizationDetail(snapshot, 'run', snapshot.targets)

      expect(detail).toContain('gone')
      expect(detail).toContain('无法验证启动程序：executable 不存在或不是可执行文件：/usr/local/scry-missing-bin')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
