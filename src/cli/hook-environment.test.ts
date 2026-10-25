import { spawnSync } from 'node:child_process'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initWorkspace } from './workspace-init.js'
import { gitWorkspace } from './scry.test-fixture.js'

it.each([
  { managed: false, transport: '' },
  { managed: false, transport: 'direct' },
  { managed: true, transport: '' }
])('clears an inherited daemon-attempt marker before any hook branch ($managed, $transport)', async ({ managed, transport }) => {
  const root = await gitWorkspace()
  const cli = join(root, 'capture.cjs')
  const output = join(root, 'captured.json')
  await writeFile(cli, `#!${process.execPath}\nconst fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ marker: process.env.SCRY_RECORDER_DAEMON_TRIED ?? null, argv: process.argv.slice(2), payload: fs.readFileSync(0, 'utf8') }))\n`)
  await chmod(cli, 0o700)
  await initWorkspace({ workspace: root, providers: 'claude', cliPath: cli })
  const payload = JSON.stringify({ session_id: 'isolated-hook', prompt: 'fixture' })
  const result = spawnSync(join(root, '.scry/provider-hook.sh'), ['claude', 'UserPromptSubmit'], {
    input: payload, encoding: 'utf8', env: { ...process.env,
      SCRY_RECORDER_DAEMON_TRIED: '1', SCRY_RECORDER_TRANSPORT: transport,
      SCRY_RECORDER_MANAGED: managed ? '1' : '0', SCRY_CLI_PATH: cli }
  })
  expect(result.status, result.stderr).toBe(0)
  const captured = JSON.parse(await readFile(output, 'utf8'))
  expect(captured.marker).toBeNull()
  expect(captured.payload).toBe(payload)
  expect(captured.argv).toEqual(['recorder', 'hook', '--provider', 'claude', '--event', 'UserPromptSubmit',
    '--workspace', root, '--stdin', '--quiet', ...(managed ? ['--managed'] : [])])
}, 10_000)
