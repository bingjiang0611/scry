import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeUploadState, prepareUploadRoot, takeCustody, uploadRoot } from '../../dist/uploader.js'

const transport = fileURLToPath(new URL('./recovery-transport.mjs', import.meta.url))
const exporter = fileURLToPath(new URL('./recovery-exporter.mjs', import.meta.url))
export const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const nameOf = (sequence, id) => `${String(sequence).padStart(20, '0')}-${id}.json`

export async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-uploader-regression-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture' }))
  await mkdir(join(root, '.scry', 'records'), { recursive: true })
  await chmod(transport, 0o700)
  await chmod(exporter, 0o700)
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    TRANSPORT_CLI_PATH: transport,
    SCRY_CLI_PATH: exporter,
    RECOVERY_TRANSPORT_LOG: join(root, 'transport.log'),
    SCRY_UPLOADER_NO_SPAWN: '1',
    ...options
  }
  await prepareUploadRoot(root)
  await initializeUploadState(root, 0)
  return { root, env, base: uploadRoot(root) }
}

export async function writeCanonical(root, sequence, extra = {}) {
  const recordId = hash(`${root}:${sequence}`).slice(0, 32)
  const filename = nameOf(sequence, recordId)
  const record = {
    schemaVersion: 1,
    sequence,
    recordId,
    workspace: { id: 'fixture', root },
    provider: 'pi',
    sessionId: 'fixture',
    ...extra
  }
  const raw = JSON.stringify(record) + '\n'
  await writeFile(join(root, '.scry', 'records', filename), raw)
  return { recordId, filename, raw }
}

export async function custody(root, sequence, extra = {}) {
  const record = await writeCanonical(root, sequence, extra)
  await takeCustody(root, {
    schemaVersion: 2,
    event: 'record-committed',
    workspace: root,
    provider: 'pi',
    sessionId: 'fixture',
    sequence,
    recordId: record.recordId,
    recordPath: `records/${record.filename}`,
    sha256: hash(record.raw)
  })
  return record
}

export async function logs(path) {
  try {
    const raw = await readFile(path, 'utf8')
    return raw.trim() ? raw.trim().split('\n').map(JSON.parse) : []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function waitFor(predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('bounded wait expired')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export function reportIds(entries) {
  return entries.filter((entry) => entry.phase === 'start').flatMap((entry) => entry.ids ?? [])
}
