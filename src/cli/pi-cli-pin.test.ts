import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })))
})

const fixtureCli = (capture: string): string =>
  `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(capture)}\n` +
  `payload=''\nwhile IFS= read -r line || [ -n "$line" ]; do payload="$payload$line"; done\n` +
  `if [ -n "$payload" ]; then printf 'delivered\\n' >> ${JSON.stringify(capture)}\n` +
  `else printf 'empty\\n' >> ${JSON.stringify(capture)}\nfi\n`

describe('Pi extension CLI resolution', () => {
  it('工作区 pin 缺失、为空、悬空或读不出时都不回退 PATH 中的未知安装', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-pi-extension-invalid-pin-'))
    roots.push(root)
    const pinnedCapture = join(root, 'pinned-called')
    const fallbackCapture = join(root, 'fallback-called')
    const homeCapture = join(root, 'home-called')
    const pinned = join(root, 'pinned-scry')
    const fallback = join(root, 'scry')
    const homeGuess = join(root, '.local', 'bin', 'scry')
    await writeFile(pinned, fixtureCli(pinnedCapture))
    await writeFile(fallback, fixtureCli(fallbackCapture))
    await mkdir(join(root, '.local', 'bin'), { recursive: true })
    await writeFile(homeGuess, fixtureCli(homeCapture))
    for (const cli of [pinned, fallback, homeGuess]) await chmod(cli, 0o700)
    await mkdir(join(root, '.scry'), { recursive: true })
    const pin = join(root, '.scry', 'cli-path')
    const previousPath = process.env.PATH
    const previousHome = process.env.HOME
    const previousConfigured = process.env.SCRY_CLI_PATH
    process.env.PATH = root
    process.env.HOME = root
    delete process.env.SCRY_CLI_PATH
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

      await writeFile(pin, `${pinned}\n`)
      await deliver()
      const recorded = await readFile(pinnedCapture, 'utf8')
      expect(recorded).toContain('--event UserPromptSubmit')
      expect(recorded).toContain('delivered')
      await expect(readFile(fallbackCapture, 'utf8')).rejects.toThrow()

      await writeFile(pin, '\n')
      await deliver()
      await expect(readFile(homeCapture, 'utf8')).rejects.toThrow()
      await writeFile(pin, `${join(root, 'absent-scry')}\n`)
      await deliver()
      await expect(readFile(homeCapture, 'utf8')).rejects.toThrow()
      await rm(pin)
      await symlink(join(root, 'deleted-scry'), pin)
      await deliver()
      await expect(readFile(homeCapture, 'utf8')).rejects.toThrow()
      await rm(pin)
      await mkdir(pin)
      await deliver()
      await expect(readFile(homeCapture, 'utf8')).rejects.toThrow()
      await expect(readFile(fallbackCapture, 'utf8')).rejects.toThrow()
      await rm(pin, { recursive: true })
      await deliver()
      expect(await readFile(homeCapture, 'utf8')).toContain('delivered')
      await expect(readFile(fallbackCapture, 'utf8')).rejects.toThrow()
      await rm(homeGuess)
      await deliver()
      const guessed = await readFile(fallbackCapture, 'utf8')
      expect(guessed).toContain('--event UserPromptSubmit')
      expect(guessed).toContain('delivered')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousConfigured === undefined) delete process.env.SCRY_CLI_PATH
      else process.env.SCRY_CLI_PATH = previousConfigured
    }
  })
})
