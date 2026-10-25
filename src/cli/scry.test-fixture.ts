import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'


export const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

export async function workspace(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'scry-cli-test-'))
  roots.push(created)
  const root = await realpath(created)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'cli-test',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  return root
}

export function captureStdout(): { text: () => string } {
  let output = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stdout.write)
  return { text: () => output }
}

/** `scry init` refuses anything that is not a Git project root. */
export async function gitWorkspace(): Promise<string> {
  const root = await workspace()
  execFileSync('git', ['init', '-q', '.'], { cwd: root })
  return root
}
