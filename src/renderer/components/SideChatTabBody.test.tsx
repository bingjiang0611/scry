import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import { SideChatTabBody } from './SideChatTabBody'

const base = {
  draftStore: {} as never,
  agents: [] as never,
  onOpenConversation: () => {},
  onChanged: () => {}
}

describe('SideChatTabBody without a summary', () => {
  it('reads as loading, not unreadable, until the lookup has answered', () => {
    const html = renderToStaticMarkup(<SideChatTabBody {...base} loading />)
    expect(html).not.toContain(SIDE_CHAT_COPY.tabUnavailable)
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('data-side-chat-loading')
  })

  it('says the record is unreadable once the lookup has answered without it', () => {
    const html = renderToStaticMarkup(<SideChatTabBody {...base} />)
    expect(html).toContain(SIDE_CHAT_COPY.tabUnavailable)
    expect(html).not.toContain('aria-busy')
  })
})
