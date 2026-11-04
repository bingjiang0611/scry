import { rm } from 'node:fs/promises'
import { afterEach } from 'vitest'

export function piIntegrationTestRoots(): string[] {
  const roots: string[] = []
  afterEach(async () => {
    delete process.env.SCRY_CLI_PATH
    delete process.env.SCRY_RECORDER_SOCKET
    delete process.env.SCRY_PI_SOCKET_TIMEOUT_MS
    delete process.env.SCRY_RECORDER_TRANSPORT
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })
  return roots
}
