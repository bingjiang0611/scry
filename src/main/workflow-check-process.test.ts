import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { workflowCheckGroupEmpty, workflowCheckProcessIdentity } from './workflow-check-process'

async function registeredGroup() {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Owned fixture exit ' + code)))
  })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  return { pid: child.pid!, close: async () => { child.stdin!.end(); await closed } }
}

describe('native check registered process-group proof', () => {
  it('distinguishes a live registered group from actual physical closure', async () => {
    const group = await registeredGroup()
    try {
      expect(await workflowCheckProcessIdentity(group.pid)).toEqual(expect.any(String))
      expect(await workflowCheckGroupEmpty(group.pid)).toBe(false)
    } finally { await group.close() }
    expect(await workflowCheckGroupEmpty(group.pid)).toBe(true)
    expect(await workflowCheckProcessIdentity(group.pid)).toBeUndefined()
  })

  it('does not turn a denied existence query into empty-group evidence', async () => {
    const group = await registeredGroup()
    const original = process.kill
    const denied = Object.assign(new Error('existence query denied'), { code: 'EPERM' })
    const query = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -group.pid && signal === 0) throw denied
      return original(pid, signal)
    })
    try { await expect(workflowCheckGroupEmpty(group.pid)).rejects.toBe(denied) }
    finally { query.mockRestore(); await group.close() }
  })
})
