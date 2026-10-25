import { execFile, spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { workflowCheckGroupEmpty } from '../../src/main/workflow-check-process'
import { defaultRepeats, measured, repeatCounters, writeCollector } from '../performance-counters.mjs'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

async function closedGroup(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Owned fixture exit ' + code))) })
  expect(child.pid).toBeGreaterThan(0)
  return child.pid!
}
function listCalls(): number {
  return vi.mocked(execFile).mock.calls.filter(([file, args]) => file === '/bin/ps' && Array.isArray(args) && args[0] === '-axo').length
}
async function observe(pid: number, extraList = false) {
  const before = listCalls()
  expect(await workflowCheckGroupEmpty(pid)).toBe(true)
  if (extraList) await execFileAsync()
  return { processLists: listCalls() - before }
}

describe('closed registered native check group observation', () => {
  it('counts real group-list subprocesses after a registered child has physically closed', async () => {
    const pid = await closedGroup()
    const runs = await repeatCounters(defaultRepeats, () => observe(pid))
    writeCollector('workflow-check-scope', [measured({ scenario: 'workflow.check-closed-group', layer: 'main', unit: 'count',
      metric: 'subprocess.group-list', workload: 'registered-process-groups=1;child-close=observed;group-probes=1;escaped-descendants=not-claimed',
      source: 'pass-through production execFile calls for actual /bin/ps group-list queries after one owned local Node group closes' }, runs.processLists)])
  })

  it('detects an intentionally added actual process-list command', async () => {
    const pid = await closedGroup()
    const ordinary = await observe(pid), redundant = await observe(pid, true)
    expect(redundant.processLists).toBe(ordinary.processLists + 1)
  })
})

function execFileAsync(): Promise<void> {
  return new Promise((resolve, reject) => execFile('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' }, error => error ? reject(error) : resolve()))
}
