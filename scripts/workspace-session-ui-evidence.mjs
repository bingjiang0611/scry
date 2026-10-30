import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { wait } from './workspace-session-ui-run.mjs'

/** Provider invocations recorded by the isolated fixture; steering requests are not new runs. */
export const providerInputs = (path) => existsSync(path)
  ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(item => item.operation !== 'steer') : []

/** Canonical recorder record for one run inside the prepared target workspace. */
export const recorderRecord = (cwd, runId) => wait(() => {
  const dir = join(cwd, '.scry', 'records')
  if (!existsSync(dir)) return null
  for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const value = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    if (JSON.stringify(value).includes(runId)) return value
  }
  return null
}, 'canonical recorder record in the prepared target')
