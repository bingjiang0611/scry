import { execFile } from 'node:child_process'
import { workflowCheckCopy as copy } from '../shared/constants/copy'

function ps(args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => execFile('/bin/ps', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }, (error, stdout) => error ? reject(error) : resolveResult(stdout)))
}

export async function workflowCheckProcessIdentity(pid: number): Promise<string | undefined> {
  // Only this registered PID's arguments, not a machine-wide command dump.
  try { return (await ps(['-p', String(pid), '-o', 'lstart=,command='])).trim() || undefined } catch (error) {
    if ((error as { code?: number }).code === 1) return undefined
    throw error
  }
}

export async function workflowCheckGroupEmpty(pid: number): Promise<boolean> {
  const rows = (await ps(['-axo', 'pid=,pgid=,stat='])).trim().split('\n')
  let live = false
  for (const row of rows) {
    const columns = row.trim().split(/\s+/)
    if (columns.length !== 3 || !/^\d+$/.test(columns[0]) || !/^\d+$/.test(columns[1])) throw new Error(copy.scope)
    if (Number(columns[1]) === pid && !columns[2].startsWith('Z')) live = true
  }
  return !live
}
