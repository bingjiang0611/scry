import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    }
    const openCodePlugin = join(root, '.opencode/plugins/scry-recorder.js')
    expect(await readFile(openCodePlugin, 'utf8')).toContain('SCRY_HANDLER_ID=turn-recorder-v1')
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
