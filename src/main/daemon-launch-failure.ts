import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The daemon supervisor records why it stopped in `<state>/supervisor-failure.json`
// (src/daemon/supervisor.ts). A refusal that waiting cannot fix, such as
// `daemon_userdata_owned`, makes the supervisor stop within a second; without this
// reader the App would wait out its whole ready timeout and then report only
// `daemon_ready_timeout`. Only a machine code written after this launch is returned:
// an older file describes an earlier attempt, and free text may carry paths.
const FAILURE_FILE = 'supervisor-failure.json'
const MACHINE_CODE = /^(?:daemon|remote)_[a-z0-9_]+$/

export async function readDaemonLaunchFailure(stateDirectory: string, since: number): Promise<string | undefined> {
  let parsed: { failedAt?: unknown; reason?: unknown }
  try {
    parsed = JSON.parse(await readFile(join(stateDirectory, FAILURE_FILE), 'utf8')) as typeof parsed
  } catch {
    // Absent or mid-rename: nothing to report yet, the caller keeps waiting.
    return undefined
  }
  if (typeof parsed.failedAt !== 'number' || parsed.failedAt < since) return undefined
  return typeof parsed.reason === 'string' && MACHINE_CODE.test(parsed.reason) ? parsed.reason : undefined
}
