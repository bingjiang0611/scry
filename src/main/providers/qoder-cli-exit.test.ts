import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// macOS verifier, Qoder in both modes: every turn ended "Qoder CLI process exited with
// code 1" and nothing else. Scry spawns the CLI itself (to know its process identity),
// and the SDK only keeps the stderr of a CLI it spawned, so the CLI's own reason for
// exiting was dropped. A real SDK and a real child process here: a fake `qodercli` that
// says why on stderr and exits 1, in a temporary home and workspace.

const fake = vi.hoisted(() => ({ cli: '' }))
vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => fake.cli,
  runtimeCliEnv: () => ({ PATH: process.env.PATH }),
  shellEnv: () => ({})
}))

import { createQoderAdapter } from './qoder'

const TOKEN = 'sk-ant-api03-scry-qoder-exit-not-a-real-key-0000000'
let root = ''
const saved = { HOME: process.env.HOME, SCRY_QODER_LOG_HOOKS: process.env.SCRY_QODER_LOG_HOOKS, SCRY_QODERCLI_PATH: process.env.SCRY_QODERCLI_PATH }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scry-qoder-exit-'))
  fake.cli = join(root, 'qodercli')
  // More than the kept tail first, so only the end of stderr may come back.
  await writeFile(fake.cli, [
    '#!/bin/sh',
    `i=0; while [ $i -lt 200 ]; do echo "qoder: early noise line $i ................................" >&2; i=$((i+1)); done`,
    `echo "qoder: refusing to start: config at ~/.qoder/settings.json is invalid (Authorization: Bearer ${TOKEN})" >&2`,
    'exit 1',
    ''
  ].join('\n'))
  await chmod(fake.cli, 0o755)
  process.env.HOME = root
  process.env.SCRY_QODER_LOG_HOOKS = '0'
  delete process.env.SCRY_QODERCLI_PATH
})

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

it('reports the CLI\'s own stderr, bounded and with secrets masked, when the Qoder CLI exits 1', async () => {
  const run = createQoderAdapter(root).run({
    runId: 'qoder-exit-1', prompt: 'fixture only', cwd: root, attachments: [], emit: () => undefined
  })
  const error = await run.promise.then(() => undefined, (reason: unknown) => reason as Error)
  expect(error).toBeInstanceOf(Error)
  expect(error!.message).toContain('Qoder CLI process exited with code 1')
  expect(error!.message).toContain('refusing to start: config at ~/.qoder/settings.json is invalid')
  expect(error!.message).not.toContain(TOKEN)
  expect(error!.message).not.toContain('early noise line 0 ')
  expect(error!.message.length).toBeLessThan(4_600)
}, 20_000)
