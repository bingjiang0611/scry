import { describe, expect, it } from 'vitest'
import type { ProjectMeta, SessionMeta } from './env'
import {
  selectedExternalSessionId,
  sessionMatchesSelection,
  sessionSelectionChanged
} from './session-selection'

const session: SessionMeta = {
  sessionId: 'provider-session',
  externalSessionId: 'provider-session',
  runId: 'run-1',
  providerId: 'pi',
  agentProfileId: 'pi:default',
  mtime: 1,
  preview: '提交吧',
  count: 1
}

const selection = {
  cwd: '/repo/target',
  sessionId: 'run-1',
  providerId: 'pi' as const,
  agentProfileId: 'pi:default'
}

describe('session selection identity', () => {
  it('同时绑定 cwd/provider/profile 与任一会话别名', () => {
    expect(sessionMatchesSelection('/repo/other', session, selection)).toBe(false)
    expect(sessionMatchesSelection('/repo/target', { ...session, providerId: 'qoder', agentProfileId: undefined }, selection)).toBe(false)
    expect(sessionMatchesSelection('/repo/target', { ...session, agentProfileId: 'pi:other' }, selection)).toBe(false)
    expect(sessionMatchesSelection('/repo/target', session, selection)).toBe(true)
  })

  it('同会话别名不误判切换，跨 cwd/provider/profile 或无交集 ID 必须切换', () => {
    const current = selection
    const same = {
      cwd: '/repo/target',
      sessionId: 'provider-session',
      externalSessionId: 'provider-session',
      runId: 'run-1',
      providerId: 'pi' as const,
      agentProfileId: 'pi:default'
    }

    expect(sessionSelectionChanged(current, same)).toBe(false)
    expect(sessionSelectionChanged(current, { ...same, cwd: '/repo/other' })).toBe(true)
    expect(sessionSelectionChanged(current, { ...same, providerId: 'qoder', agentProfileId: undefined })).toBe(true)
    expect(sessionSelectionChanged(current, { ...same, agentProfileId: 'pi:other' })).toBe(true)
    expect(sessionSelectionChanged(current, {
      ...same,
      sessionId: 'other-session',
      externalSessionId: 'other-session',
      runId: 'run-2'
    })).toBe(true)
  })

  it('只返回 catalog 已确认的 provider sessionId，不把 provisional runId 冒充 sessionId', () => {
    const projects: ProjectMeta[] = [{
      cwd: '/repo/target',
      name: 'target',
      mtime: 1,
      sessions: [{ ...session, providerId: 'qoder', agentProfileId: undefined }]
    }]

    expect(selectedExternalSessionId(projects, {
      cwd: '/repo/target', sessionId: 'run-1', providerId: 'qoder'
    })).toBe('provider-session')
    expect(selectedExternalSessionId(projects, {
      cwd: '/repo/other', sessionId: 'run-1', providerId: 'qoder'
    })).toBeNull()
    expect(selectedExternalSessionId([{
      ...projects[0],
      sessions: [{ ...projects[0].sessions[0], externalSessionId: undefined }]
    }], {
      cwd: '/repo/target', sessionId: 'run-1', providerId: 'qoder'
    })).toBeNull()
  })
})
