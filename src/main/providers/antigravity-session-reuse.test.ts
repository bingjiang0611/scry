import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProviderSessionHost } from '../../host-runtime/provider-sessions/session-host'
import type { AntigravityProcessSession } from './antigravity-session'
import { runAntigravity } from './antigravity-run'

const FAKE_FIXTURE_SOURCE = join(process.cwd(), 'src/main/providers/fixtures/fake-agy-acp.mjs')
const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function installFakeAgy(): { dir: string; binPath: string } {
  const dir = makeTempDir('scry-agy-reuse-')
  const binPath = join(dir, 'fake-agy')
  const source = readFileSync(FAKE_FIXTURE_SOURCE, 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`)
  writeFileSync(binPath, source, { mode: 0o755 })
  chmodSync(binPath, 0o755)
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ recordSpawns: true }), 'utf8')
  return { dir, binPath }
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
  delete process.env.SCRY_AGY_PATH
})

function spawnCount(dir: string): number {
  const path = join(dir, 'spawns.log')
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length
}

it('C1: a second turn on the same session reuses one ACP process instead of spawning another', async () => {
  const { dir, binPath } = installFakeAgy()
  process.env.SCRY_AGY_PATH = binPath
  const host = new ProviderSessionHost<AntigravityProcessSession>({ maxSessions: 4 })
  const homeDir = makeTempDir('scry-home-reuse-')
  const cwd = makeTempDir('scry-ws-reuse-')

  const first = await runAntigravity(
    { runId: 'c1-a', prompt: 'hi', cwd, attachments: [], permissionMode: 'default', emit: () => undefined },
    { homeDir, sessions: host }
  ).promise
  const sessionId = first.externalSessionId
  expect(sessionId).toBeTruthy()
  expect(spawnCount(dir)).toBe(1)

  const second = await runAntigravity(
    {
      runId: 'c1-b', prompt: 'again', cwd, attachments: [], permissionMode: 'default',
      resume: sessionId, emit: () => undefined
    },
    { homeDir, sessions: host }
  ).promise

  expect(second.externalSessionId).toBe(sessionId)
  expect(spawnCount(dir)).toBe(1)
  await host.closeAll()
})

it('C1: without a session host every turn still owns its own process', async () => {
  const { dir, binPath } = installFakeAgy()
  process.env.SCRY_AGY_PATH = binPath
  const homeDir = makeTempDir('scry-home-noReuse-')
  const cwd = makeTempDir('scry-ws-noReuse-')
  const first = await runAntigravity(
    { runId: 'c1-c', prompt: 'hi', cwd, attachments: [], permissionMode: 'default', emit: () => undefined },
    { homeDir }
  ).promise
  await runAntigravity(
    {
      runId: 'c1-d', prompt: 'again', cwd, attachments: [], permissionMode: 'default',
      resume: first.externalSessionId, emit: () => undefined
    },
    { homeDir }
  ).promise
  expect(spawnCount(dir)).toBe(2)
})
