import { json } from './side-chat-driving.mjs'

/**
 * What the sidebar shows about a side chat whose panel is hidden while it runs.
 *
 * The sidebar prints nothing about a side chat itself: no counter and no row. A hidden
 * running child is still visible as activity of its parent, whose row the activity tab
 * lifts into "working" or "attention". `hidden` is the state the caller read right after
 * hiding the panel.
 */
export async function expectHiddenChildLiftsParent({ evaluate, check, clickAt, wait, childId, hidden }) {
  check(hidden.sidebarCounts.length === 0, `the sidebar still printed a side-chat counter: ${json(hidden)}`)
  const otherSidebarTab = `[...document.querySelectorAll('#sidebar-pane [role="tab"]')].find(node => node.getAttribute('aria-selected') !== 'true')`
  await clickAt(otherSidebarTab)
  await wait(`document.querySelector('#sidebar-pane .sb-activity') != null`)
  const lifted = await evaluate(`(() => {
    const live = [...document.querySelectorAll('#sidebar-pane .sb-activity-item')]
      .filter(node => ['working', 'attention'].includes(node.dataset.activityGroup))
    return { live: live.map(node => node.dataset.activityGroup),
      childRows: [...document.querySelectorAll('#sidebar-pane [data-conversation-id]')]
        .filter(node => node.dataset.conversationId === ${json(childId)}).length }
  })()`)
  check(lifted.live.length > 0 && lifted.childRows === 0,
    `a hidden running child must lift its parent's activity row and add none of its own: ${json({ lifted, hidden })}`)
  await clickAt(otherSidebarTab)
  await wait(`document.querySelector('#sidebar-pane .sb-activity') == null`)
  return lifted
}
