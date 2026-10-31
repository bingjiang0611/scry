import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComposerDraftAttachment, ComposerPendingSubmission } from '../composer-drafts'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import { PendingSubmissionDialog } from './PendingSubmissionDialog'

const attachment = (name: string): ComposerDraftAttachment => ({
  id: `id-${name}`,
  kind: 'image',
  name,
  mimeType: 'image/png',
  dataBase64: 'aGVsbG8=',
  size: 5,
  previewUrl: `data:image/png;base64,aGVsbG8=`
})

const pending = (overrides: Partial<ComposerPendingSubmission> = {}): ComposerPendingSubmission => ({
  commandId: 'command-1',
  conversationId: 'child-1',
  prompt: '侧聊待核对 原文🙂🀄️\n第二行 <不能当标签>',
  attachments: [attachment('pending-shot.png')],
  target: { providerId: 'codex', permissionMode: 'default' },
  selectedItems: [],
  expectedRevision: 3,
  expectedContinuationKey: 'continuation-1',
  phase: 'unknown',
  submittedAt: Date.UTC(2026, 0, 2, 3, 4),
  ...overrides
})

const render = (overrides: Partial<ComposerPendingSubmission> = {}, state: 'not_sent' | 'unresolved' = 'unresolved'): string =>
  renderToStaticMarkup(<PendingSubmissionDialog pending={pending(overrides)} state={state} onClose={() => {}} />)

describe('待核对发送的只读原文回执', () => {
  it('原样显示提交的 Unicode 原文，不经过 Markdown 或命令解析', () => {
    const html = render()
    // 原文逐字出现，包括表情、换行与被转义的尖括号；回执不改写用户提交的内容。
    expect(html).toContain('侧聊待核对 原文🙂🀄️\n第二行 &lt;不能当标签&gt;')
    expect(html).toContain('data-pending-content-text')
    expect(html).toContain('data-pending-content="command-1"')
  })

  it('显示提交的图片文件名，并复用真实图片的 data URL 与预览入口', () => {
    const html = render()
    expect(html).toContain('pending-shot.png')
    expect(html).toContain('src="data:image/png;base64,aGVsbG8="')
    expect(html).toContain('data-pending-content-image="pending-shot.png"')
    expect(html).toContain(`aria-label="${SIDE_CHAT_COPY.pendingInspectClose}"`)
  })

  it('回执只读：只有关闭，没有发送或重发动作', () => {
    for (const state of ['unresolved', 'not_sent'] as const) {
      const html = render({}, state)
      // not_sent 的说明文字本身就提到“重新发送”，所以这里看的是有没有这个按钮。
      expect(html).not.toContain('重新发送</button>')
      expect(html).not.toContain('class="send"')
      expect(html).toContain(SIDE_CHAT_COPY.pendingInspectReadonly)
    }
  })

  it('状态文案跟着持久回执走，不自己猜结果', () => {
    expect(render({}, 'not_sent')).toContain(SIDE_CHAT_COPY.pendingStates.notSent)
    expect(render({}, 'unresolved')).toContain(SIDE_CHAT_COPY.pendingStates.unresolved)
  })

  it('只有图片时说明没有文字，不渲染空的原文块', () => {
    const html = render({ prompt: '' })
    expect(html).toContain(SIDE_CHAT_COPY.pendingInspectNoText)
    expect(html).not.toContain('data-pending-content-text')
  })
})
