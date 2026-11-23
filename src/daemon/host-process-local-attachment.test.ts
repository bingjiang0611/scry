import 'reflect-metadata'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { DaemonRunTransport } from '../main/daemon-run-transport'
import type { DaemonRunRuntime } from '../main/daemon-run-runtime'
import { createDaemonRunSurface } from '../main/bootstrap/daemon-run-surface'
import { DEFAULT_MAX_FRAME } from '../main/remote/inner-mtls-protocol'
import type { AgentInputAttachment } from '../shared/runtime'

afterEach(cleanupTempDirs)

function screenshot(size: number): AgentInputAttachment {
  const bytes = Buffer.alloc(size, 0x8b)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  return { kind: 'image', mimeType: 'image/png', name: 'screen.png', size, dataBase64: bytes.toString('base64') }
}

function runSurface(daemon: Awaited<ReturnType<typeof startTestDaemon>>, seen: Record<string, unknown>[]) {
  const transport = new DaemonRunTransport(async (request) => {
    seen.push(request)
    return daemon.request(request)
  })
  const runtime = {
    async start(input: { intentId: string; detail: string }) {
      const recorded = await transport.submit(input)
      return { runId: recorded.runId, bound: true }
    }
  } as unknown as DaemonRunRuntime
  const surface = createDaemonRunSurface({ transport, runtime, currentCwd: () => daemon.workspace })
  return { transport, surface }
}

it('sends a large local image through the daemon socket without putting base64 in the intent', async () => {
  const daemon = await startTestDaemon()
  const inputs = join(daemon.root, 'smoke-inputs.jsonl')
  vi.stubEnv('SCRY_ELECTRON_SMOKE_INPUTS', inputs)
  try {
    const seen: Record<string, unknown>[] = []
    const { transport, surface } = runSurface(daemon, seen)
    const image = screenshot(1024 * 1024)
    const bytes = Buffer.from(image.dataBase64, 'base64')
    expect(image.dataBase64.length).toBeGreaterThan(DEFAULT_MAX_FRAME)
    const payload = { prompt: 'describe this image', providerId: 'codex' as const, commandId: 'cmd-local-attachment', attachments: [image] }
    const result = await surface.start(payload)
    expect(seen.filter((request) => request.op === 'submit')).toHaveLength(1)
    const submit = seen.find((request) => request.op === 'submit')!
    expect(JSON.parse(String(submit.detail)).attachments).toEqual([
      expect.objectContaining({ kind: 'image', name: image.name, size: bytes.length, dataBase64: '', attachmentId: expect.any(String) })
    ])
    await vi.waitFor(async () => {
      const state = await transport.intentState(String(submit.intentId))
      expect(state).toMatchObject({ runId: result.runId, state: 'settled' })
    }, { timeout: 7_000 })
    expect(JSON.parse((await readFile(inputs, 'utf8')).trim()).attachments).toMatchObject([
      { kind: 'image', contentHash: createHash('sha256').update(bytes).digest('hex') }
    ])

    seen.length = 0
    await expect(surface.start(payload)).resolves.toEqual(result)
    expect(seen.map((request) => request.op)).toEqual(['intentStatusAtLog', 'submit'])
    expect(seen[1]).toEqual(submit)
    expect((await readFile(inputs, 'utf8')).trim().split('\n')).toHaveLength(1)
  } finally {
    vi.unstubAllEnvs()
    await daemon.dispose()
  }
}, 20_000)

it.each(['inline', 'chunked'] as const)('rejects changed content when retrying a %s screenshot across the frame limit', async (first) => {
  const daemon = await startTestDaemon()
  const inputs = join(daemon.root, 'smoke-inputs.jsonl')
  vi.stubEnv('SCRY_ELECTRON_SMOKE_INPUTS', inputs)
  try {
    const seen: Record<string, unknown>[] = []
    const { transport, surface } = runSurface(daemon, seen)
    const images = { inline: screenshot(512), chunked: screenshot(1024 * 1024) }
    const payload = { prompt: 'describe this image', providerId: 'codex' as const, commandId: 'cmd-same-screenshot' }
    const result = await surface.start({ ...payload, attachments: [images[first]] })
    const originalSubmit = seen.find((request) => request.op === 'submit')!
    await vi.waitFor(async () => {
      await expect(transport.intentState(String(originalSubmit.intentId))).resolves.toMatchObject({ runId: result.runId, state: 'settled' })
    }, { timeout: 7_000 })

    seen.length = 0
    const changed = first === 'inline' ? images.chunked : images.inline
    await expect(surface.start({ ...payload, attachments: [changed] })).rejects.toMatchObject({ reason: 'command_payload_conflict' })
    expect(seen.map((request) => request.op)).toEqual(first === 'inline' ? ['intentStatusAtLog', 'submit'] : ['submit'])
    expect(seen.at(-1)?.intentId).toBe(originalSubmit.intentId)
    expect((await readFile(inputs, 'utf8')).trim().split('\n')).toHaveLength(1)
  } finally {
    vi.unstubAllEnvs()
    await daemon.dispose()
  }
}, 20_000)
