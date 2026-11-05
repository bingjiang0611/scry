import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })))
})

describe('Pi extension CLI resolution', () => {
  it('工作区 pin 缺失、为空或读不出时都不回退 PATH 中的未知安装', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-invalid-pin-'))
    roots.push(root)
    const pinnedCapture = join(root, 'pinned-called')
    const fallbackCapture = join(root, 'fallback-called')
    const pinned = join(root, 'pinned-scry')
    const fallback = join(root, 'scry')
    await writeFile(pinned, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(pinnedCapture)}\ncat >/dev/null\n`)
    await writeFile(fallback, `#!/bin/sh\n: > ${JSON.stringify(fallbackCapture)}\ncat >/dev/null\n`)
    await chmod(pinned, 0o700)
    await chmod(fallback, 0o700)
    // A hermetic home: ~/.local/bin/scry must not exist, otherwise the guess would answer for the
    // fallback and the assertion would pass without ever exercising the refusal.
    await mkdir(join(root, '.local', 'bin'), { recursive: true })
    await mkdir(join(root, '.scry'), { recursive: true })
    const pin = join(root, '.scry', 'cli-path')
    const previousPath = process.env.PATH
    const previousHome = process.env.HOME
    process.env.PATH = root
    process.env.HOME = root
    process.env.SCRY_RECORDER_TRANSPORT = 'direct'
    try {
      const handlers = new Map<string, Array<(event: any, ctx: any) => any>>()
      const pi = { on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]) } }
      // @ts-expect-error the distributed Pi extension is runtime JavaScript by design
      const extension = await import('../../packages/turn-recorder-cli/integrations/pi-scry-recorder.mjs')
      extension.default(pi)
      const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-invalid-pin', getLeafId: () => 'pi-invalid-pin-turn' } }
      const deliver = async (): Promise<void> => {
        for (const handler of handlers.get('before_agent_start') ?? []) await handler({ prompt: 'hello' }, ctx)
      }

      // Success marker: a valid pin is used, which proves the fixture can record a delivery.
      await writeFile(pin, `${pinned}\n`)
      await deliver()
      expect(await readFile(pinnedCapture, 'utf8')).toContain('--event UserPromptSubmit')
      await expect(readFile(fallbackCapture, 'utf8')).rejects.toThrow()

      // Broken pins: missing file is the only case that may fall through to the guesses.
      await writeFile(pin, '\n')
      await deliver()
      await writeFile(pin, `${join(root, 'absent-scry')}\n`)
      await deliver()
      // An unreadable pin is a broken pin, not an absent one.
      await rm(pin)
      await mkdir(pin)
      await deliver()
      // Every broken pin above refused to guess.
      await expect(readFile(fallbackCapture, 'utf8')).rejects.toThrow()
      // With the pin file absent the guessed PATH install is used again, so the fixture is reachable.
      await rm(pin, { recursive: true })
      await deliver()
      await expect(readFile(fallbackCapture, 'utf8')).resolves.toBe('')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
  })
})
