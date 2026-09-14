import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/

interface PersistedRelayCredential {
  version: 1
  hostId: string
  token: string
}

function writePrivateAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp-${randomUUID()}`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  const dir = openSync(join(path, '..'), 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
}

// Public-relay admission uses a random credential scoped to this unguessable
// hostId. It is generated once and persisted beside the host identity, never
// bundled into the app or shared by every installation. The relay stores only
// its SHA-256 digest when the room is first claimed; inner mTLS remains the data
// security boundary.
export function ensureRelayCredential(stateDirectory: string, hostId: string): string {
  if (!UUID.test(hostId)) throw new Error('relay_credential_host_invalid')
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
  chmodSync(stateDirectory, 0o700)
  const path = join(stateDirectory, 'credential.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedRelayCredential
    if (parsed?.version !== 1 || parsed.hostId !== hostId || !TOKEN.test(parsed.token)) {
      throw new Error('relay_credential_corrupt')
    }
    return parsed.token
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const token = randomBytes(32).toString('base64url')
  writePrivateAtomic(path, JSON.stringify({ version: 1, hostId, token } satisfies PersistedRelayCredential))
  return token
}
