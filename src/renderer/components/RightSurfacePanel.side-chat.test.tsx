import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RightSurfacePanel, type RightSurfacePanelProps } from './RightSurfacePanel'
import { createRightSurfaceState, RIGHT_SURFACE_DEFINITIONS } from '../right-surface'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'

function render(overrides: Partial<RightSurfacePanelProps> = {}): string {
  const state = createRightSurfaceState({ openIds: [], visible: true })
  return renderToStaticMarkup(<RightSurfacePanel
    openIds={state.openIds} activeId={state.activeId} contents={{}} maximized={false}
    onOpen={() => {}} onActivate={() => {}} onClose={() => {}} onHide={() => {}} onToggleMaximized={() => {}}
    sideChatEntry={{
      label: SIDE_CHAT_COPY.surfaceLabel, description: SIDE_CHAT_COPY.entryDescription,
      onSelect: () => {}, historyLabel: SIDE_CHAT_COPY.historyLabel, onOpenHistory: () => {}
    }}
    {...overrides}
  />)
}

describe('surface chooser with the side-chat entry', () => {
  it('shows the approved wide card before the six unchanged tools', () => {
    const html = render()
    const entryIndex = html.indexOf('data-side-chat-entry')
    expect(entryIndex).toBeGreaterThan(-1)
    for (const definition of RIGHT_SURFACE_DEFINITIONS) {
      expect(html.indexOf(definition.label)).toBeGreaterThan(entryIndex)
      expect(html).toContain(definition.description)
    }
    expect(html).toContain(SIDE_CHAT_COPY.entryDescription)
    // The card is the first item of the same grid, not a second navigation layer.
    expect(html.indexOf('surface-card-grid')).toBeLessThan(entryIndex)
  })

  it('advertises a real reason instead of a no-op entry', () => {
    const html = render({ sideChatEntry: {
      label: SIDE_CHAT_COPY.surfaceLabel, description: SIDE_CHAT_COPY.entryDescription,
      unavailableReason: SIDE_CHAT_COPY.entryUnavailableNoTurn,
      onSelect: () => {}, historyLabel: SIDE_CHAT_COPY.historyLabel, onOpenHistory: () => {}
    } })
    expect(html).toContain(SIDE_CHAT_COPY.entryUnavailableNoTurn)
    // A card that cannot do anything says so and refuses the press instead of failing silently.
    expect(html).toContain('disabled=""')
  })

  it('does not create a child just by rendering the chooser or the add button', () => {
    const onSelect = vi.fn()
    const html = render({ sideChatEntry: {
      label: SIDE_CHAT_COPY.surfaceLabel, description: SIDE_CHAT_COPY.entryDescription,
      onSelect, historyLabel: SIDE_CHAT_COPY.historyLabel, onOpenHistory: () => {}
    } })
    expect(onSelect).not.toHaveBeenCalled()
    expect(html).not.toContain('role="menu"')
    expect(html).toContain('aria-haspopup="menu"')
    // No child body and no child tab exist before any creation happens.
    expect(html).not.toContain('data-side-chat-panel')
    expect(html).not.toContain('data-side-chat-tab-id')
  })
})

describe('flat tabs with child instances', () => {
  it('renders child tabs beside tool tabs with the full title available', () => {
    const longTitle = '一个很长很长的侧边会话标题用于检查截断与可访问名称'
    const html = render({
      openIds: ['files'], activeId: 'files',
      sideChats: ['child-a', 'child-b'], activeSideChatId: 'child-b',
      sideChatTabs: [
        { conversationId: 'child-a', title: longTitle, status: SIDE_CHAT_COPY.tabStatusPermission },
        { conversationId: 'child-b', title: '第二个' }
      ],
      renderSideChat: (id) => <p data-body={id}>body</p>
    })
    expect(html).toContain(`title="${longTitle}"`)
    expect(html).toContain(SIDE_CHAT_COPY.tabStatusPermission)
    expect(html).toContain('关闭 第二个')
    // Only the active child's body is mounted.
    expect(html).toContain('data-body="child-b"')
    expect(html).not.toContain('data-body="child-a"')
  })

  it('does not call the child renderer for an inactive tab at all', () => {
    const renderSideChat = vi.fn(() => <p>body</p>)
    render({ openIds: ['overview'], activeId: 'overview', sideChats: ['child-a'], activeSideChatId: null, renderSideChat })
    expect(renderSideChat).not.toHaveBeenCalled()
  })

  it('states that the layout could not be saved instead of pretending it is durable', () => {
    const html = render({ layoutNotice: SIDE_CHAT_COPY.layoutUnsaved })
    expect(html).toContain('data-layout-unsaved')
    expect(html).toContain(SIDE_CHAT_COPY.layoutUnsaved)
    expect(render()).not.toContain('data-layout-unsaved')
  })

  it('shows the chooser only when neither tools nor children are open', () => {
    const empty = render()
    expect(empty).toContain('data-surface-chooser')
    const withChild = render({ sideChats: ['child-a'], activeSideChatId: 'child-a',
      sideChatTabs: [{ conversationId: 'child-a', title: 'a' }] })
    expect(withChild).not.toContain('data-surface-chooser')
  })
})
