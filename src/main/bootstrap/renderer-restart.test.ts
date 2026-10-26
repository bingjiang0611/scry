import { describe, expect, it } from 'vitest'
import { createRendererRestartLog } from './renderer-restart'

describe('renderer restart log', () => {
  it('delivers the recorded restart exactly once', () => {
    const log = createRendererRestartLog(() => new Date('2026-10-26T07:30:28.000Z'))
    log.record('crashed', 139)
    expect(log.take()).toEqual({ reason: 'crashed', exitCode: 139, at: '2026-10-26T07:30:28.000Z' })
    // 第二次读取拿不到旧证据：否则下一次正常启动会继续报"刚刚重启过"。
    expect(log.take()).toBeNull()
  })

  it('keeps only the latest restart while nobody has read it', () => {
    const log = createRendererRestartLog()
    log.record('crashed', 139)
    log.record('oom', 137)
    expect(log.take()).toMatchObject({ reason: 'oom', exitCode: 137 })
  })
})
