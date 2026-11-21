import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build as esbuild } from 'esbuild'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { buildIdentity } from '../shared/build-identity'
import { generateDesktopDeviceIdentity } from '../main/remote/desktop-transport'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore } from './host-process.fixtures'
import { defaultHostUserDataDir } from './host-cli-paths'

const tempDirs: string[] = []
function makeShortDir(prefix: string): string {
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
  const dir = mkdtempSync(join(base, prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('W11 P5-6: real node-pty interactive & piped host-cli execution', () => {
  it('approves a proved pairing interactively under node-pty and refuses piped non-TTY invocation', async () => {
    const savedExp = process.env.SCRY_EXPERIMENTAL_HOST_CLI
    const savedRemote = process.env.SCRY_REMOTE_HOST
    const savedRelay = process.env.SCRY_REMOTE_RELAY_ENABLED
    process.env.SCRY_EXPERIMENTAL_HOST_CLI = '1'
    process.env.SCRY_REMOTE_HOST = '1'
    process.env.SCRY_REMOTE_RELAY_ENABLED = '0'

    const fakeHome = makeShortDir('scry-p-')
    const bundleDir = makeShortDir('scry-b-')
    const bundlePath = join(bundleDir, 'host-cli.mjs')
    const id = buildIdentity('test')
    await esbuild({
      entryPoints: [join(process.cwd(), 'src/daemon/host-cli-main.ts')],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      define: {
        __SCRY_APP_VERSION__: JSON.stringify(id.version),
        __SCRY_BUILD_ID__: JSON.stringify(id.build ?? '')
      }
    })

    const envForCli: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: fakeHome,
      SCRY_EXPERIMENTAL_HOST_CLI: '1',
      ...(process.platform === 'linux' ? { XDG_CONFIG_HOME: join(fakeHome, '.config') } : {})
    }
    const userDataDir = defaultHostUserDataDir(process.platform, fakeHome, envForCli)
    const daemonStateDirectory = join(userDataDir, 'daemon')
    mkdirSync(join(userDataDir, 'remote', 'ledger'), { recursive: true, mode: 0o700 })

    const host = await createDaemonHostProcess({
      userDataDir,
      daemonStateDirectory,
      appPath: process.cwd(),
      resourcesPath: join(process.cwd(), 'resources'),
      appVersion: 'test',
      isPackaged: false,
      createOutputStore: () => new MemoryOutputStore(),
      log: () => undefined
    })

    try {
      host.hostAdmin.setCliApprovalEnabled(true)
      const inv = await host.service.beginPairing()
      const dev = await generateDesktopDeviceIdentity()
      await host.service.authority.prove(
        { pairingId: inv.pairingId, secret: inv.secret, csrPEM: dev.csrPEM, deviceLabel: 'PTY Phone' },
        dev.publicKeySHA256
      )

      // 1. Piped non-TTY invocation MUST fail with exit 1 and host_cli_requires_tty.
      let pipedCode: number | null = null
      let pipedStderr = ''
      try {
        execFileSync(process.execPath, [bundlePath, 'approve'], {
          env: envForCli,
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf8',
          timeout: 10_000
        })
      } catch (error) {
        const err = error as { status?: number; stderr?: string }
        pipedCode = err.status ?? null
        pipedStderr = String(err.stderr ?? '')
      }
      expect(pipedCode).toBe(1)
      expect(pipedStderr).toContain('host_cli_requires_tty')

      // 2. Real node-pty interactive approve succeeds and records approvedVia: 'host_cli'.
      const ptyResult = await new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
        const term = pty.spawn(process.execPath, [bundlePath, 'approve'], {
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
          cwd: fakeHome,
          env: envForCli
        })
        let output = ''
        let sentFp = false
        let sentYes = false
        const timer = setTimeout(() => {
          try { term.kill() } catch { /* ignore */ }
          reject(new Error(`node-pty approve timed out. output:\n${output}`))
        }, 15_000)
        term.onData((chunk) => {
          output += chunk
          if (!sentFp && output.includes('请输入设备上显示的指纹')) {
            sentFp = true
            term.write(`${dev.publicKeySHA256.slice(0, 16)}\r`)
          } else if (sentFp && !sentYes && output.includes('输入 yes 确认批准')) {
            sentYes = true
            term.write('yes\r')
          }
        })
        term.onExit(({ exitCode }) => {
          clearTimeout(timer)
          resolve({ exitCode, output })
        })
      })

      expect(ptyResult.exitCode).toBe(0)
      expect(ptyResult.output).toContain('已批准设备「PTY Phone」')
      const grant = host.service.authority.inspectLocal().grants.find((g) => g.publicKeySHA256 === dev.publicKeySHA256)
      expect(grant?.approvedVia).toBe('host_cli')
    } finally {
      await host.dispose()
      if (savedExp === undefined) delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
      else process.env.SCRY_EXPERIMENTAL_HOST_CLI = savedExp
      if (savedRemote === undefined) delete process.env.SCRY_REMOTE_HOST
      else process.env.SCRY_REMOTE_HOST = savedRemote
      if (savedRelay === undefined) delete process.env.SCRY_REMOTE_RELAY_ENABLED
      else process.env.SCRY_REMOTE_RELAY_ENABLED = savedRelay
    }
  }, 30_000)
})
