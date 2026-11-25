import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleRecorderHook } from '../core/turn-recorder/recorder'
import { listRecords } from '../core/turn-recorder/store'
import { HOOK_UNDELIVERED_STATUS } from './workspace-hook-sources'
import { initWorkspace } from './workspace-init'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })))
})

const stubCli = (root: string): string => `#!/bin/sh
event=''
for arg in "$@"; do
  if [ "\${previous:-}" = '--event' ]; then event="$arg"; fi
  previous="$arg"
done
payload=''
while IFS= read -r line || [ -n "$line" ]; do payload="$payload$line"; done
# The first Stop attempt fails at the CLI, exactly like a recorder that could not record it.
if [ "$event" = Stop ] && [ ! -f ${JSON.stringify(join(root, 'stop-failed-once'))} ]; then
  : > ${JSON.stringify(join(root, 'stop-failed-once'))}
  exit 1
fi
printf '%s\\t%s\\n' "$event" "$payload" >> ${JSON.stringify(join(root, 'accepted.tsv'))}
exit 0
`

const driver = (): string => `import ScryRecorder from './scry-recorder.mjs'
const hooks = await ScryRecorder()
await hooks['chat.message']({ sessionID: 'delivery', prompt: 'create a file' }, { message: { id: 'msg-1' } })
await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'delivery', error: { message: 'stream aborted' } } } })
await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'delivery' } } })
await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'delivery' } } })
`

const failingCli = (root: string): string => `#!/bin/sh
while IFS= read -r line || [ -n "$line" ]; do :; done
: > ${JSON.stringify(join(root, 'cli-executed'))}
exit 1
`

describe('OpenCode hook delivery outcome', () => {
  it('投递失败只让 OpenCode 看到非零退出，Provider 的观测 hook 仍然 fail open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-fail-open-'))
    roots.push(root)
    execFileSync('git', ['init', '-q', root])
    await initWorkspace({ workspace: root, providers: 'opencode', cliPath: process.execPath })
    const cli = join(root, 'failing-scry')
    await writeFile(cli, failingCli(root))
    await chmod(cli, 0o700)
    await writeFile(join(root, '.scry', 'cli-path'), `${cli}\n`)
    const hook = join(root, '.scry', 'provider-hook.sh')

    const providerRun = spawnSync('sh', [hook, 'claude', 'PostToolUse'], { input: '{"session_id":"claude-open"}' })
    expect(providerRun.status).toBe(0)
    expect(await readFile(join(root, 'cli-executed'), 'utf8')).toBe('')
    const pluginRun = spawnSync('sh', [hook, 'opencode', 'Stop'], { input: '{"session_id":"opencode-open"}' })
    expect(pluginRun.status).toBe(HOOK_UNDELIVERED_STATUS)
    expect(await readFile(join(root, '.scry', 'logs', 'hook-skip.log'), 'utf8')).toContain('cli_failed')
  })

  it('真实投递失败后保留状态，下一次 idle 重试送达，最终是一条 failed 记录并带错误', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-opencode-delivery-'))
    roots.push(root)
    execFileSync('git', ['init', '-q', root])
    await initWorkspace({ workspace: root, providers: 'opencode', cliPath: process.execPath })
    const plugins = join(root, '.opencode', 'plugins')
    await writeFile(join(plugins, 'scry-recorder.mjs'), await readFile(join(plugins, 'scry-recorder.js'), 'utf8'))
    await writeFile(join(plugins, 'driver.mjs'), driver())
    const cli = join(root, 'stub-scry')
    await writeFile(cli, stubCli(root))
    await chmod(cli, 0o700)
    await writeFile(join(root, '.scry', 'cli-path'), `${cli}\n`)

    execFileSync(process.execPath, [join(plugins, 'driver.mjs')], { cwd: plugins, stdio: 'pipe' })

    const accepted = (await readFile(join(root, 'accepted.tsv'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [event, json] = line.split('\t')
        return { event, payload: JSON.parse(json) as Record<string, unknown> }
      })
    const stops = accepted.filter((item) => item.event === 'Stop')
    expect(stops).toHaveLength(1)
    expect(stops[0].payload).toMatchObject({ session_id: 'delivery', error: 'stream aborted' })

    for (const item of accepted) {
      await handleRecorderHook({ provider: 'opencode', event: item.event, workspace: root, payload: item.payload })
    }
    const records = await listRecords(join(root, '.scry'))
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('failed')
    expect(records[0].errors.value).toEqual([expect.objectContaining({ message: 'stream aborted' })])
  })
})
