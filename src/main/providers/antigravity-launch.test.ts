import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sanitizeProviderEnv, detectStrippedAntigravityEnvNames } from '../provider-environment'
import { detectAgentsFast, resolveRuntimeCliBin } from '../claude-locate'
import { captureProcessIdentity } from '../process-diagnostics'
import {
  buildAntigravityLaunchEnv,
  describeAntigravity,
  forceKillAntigravityProcess,
  spawnAntigravityAcp
} from './antigravity-launch'
import { AcpClient } from './acp-client'

const FIXTURE = join(process.cwd(), 'src', 'main', 'providers', 'fixtures', 'fake-agy-acp.mjs')
const temps: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true })
})

function makeFakeAgy(scenario: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-agy-launch-'))
  temps.push(dir)
  const bin = join(dir, 'agy')
  const source = readFileSync(FIXTURE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`)
  writeFileSync(bin, source, { mode: 0o755 })
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario))
  return { dir, bin, recordPath: join(dir, 'recorded.json') }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('A3: Antigravity 启动、环境清洗、版本门禁与独立进程组停止', () => {
  it('环境清洗默认删除凭据与 SSH_*，支持 SCRY_PROVIDER_ENV_ALLOW 逐个放行，且为其余 5 家清洗 GEMINI_/AGY_/ANTIGRAVITY_', () => {
    const raw = {
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/home',
      GEMINI_API_KEY: 'AIzaSyFakeKey1234567890',
      AGY_ADC_AUTH: '1',
      AGY_ACP_FORCE_FILE_STORAGE: '1',
      ANTIGRAVITY_HARNESS_PATH: '/evil/harness',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-openai',
      SSH_CLIENT: '1.2.3.4 1234 22',
      SSH_CONNECTION: '1.2.3.4 1234 5.6.7.8 22',
      SSH_TTY: '/dev/ttys001',
      BROWSER: '/usr/bin/open'
    }

    const stripped = sanitizeProviderEnv(raw, 'antigravity')
    expect(stripped.GEMINI_API_KEY).toBeUndefined()
    expect(stripped.AGY_ADC_AUTH).toBeUndefined()
    expect(stripped.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined()
    expect(stripped.ANTIGRAVITY_HARNESS_PATH).toBeUndefined()
    expect(stripped.ANTHROPIC_API_KEY).toBeUndefined()
    expect(stripped.OPENAI_API_KEY).toBeUndefined()
    expect(stripped.SSH_CLIENT).toBeUndefined()
    expect(stripped.SSH_CONNECTION).toBeUndefined()
    expect(stripped.SSH_TTY).toBeUndefined()

    expect(detectStrippedAntigravityEnvNames(raw)).toEqual(
      expect.arrayContaining(['GEMINI_API_KEY', 'AGY_ADC_AUTH', 'AGY_ACP_FORCE_FILE_STORAGE', 'ANTIGRAVITY_HARNESS_PATH'])
    )

    const allowedKey = sanitizeProviderEnv(
      { ...raw, SCRY_PROVIDER_ENV_ALLOW: 'antigravity:GEMINI_API_KEY' },
      'antigravity'
    )
    expect(allowedKey.GEMINI_API_KEY).toBe('AIzaSyFakeKey1234567890')
    expect(allowedKey.AGY_ADC_AUTH).toBeUndefined()
    expect(allowedKey.SSH_CLIENT).toBeUndefined()

    const allowedFileStorage = sanitizeProviderEnv(
      { ...raw, SCRY_PROVIDER_ENV_ALLOW: 'antigravity:AGY_ACP_FORCE_FILE_STORAGE' },
      'antigravity'
    )
    expect(allowedFileStorage.AGY_ACP_FORCE_FILE_STORAGE).toBe('1')
    expect(allowedFileStorage.SSH_CLIENT).toBe('1.2.3.4 1234 22')

    for (const other of ['claude', 'codex', 'qoder', 'opencode', 'pi'] as const) {
      const cleaned = sanitizeProviderEnv(raw, other)
      expect(cleaned.GEMINI_API_KEY).toBeUndefined()
      expect(cleaned.AGY_ADC_AUTH).toBeUndefined()
      expect(cleaned.ANTIGRAVITY_HARNESS_PATH).toBeUndefined()
    }
    const piAllowed = sanitizeProviderEnv(
      { ...raw, SCRY_PROVIDER_ENV_ALLOW: 'pi:GEMINI_API_KEY' },
      'pi'
    )
    expect(piAllowed.GEMINI_API_KEY).toBe('AIzaSyFakeKey1234567890')

    const launchEnv = buildAntigravityLaunchEnv(raw)
    expect(launchEnv.BROWSER).toBeTruthy()
    expect(launchEnv.BROWSER).not.toBe('/usr/bin/open')
    expect(launchEnv.SSH_CLIENT).toBeUndefined()
  })

  it('detectAgentsFast 受 SCRY_EXPERIMENTAL_PROVIDERS 控制且支持 SCRY_AGY_PATH', () => {
    const { bin } = makeFakeAgy()
    vi.stubEnv('SCRY_AGY_PATH', bin)
    vi.stubEnv('SCRY_EXPERIMENTAL_PROVIDERS', '')
    expect(detectAgentsFast().some((agent) => agent.id === 'antigravity')).toBe(false)

    vi.stubEnv('SCRY_EXPERIMENTAL_PROVIDERS', 'antigravity')
    expect(detectAgentsFast().find((agent) => agent.id === 'antigravity')?.path).toBe(bin)
    expect(resolveRuntimeCliBin('antigravity')).toBe(bin)
  })

  it('describeAntigravity 校验版本下限 (>= 1.5.1) 且在 Windows 报 unsupported_platform', async () => {
    const win = await describeAntigravity({ platform: 'win32' })
    expect(win.available).toBe(false)
    expect(win.unavailableReason).toContain('unsupported_platform')

    const old = makeFakeAgy({ version: '1.5.0' })
    vi.stubEnv('SCRY_AGY_PATH', old.bin)
    const oldDesc = await describeAntigravity()
    expect(oldDesc.available).toBe(false)
    expect(oldDesc.unavailableReason).toMatch(/1\.5\.1/)

    const ok = makeFakeAgy({ version: '1.5.12' })
    vi.stubEnv('SCRY_AGY_PATH', ok.bin)
    const okDesc = await describeAntigravity()
    expect(okDesc.available).toBe(true)
    expect(okDesc.version).toBe('1.5.12')
    expect(okDesc.health?.state).toBe('unknown')
    expect(okDesc.accountNote).toBe('账号未验证')
  })

  it('forceKillAntigravityProcess 按身份清理根进程与独立 PGID 后代进程', async () => {
    const { bin, dir, recordPath } = makeFakeAgy({
      ignoreCancel: true,
      promptSteps: [
        { type: 'spawn_detached_child', ms: 30_000 },
        { type: 'sleep', ms: 30_000 }
      ]
    })
    vi.stubEnv('SCRY_AGY_PATH', bin)
    const launched = spawnAntigravityAcp({
      cwd: dir,
      permissionMode: 'default',
      baseEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, SSH_CLIENT: '1.2.3.4 1 22' }
    })
    const client = new AcpClient(launched.child)
    await client.initialize('0.2.250')
    const session = await client.request<{ sessionId: string }>('session/new', { cwd: dir, mcpServers: [] })
    const promptPromise = client.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'spawn child' }]
    }, { timeoutMs: null }).catch(() => null)

    let childPid = 0
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        const rec = JSON.parse(readFileSync(recordPath, 'utf8'))
        if (rec.spawnedChildPids?.length > 0) {
          childPid = rec.spawnedChildPids[0]
          break
        }
      } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 40))
    }
    expect(childPid).toBeGreaterThan(0)
    expect(isPidAlive(childPid)).toBe(true)

    const recBefore = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(recBefore.hasSshClient).toBe(false)
    expect(recBefore.argv).toEqual(['acp'])

    await forceKillAntigravityProcess(launched.identityPromise, { sigkillDelayMs: 250 })
    await promptPromise

    // Wait briefly for OS reaping of both root and independent-PGID descendant.
    const reapDeadline = Date.now() + 3_000
    while (Date.now() < reapDeadline && (isPidAlive(launched.child.pid!) || isPidAlive(childPid))) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(isPidAlive(launched.child.pid!)).toBe(false)
    expect(isPidAlive(childPid)).toBe(false)
  })

  it('S6: 根进程忽略 SIGTERM 仍存活时，SIGKILL 阶段依然按身份强杀已脱离进程树的独立 PGID 后代', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-agy-s6-'))
    temps.push(dir)
    const pidFile = join(dir, 'detached-grandchild.pid')
    // Root ignores SIGTERM and spawns an intermediate child (which exits on SIGTERM) that spawns a detached grandchild (which ignores SIGTERM).
    // After SIGTERM: root is STILL alive, intermediate exits -> grandchild is reparented to PID 1 (detached from root tree).
    const script = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      process.on('SIGTERM', () => {});
      const mid = spawn(process.execPath, ['-e', \`
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const grand = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);"], { detached: true, stdio: 'ignore' });
        grand.unref();
        writeFileSync(${JSON.stringify(pidFile)}, String(grand.pid));
        setTimeout(() => {}, 30000);
      \`], { stdio: 'ignore' });
      setTimeout(() => {}, 30000);
    `
    const root = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
    const identityPromise = captureProcessIdentity(root.pid)
    let childPid = 0
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        const parsed = Number(readFileSync(pidFile, 'utf8').trim())
        if (parsed > 0) {
          childPid = parsed
          break
        }
      } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 40))
    }
    expect(childPid).toBeGreaterThan(0)
    expect(isPidAlive(root.pid!)).toBe(true)
    expect(isPidAlive(childPid)).toBe(true)

    try {
      await forceKillAntigravityProcess(identityPromise, { sigkillDelayMs: 250 })
      const reapDeadline = Date.now() + 3_000
      while (Date.now() < reapDeadline && (isPidAlive(root.pid!) || isPidAlive(childPid))) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(isPidAlive(root.pid!)).toBe(false)
      expect(isPidAlive(childPid)).toBe(false)
    } finally {
      try { process.kill(root.pid!, 'SIGKILL') } catch { /* ignore */ }
      try { process.kill(childPid, 'SIGKILL') } catch { /* ignore */ }
    }
  })
})
