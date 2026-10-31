import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeUploadState, prepareUploadRoot, uploadRoot } from '../../dist/uploader.js'

const fakeTransport = fileURLToPath(new URL('./fake-transport.mjs', import.meta.url))

export async function fixture(t, exportScript) {
  const root = await mkdtemp(join(tmpdir(), 'scry-reliability-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(
    join(root, 'scry.config.json'),
    JSON.stringify({ schemaVersion: 1, workspaceId: 'fixture' })
  )
  await mkdir(join(root, '.scry/records'), { recursive: true })
  const scry = join(root, 'fixture-scry.mjs')
  await writeFile(
    scry,
    '#!/usr/bin/env node\n' +
      (exportScript ??
        "console.log(JSON.stringify({records:[],nextCursor:Number(process.argv[process.argv.indexOf('--after')+1]),snapshotMaxSequence:0,hasMore:false}))\n")
  )
  await chmod(scry, 0o700)
  const env = {
    ...process.env,
    HOME: join(root, '.home'),
    XDG_STATE_HOME: join(root, '.state'),
    TRANSPORT_CLI_PATH: fakeTransport,
    FAKE_TRANSPORT_LOG: join(root, 'transport.log'),
    SCRY_CLI_PATH: scry,
    SCRY_UPLOADER_NO_SPAWN: '1'
  }
  await prepareUploadRoot(root)
  await initializeUploadState(root, 0)
  return { root, env, base: uploadRoot(root) }
}
