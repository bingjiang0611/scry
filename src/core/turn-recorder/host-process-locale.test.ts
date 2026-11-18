import { execFile } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { hostProcessChain, hostProcessState } from './host-process'

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockRejectedValue(new Error('fixture without /proc')),
  readFile: vi.fn()
}))
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_command, _args, options, callback) => {
    const locale = options.env?.LC_ALL ?? process.env.LC_ALL
    callback(null, locale === 'C'
      ? ' 42 1 Tue Nov 17 12:00:00 2026\n'
      : ' 42 1 二 11月 17 12:00:00 2026\n')
  })
}))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it('does not expire a live pid whose legacy 24-character start token used another locale', async () => {
  expect(await hostProcessState([{ pid: 42, token: 'Di. Nov 17 12:00:00 2026' }])).toBe('unknown')
  expect(await hostProcessState([{ pid: 42, token: 'Tue Nov 17 11:00:00 2026' }])).toBe('gone')
  expect(await hostProcessState([{ pid: 99, token: 'Di. Nov 17 12:00:00 2026' }])).toBe('gone')
})

it.each(['zh_CN.UTF-8', 'fr_FR.UTF-8'])('keeps the same host identity when LC_ALL is %s', async locale => {
  vi.stubEnv('LC_ALL', locale)
  vi.stubEnv('LC_TIME', 'C')
  const chain = await hostProcessChain(42)
  expect(chain).toEqual([{ pid: 42, token: 'Tue Nov 17 12:00:00 2026' }])
  expect(await hostProcessState(chain)).toBe('running')
  expect(process.env.LC_ALL).toBe(locale)
  expect(execFile).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,lstart='],
    expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C' }) }), expect.any(Function))
})
