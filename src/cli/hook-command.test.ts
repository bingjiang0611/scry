import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initWorkspace, integrationsRepair } from './workspace-init'

const roots: string[] = []
const providers = [
  { id: 'claude', path: '.claude/settings.local.json', variable: 'CLAUDE_PROJECT_DIR' },
  { id: 'codex', path: '.codex/hooks.json', variable: 'CODEX_PROJECT_DIR' },
  { id: 'qoder', path: '.qoder/settings.json', variable: 'QODER_PROJECT_DIR' }
] as const

type Settings = { hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]> }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const base = await mkdtemp('/tmp/scry-command-')
  roots.push(base)
  const root = join(base, 'repo with spaces')
  await mkdir(root)
  execFileSync('git', ['init', '-q', root])
  await initWorkspace({ workspace: root, providers: 'claude,codex,qoder', cliPath: process.execPath })
  const hook = join(root, '.scry/provider-hook.sh')
  await writeFile(hook, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE/argv"\ncat > "$CAPTURE/payload"\n')
  await chmod(hook, 0o700)
  const nested = join(root, 'src/deep')
  await mkdir(nested, { recursive: true })
  return { base, root, nested, hook }
}
async function settings(root: string, path: string): Promise<Settings> {
  return JSON.parse(await readFile(join(root, path), 'utf8')) as Settings
}
function run(command: string, cwd: string, base: string, variable?: string, root?: string) {
  return spawnSync('/bin/sh', ['-c', command], { cwd, input: '{"session_id":"nested","prompt":"private"}', encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, XDG_STATE_HOME: join(base, 'state'), CAPTURE: base, ...(variable ? { [variable]: root } : {}) } })
}

it.each(providers)('$id locates the nearest bridge from a subdirectory without a project-dir variable', async provider => {
  const { base, root, nested } = await fixture()
  const command = (await settings(root, provider.path)).hooks.Stop[0].hooks[0].command
  const result = run(command, nested, base)
  expect(result.status).toBe(0)
  expect(await readFile(join(base, 'argv'), 'utf8')).toBe(`${provider.id}\nStop\n`)
  expect(await readFile(join(base, 'payload'), 'utf8')).toBe('{"session_id":"nested","prompt":"private"}')
  await rm(join(base, 'argv'))
  expect(run(command, base, base, provider.variable, root).status).toBe(0)
  expect(await readFile(join(base, 'argv'), 'utf8')).toBe(`${provider.id}\nStop\n`)
})

it.each(['nested-git', 'missing', 'not-executable'])('missing bridge (%s) stays fail open and logs without crossing a git boundary', async scenario => {
  const { base, root, nested, hook } = await fixture()
  if (scenario === 'nested-git') execFileSync('git', ['init', '-q', join(root, 'src')])
  else if (scenario === 'missing') await rm(hook)
  else await chmod(hook, 0o600)
  const command = (await settings(root, '.codex/hooks.json')).hooks.Stop[0].hooks[0].command
  expect(run(command, nested, base).status).toBe(0)
  await expect(readFile(join(base, 'argv'))).rejects.toMatchObject({ code: 'ENOENT' })
  const log = await readFile(join(base, 'state/scry/hook-skip.log'), 'utf8')
  expect(log).toMatch(/\tcodex\tStop\tbridge_not_found\t0\n$/)
  expect(log).not.toContain('private')
})

it.each(providers)('repair replaces old $id commands rather than appending duplicates, and is idempotent', async provider => {
  const { root } = await fixture()
  const old = await settings(root, provider.path)
  const oldCommand = `SCRY_HANDLER_ID=turn-recorder-v1 sh -c 'root="\${${provider.variable}:-$PWD}"; exec "$root/.scry/provider-hook.sh" ${provider.id} Stop'`
  const foreign = { type: 'command', command: 'printf foreign', timeout: 7 }
  old.hooks.Stop = [{ hooks: [foreign, { type: 'command', command: oldCommand, timeout: 15 }, { type: 'command', command: oldCommand, timeout: 15 }] }]
  await writeFile(join(root, provider.path), JSON.stringify(old))
  await integrationsRepair({ workspace: root, cliPath: process.execPath })
  const repaired = await settings(root, provider.path)
  const hooks = repaired.hooks.Stop.flatMap(group => group.hooks)
  expect(hooks.filter(hook => hook.command.includes('SCRY_HANDLER_ID='))).toHaveLength(1)
  expect(hooks.find(hook => hook.command.includes('SCRY_HANDLER_ID='))!.command).not.toBe(oldCommand)
  expect(hooks).toContainEqual(foreign)
  const second = await integrationsRepair({ workspace: root, cliPath: process.execPath })
  expect(second.rewritten).toEqual([])
})
