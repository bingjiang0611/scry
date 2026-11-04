import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runConcurrentFixture } from './fixtures/concurrent-performance-provider'

it('loads Hook instrumentation from a path containing spaces and double quotes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry fixture "quoted" '))
  const cwd = join(root, 'workspace')
  const marker = join(root, 'loaded.txt')
  const probe = join(root, 'probe "quoted".cjs')
  await mkdir(join(cwd, '.scry'), { recursive: true })
  await writeFile(probe, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'loaded\\n')`)
  await writeFile(join(cwd, '.scry/provider-hook.sh'), '#!/bin/sh\nexec "$SCRY_FIXTURE_NODE" -e "process.stdout.write(\'ok\')"\n')
  vi.stubEnv('SCRY_CONCURRENT_PROBE', probe)
  vi.stubEnv('SCRY_FIXTURE_NODE', process.execPath)
  try {
    const run = runConcurrentFixture({
      runId: 'quoted-path-fixture', prompt: 'fixture', cwd, attachments: [], emit: () => {},
      managedRecorder: true, managedRecorderIdentity: { runId: 'quoted-path-fixture', promptHash: 'fixture-hash' }
    }, 'claude')
    // Exercise both lifecycle Hooks without running the 20-second streaming workload.
    run.interrupt()
    const result = await run.promise
    expect(result.status).toBe('interrupted')
    expect(await readFile(marker, 'utf8')).toBe('loaded\nloaded\n')
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
