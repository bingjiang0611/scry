import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { vi } from 'vitest'
import { piProfileForExecutable } from '../pi-agent-profiles'
import * as shellEnvironment from '../claude-locate'
import { piFixtureSourceHead } from './pi-test-fixture-source-head'
import { piFixtureSourceTail } from './pi-test-fixture-source-tail'

export const fixtureSource = piFixtureSourceHead + piFixtureSourceTail

export async function withFixture<T>(
  run: (profile: ReturnType<typeof piProfileForExecutable>, cwd: string) => Promise<T>,
  executableName = 'fixture-pi'
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'scry-pi-rpc-'))
  const executable = join(dir, executableName)
  writeFileSync(executable, fixtureSource)
  chmodSync(executable, 0o755)
  // RPC fixtures must not discover the developer's login shell, Node shims or auth namespace.
  // Launcher-selection tests supply their own environment explicitly; transport and recorder IO stay real.
  const environment = vi.spyOn(shellEnvironment, 'shellEnv').mockReturnValue({
    PATH: dirname(process.execPath), HOME: dir, PI_AGENT_NODE: process.execPath, ROTOM_NODE: process.execPath
  })
  try {
    return await run(piProfileForExecutable(executable), dir)
  } finally {
    environment.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
}

export function withRotomFixture<T>(run: (profile: ReturnType<typeof piProfileForExecutable>, cwd: string) => Promise<T>): Promise<T> {
  return withFixture(run, 'rotom')
}

export const withCommandFixture = withRotomFixture
