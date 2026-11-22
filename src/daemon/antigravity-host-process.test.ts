import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, webcrypto } from 'node:crypto'
import { cryptoProvider } from '@peculiar/x509'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, call, cleanupTempDirs, enrollLocal, tempDir } from './host-process.fixtures'
import { createRecentFoldersStore } from '../main/app-store'

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])

const FAKE_FIXTURE_SOURCE = join(process.cwd(), 'src/main/providers/fixtures/fake-agy-acp.mjs')

function installFakeAgy(root: string): string {
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true, mode: 0o700 })
  const binPath = join(binDir, 'fake-agy')
  const source = readFileSync(FAKE_FIXTURE_SOURCE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`)
  writeFileSync(binPath, source, { mode: 0o755 })
  chmodSync(binPath, 0o755)
  writeFileSync(join(binDir, 'scenario.json'), JSON.stringify({
    version: '1.5.12',
    models: [
      { value: 'gemini-3-flash', name: 'Gemini 3 Flash', thoughts: ['low', 'medium'] },
      { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', thoughts: ['low', 'high'] }
    ],
    defaultModel: 'gemini-3-flash',
    replyText: 'daemon fake agy ok'
  }), 'utf8')
  return binPath
}

afterEach(cleanupTempDirs)

describe('daemon host process + Antigravity fake ACP agent (不改 host-process.ts)', () => {
  it('未开实验开关时隐藏 antigravity；开启后通过真实 daemon socket 暴露目录并跑完一轮对话', async () => {
    const root = tempDir()
    const userDataDir = join(root, 'u')
    const daemonStateDirectory = join(root, 'd')
    mkdirSync(join(userDataDir, 'remote', 'ledger'), { recursive: true, mode: 0o700 })
    const workspace = join(root, 'w')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const canonicalWorkspace = realpathSync(workspace)
    createRecentFoldersStore(userDataDir).push(canonicalWorkspace)
    const fakeBin = installFakeAgy(root)

    const fakeGeminiHome = join(root, 'gemini')
    mkdirSync(join(fakeGeminiHome, 'config'), { recursive: true, mode: 0o700 })
    writeFileSync(join(fakeGeminiHome, 'config', 'mcp_config.json'), '', 'utf8')

    const saved = {
      SCRY_REMOTE_RELAY_ENABLED: process.env.SCRY_REMOTE_RELAY_ENABLED,
      SCRY_EXPERIMENTAL_PROVIDERS: process.env.SCRY_EXPERIMENTAL_PROVIDERS,
      SCRY_AGY_PATH: process.env.SCRY_AGY_PATH,
      GEMINI_HOME: process.env.GEMINI_HOME
    }
    process.env.SCRY_REMOTE_RELAY_ENABLED = '0'
    process.env.SCRY_AGY_PATH = fakeBin
    process.env.GEMINI_HOME = fakeGeminiHome

    try {
      process.env.SCRY_EXPERIMENTAL_PROVIDERS = ''
      const hiddenHost = await createDaemonHostProcess({
        userDataDir: join(root, 'uh'),
        daemonStateDirectory: join(root, 'dh'),
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: '0.2.250',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      try {
        const device = await enrollLocal(hiddenHost.service)
        const descriptors = await call(hiddenHost.channel.socketPath, hiddenHost.service.caCertificatePEM, device.certPEM, device.keyPEM, {
          op: 'providerCatalog', method: 'providerDescriptors', args: []
        })
        expect((descriptors.result as Array<{ id: string }>).map((item) => item.id)).not.toContain('antigravity')
      } finally {
        await hiddenHost.dispose()
      }

      process.env.SCRY_EXPERIMENTAL_PROVIDERS = 'antigravity'
      const host = await createDaemonHostProcess({
        userDataDir,
        daemonStateDirectory,
        appPath: process.cwd(),
        resourcesPath: join(process.cwd(), 'resources'),
        appVersion: '0.2.250',
        isPackaged: false,
        createOutputStore: () => new MemoryOutputStore(),
        log: () => undefined
      })
      try {
        const device = await enrollLocal(host.service)
        const req = (body: Record<string, unknown>) =>
          call(host.channel.socketPath, host.service.caCertificatePEM, device.certPEM, device.keyPEM, body)

        const descriptors = await req({ op: 'providerCatalog', method: 'providerDescriptors', args: [] })
        const agyDescriptor = (descriptors.result as Array<{ id: string; runtimeProvider: string }>)
          .find((item) => item.id === 'antigravity')
        expect(agyDescriptor).toMatchObject({ id: 'antigravity', runtimeProvider: 'antigravity_acp' })

        const controls = await req({
          op: 'providerCatalog',
          method: 'runControls',
          args: [{ providerId: 'antigravity', cwd: canonicalWorkspace }]
        })
        expect(controls.error).toBeUndefined()
        expect(controls.result.state).toBe('ready')
        expect(controls.result.data.models.some((m: { description?: string }) => m.description?.includes('经 Antigravity 提供'))).toBe(true)

        const created = await req({ op: 'conversation', method: 'create', args: [canonicalWorkspace] })
        expect(created.error).toBeUndefined()
        const conversationId = created.result.id as string

        const preview = await req({
          op: 'conversation', method: 'preview', args: [conversationId, { providerId: 'antigravity' }]
        })
        expect(preview.error).toBeUndefined()

        const sent = await req({
          op: 'conversation',
          method: 'send',
          args: [{
            providerId: 'antigravity',
            conversationId,
            expectedRevision: preview.result.revision,
            expectedContinuationKey: preview.result.target.continuationKey,
            commandId: randomUUID(),
            prompt: 'hello via daemon',
            selectedItems: [],
            confirmFresh: true
          }]
        })
        expect(sent.error).toBeUndefined()
        expect(sent.result).toEqual({
          status: 'not_sent',
          reason: 'antigravity 尚未提供可验证的历史输入交接'
        })

        const submitted = await req({
          op: 'submit',
          intentId: randomUUID(),
          detail: JSON.stringify({ cwd: canonicalWorkspace, providerId: 'antigravity', prompt: 'hello via daemon' })
        })
        expect(submitted.status).toBe('recorded')
        const runId = submitted.runId as string

        let state = 'dispatched'
        let cursor = 0
        let outputCursor = 0
        const events: Array<{ kind: string }> = []
        const chunks: Array<{ payload?: string }> = []
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline && state === 'dispatched') {
          const watched = await req({ op: 'watch', runId, cursor, outputCursor, waitMs: 3_000 })
          state = watched.watch.state
          cursor = watched.watch.poll.cursor
          outputCursor = watched.watch.output.cursor
          events.push(...watched.watch.poll.events)
          chunks.push(...watched.watch.output.chunks)
        }
        expect(state, JSON.stringify(events)).toBe('settled')
        expect(events.some((event) => event.kind === 'run_settled')).toBe(true)
        expect(chunks.length).toBeGreaterThan(0)
        expect(JSON.stringify(chunks)).toContain('hello from fake agy')
      } finally {
        await host.dispose()
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 20_000)
})
