import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { initWorkspace } from './workspace-init'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })))
})

async function gitWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-init-test-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  return root
}

describe('scry init', () => {
  it.each(['cli_path_missing', 'node_bin_dir_missing', 'cli_not_executable', 'managed_cli_invalid', 'cli_failed', 'managed_cli_failed'])(
    'hook-skip %s is observable while the Provider still receives exit 0', async (reason) => {
      const root = await gitWorkspace()
      const cli = join(root, 'failing-cli')
      await writeFile(cli, '#!/bin/sh\nexit 17\n')
      await chmod(cli, 0o700)
      await initWorkspace({ workspace: root, providers: 'codex', cliPath: cli })
      if (reason === 'cli_path_missing') await rm(join(root, '.scry/cli-path'))
      if (reason === 'node_bin_dir_missing') await rm(join(root, '.scry/node-bin-dir'))
      if (reason === 'cli_not_executable') await writeFile(join(root, '.scry/cli-path'), `${root}/absent\n`)
      const result = spawnSync('/bin/sh', [join(root, '.scry/provider-hook.sh'), 'codex', 'Stop'], {
        input: '{"secret":"DO_NOT_LOG_PAYLOAD"}', encoding: 'utf8',
        env: { ...process.env, SCRY_RECORDER_TRANSPORT: 'direct',
          SCRY_RECORDER_MANAGED: reason.startsWith('managed_') ? '1' : '0',
          SCRY_CLI_PATH: reason === 'managed_cli_invalid' ? join(root, 'absent') : cli }
      })
      expect(result.status).toBe(0)
      const log = await readFile(join(root, '.scry/logs/hook-skip.log'), 'utf8')
      expect(log).toMatch(new RegExp(`^\\d{4}-.*\\tcodex\\tStop\\t${reason}\\t`))
      expect(log).not.toContain('DO_NOT_LOG_PAYLOAD')
      if (reason.endsWith('_failed')) expect(log.trim().split('\t').at(-1)).toBe('17')
    }
  )

  it('幂等合并三种 JSON Hook 并安装 OpenCode 插件', async () => {
    const root = await gitWorkspace()
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude/settings.local.json'), '{"env":{"KEEP":"yes"}}\n')

    const first = await initWorkspace({
      workspace: root,
      providers: 'claude,codex qoder,opencode',
      cliPath: process.execPath
    })
    const second = await initWorkspace({
      workspace: root,
      providers: 'claude,codex,qoder,opencode',
      cliPath: process.execPath
    })

    expect(first.providers).toEqual(['claude', 'codex', 'qoder', 'opencode'])
    expect(second.changedFiles).toEqual([])
    expect(JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')).capture.toolOutput).toBe('full')
    expect(JSON.parse(await readFile(join(root, '.claude/settings.local.json'), 'utf8'))).toMatchObject({ env: { KEEP: 'yes' } })
    for (const [provider, path] of [
      ['claude', '.claude/settings.local.json'],
      ['codex', '.codex/hooks.json'],
      ['qoder', '.qoder/settings.json']
    ] as const) {
      const settings = JSON.parse(await readFile(join(root, path), 'utf8'))
      for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
        const source = JSON.stringify(settings.hooks[event])
        expect(source.match(new RegExp(`${provider} ${event}`, 'g'))).toHaveLength(1)
      }
      // Only Claude publishes SessionEnd; registering it elsewhere would fake capability parity.
      const sessionEnd = settings.hooks.SessionEnd
      if (provider === 'claude') {
        expect(JSON.stringify(sessionEnd).match(/claude SessionEnd/g)).toHaveLength(1)
        // Session end must persist and enqueue only, so it keeps a much tighter budget than Stop.
        expect(sessionEnd[0].hooks[0].timeout).toBe(3)
        expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(15)
      } else {
        expect(sessionEnd).toBeUndefined()
      }
    }
    const openCodePlugin = join(root, '.opencode/plugins/scry-recorder.js')
    const openCodeSource = await readFile(openCodePlugin, 'utf8')
    expect(openCodeSource).toContain('SCRY_HANDLER_ID=turn-recorder-v1')
    expect(openCodeSource).toContain("reason: 'byte_limit'")
    expect(openCodeSource).toContain('if (observed.length === 0) return undefined')
    expect(openCodeSource).toContain('usage_complete: observedUsage.complete')
    execFileSync(process.execPath, ['--check', openCodePlugin])
    expect(await readFile(join(root, '.git/info/exclude'), 'utf8')).toContain('.scry/')
    execFileSync('sh', ['-n', join(root, '.scry/provider-hook.sh')])
    const hookScript = await readFile(join(root, '.scry/provider-hook.sh'), 'utf8')
    // 快路径必须先把 stdin 读进变量，否则回退时无法重发，事件会丢。
    expect(hookScript.indexOf('payload="$(cat)"')).toBeLessThan(hookScript.indexOf('curl'))
    // 只有 HTTP 200 才算成功；其余一律回退到 CLI。
    expect(hookScript).toContain('[ "$code" = "200" ] && exit 0')
    expect(hookScript).toContain('printf \'%s\' "$payload" | "$scry_bin" recorder hook')
    // managed 模式不走 socket 快路径。
    expect(hookScript.indexOf('--managed')).toBeLessThan(hookScript.indexOf('payload="$(cat)"'))
  }, 60_000)

  it('OpenCode 插件只累计终态已观测字段，保留真零、覆盖更新并标注缺失消息', async () => {
    const root = await gitWorkspace()
    await initWorkspace({ workspace: root, providers: 'opencode', cliPath: process.execPath })
    const source = (await readFile(join(root, '.opencode/plugins/scry-recorder.js'), 'utf8'))
      .replace(/^import .*$/gm, '')
      .replace("const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')", `const root = ${JSON.stringify(root)}`)
      .replace('export const ScryRecorder', 'const ScryRecorder')
      .replace('export default ScryRecorder', 'ScryRecorder()')
    const delivered: Record<string, unknown>[] = []
    const hooks = await runInNewContext(source, {
      resolve, Buffer, TextDecoder, process,
      spawnSync: (_hook: string, _args: string[], options: { input: string }) => {
        delivered.push(JSON.parse(options.input))
        return {}
      }
    }) as Record<string, (input: unknown, output?: unknown) => Promise<void>>
    const finished = { id: 'm1', role: 'assistant', time: { completed: 10 }, tokens: { input: 9, output: 3, cache: { read: 0 } }, cost: 0 }
    const pending = { id: 'm1', role: 'assistant', tokens: { input: 0, output: 0 }, cost: 0 }
    const cases = [
      { rows: [], expected: undefined },
      { rows: [{ ...finished, tokens: {}, cost: undefined }], expected: undefined },
      { rows: [pending], expected: undefined },
      { rows: [pending, finished, finished], expected: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 0, cost_usd: 0 }, complete: true },
      { rows: [{ ...pending, time: { completed: 10 } }], expected: { input_tokens: 0, output_tokens: 0, cost_usd: 0 }, complete: true },
      { rows: [finished, { ...pending, id: 'm2' }], expected: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 0, cost_usd: 0 }, complete: false },
      { rows: [{ ...finished, tokens: { input: 4 }, cost: undefined }], expected: { input_tokens: 4 }, complete: false },
      { rows: [{ ...finished, tokens: { input: -1, output: NaN, reasoning: Infinity }, cost: '0' }], expected: undefined }
    ]
    for (const scenario of cases) {
      await hooks['chat.message']({ sessionID: 's1', prompt: 'fixture' })
      for (const info of scenario.rows) await hooks.event({ event: { type: 'message.updated', properties: { info: { ...info, sessionID: 's1' } } } })
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } })
      expect(delivered.at(-1)?.usage).toEqual(scenario.complete === false ? undefined : scenario.expected)
      expect(delivered.at(-1)?.usage_partial).toEqual(scenario.complete === false ? scenario.expected : undefined)
      expect(delivered.at(-1)?.usage_complete).toBe(scenario.complete)
    }
  })

  it.each(['none', 'summary'])('保留已有显式 %s 配置，不猜测用户意图', async (toolOutput) => {
    const root = await gitWorkspace()
    const configPath = join(root, 'scry.config.json')
    const original = JSON.stringify({ schemaVersion: 1, workspaceId: 'existing', capture: { toolOutput } })
    await writeFile(configPath, original)
    await initWorkspace({ workspace: root, providers: 'claude', cliPath: process.execPath })
    expect(await readFile(configPath, 'utf8')).toBe(original)
  })

  it('拒绝在 Git 子目录初始化，并指出项目根目录', async () => {
    const root = await gitWorkspace()
    const child = join(root, 'child')
    await mkdir(child)

    await expect(initWorkspace({ workspace: child, providers: 'codex', cliPath: process.execPath }))
      .rejects.toThrow(`请在 Git 项目根目录执行：${await realpath(root)}`)
  }, 60_000)

  it('配置 JSON 非法时不写入其他文件', async () => {
    const root = await gitWorkspace()
    await mkdir(join(root, '.codex'))
    await writeFile(join(root, '.codex/hooks.json'), '{broken')

    await expect(initWorkspace({ workspace: root, providers: 'codex', cliPath: process.execPath }))
      .rejects.toThrow('不是合法 JSON')
    await expect(readFile(join(root, 'scry.config.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, '.scry/provider-hook.sh'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('不覆盖用户自己的同名 OpenCode 插件', async () => {
    const root = await gitWorkspace()
    await mkdir(join(root, '.opencode/plugins'), { recursive: true })
    await writeFile(join(root, '.opencode/plugins/scry-recorder.js'), 'export default {}\n')

    await expect(initWorkspace({ workspace: root, providers: 'opencode', cliPath: process.execPath }))
      .rejects.toThrow('不由 Scry 管理')
  }, 60_000)
})
