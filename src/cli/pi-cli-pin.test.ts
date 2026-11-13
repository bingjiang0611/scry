import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })))
})

/**
 * A fixture CLI that only uses shell builtins. The test drops PATH to a directory that holds no
 * tools, so an external `cat` fails while the script keeps running: a marker written after it would
 * claim delivery without ever reading the payload. 'delivered' is written only when stdin actually
 * carried the event, which is the evidence that the extension handed the payload over.
 */
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
    // A configured SCRY_CLI_PATH outranks the workspace pin; the test would never resolve a pin.
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

      // 成功标记：有效 pin 被真正执行，且 payload 读到了，才等于一次真实投递。
      await writeFile(pin, `${pinned}\n`)
      await deliver()
      const recorded = await readFile(pinnedCapture, 'utf8')
      expect(recorded).toContain('--event UserPromptSubmit')
      expect(recorded).toContain('delivered')
      await expect(readFile(fallbackCapture, 'utf8')).rejects.toThrow()

      // 坏 pin：只有 pin 路径本身不存在才可以退回猜测。
      await writeFile(pin, '\n')
      await deliver()
      await expect(readFile(homeCapture, 'utf8')).rejects.toThrow()
      await writeFile(pin, `${join(root, 'absent-scry')}\n`)
      await deliver()
      await expect(readFile(homeCapture, 'utf8')).rejects.toThrow()
      // 悬空符号链接：pin 路径还在，只是指向已删除的文件——坏 pin，不是未配置。
      await rm(pin)
      await symlink(join(root, 'deleted-scry'), pin)
      await deliver()
      await expect(readFile(homeCapture, 'utf8')).rejects.toThrow()
      // 读不出（这里是目录）也属于坏 pin。
      await rm(pin)
      await mkdir(pin)
      await deliver()
      await expect(readFile(homeCapture, 'utf8')).rejects.toThrow()
      // 上面每一种坏 pin 都拒绝退回猜测：既不落到 PATH，也不落到 ~/.local/bin。
      await expect(readFile(fallbackCapture, 'utf8')).rejects.toThrow()
      // 删掉 pin 路径后按猜测顺序解析：~/.local/bin 先于 PATH，且这一次真的投递成功。
      await rm(pin, { recursive: true })
      await deliver()
      expect(await readFile(homeCapture, 'utf8')).toContain('delivered')
      await expect(readFile(fallbackCapture, 'utf8')).rejects.toThrow()
      // PATH 里的安装只在前两者都不存在时才会被猜中。
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
