import { describe, expect, it } from 'vitest'
import { SIDE_CHAT_COPY } from './side-chat-copy'

describe('side-chat failure copy', () => {
  it('drops the IPC channel wrapper and keeps the actionable reason', () => {
    const error = new Error(`Error invoking remote method 'conversation:previewSideChat': Error: 来源快照范围已变化`)
    expect(SIDE_CHAT_COPY.reasonOf(error)).toBe('来源快照范围已变化')
  })

  it('drops an internal error class name so the refusal stays readable', () => {
    // The exact shape a refused native source produces: the class name is evidence,
    // not something the user can act on.
    const error = new Error(`Error invoking remote method 'conversation:previewSideChat': `
      + 'TraceArchiveCaptureError: 来源归档属于其它 Agent Profile，不能作为侧聊来源')
    expect(SIDE_CHAT_COPY.reasonOf(error)).toBe('来源归档属于其它 Agent Profile，不能作为侧聊来源')
    expect(SIDE_CHAT_COPY.createRefused(SIDE_CHAT_COPY.reasonOf(error)))
      .toBe('没有创建侧边会话：来源归档属于其它 Agent Profile，不能作为侧聊来源')
  })

  it('leaves a plain reason alone and falls back when nothing actionable is left', () => {
    expect(SIDE_CHAT_COPY.reasonOf(new Error('该原生会话没有已终止的轮次；不会创建空快照')))
      .toBe('该原生会话没有已终止的轮次；不会创建空快照')
    // A class name alone carries no instruction, so it becomes the honest unknown.
    expect(SIDE_CHAT_COPY.reasonOf(new Error('TraceArchiveCaptureError: '))).toBe(SIDE_CHAT_COPY.unknownReason)
    expect(SIDE_CHAT_COPY.reasonOf(new Error(`Error invoking remote method 'x:y': Error: `)))
      .toBe(SIDE_CHAT_COPY.unknownReason)
    expect(SIDE_CHAT_COPY.reasonOf('side-chat unavailable')).toBe('side-chat unavailable')
  })

  it('only removes a leading error prefix, never an ordinary sentence', () => {
    expect(SIDE_CHAT_COPY.reasonOf(new Error('Error: 目标 Provider 未提供已验证的历史检索工具，不能省略历史')))
      .toBe('目标 Provider 未提供已验证的历史检索工具，不能省略历史')
    expect(SIDE_CHAT_COPY.reasonOf(new Error('rerun the preview: 来源已变化'))).toBe('rerun the preview: 来源已变化')
  })
})
