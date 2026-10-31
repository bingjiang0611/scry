import { randomUUID } from 'node:crypto'
import { json, sideChatDriver } from './side-chat-driving.mjs'

/** One page of the sidebar orphan list; the component's own bound, restated as evidence. */
const GROUP_PAGE = 6
/** Two whole group pages plus one source, so the thirteenth group must exist on page three. */
const EXTRA_SOURCES = 12
const ROW_BATCH = 20

/**
 * The bounds of the orphan list, measured on the shipped sidebar.
 *
 * Two levels page by replacement: at most one page of groups, and one page of rows per
 * group. The extra sources are built from real records (one completed turn, one child
 * each) and removed through the shipped delete IPC, so the grouping is the same
 * provenance the orphan pass proves, only many times over. Nothing here reads a child
 * transcript or fabricates a group.
 */
export async function exerciseSideChatOrphanPaging({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath,
  workspace, rendererFailures = [], existingGroups, knownKeys }) {
  const { capture, clickAt, idle, wait, seedTurns, createChildOf } = sideChatDriver({ cdp, evaluate, check,
    ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat orphan paging' })
  const parents = await evaluate(`(async () => {
    const ids = []
    for (let index = 0; index < ${EXTRA_SOURCES}; index += 1) {
      ids.push(await window.scry.conversations.create(${json(workspace)}).then(created => created.id))
    }
    return ids
  })()`)
  const children = []
  for (const [index, parentId] of parents.entries()) {
    await seedTurns(parentId, [`side chat group source ${index + 1}`])
    children.push(await createChildOf({ kind: 'conversation', conversationId: parentId }, randomUUID()))
  }
  // The shipped archive-then-delete path removes the logical entry; the children keep
  // their own provenance, which is exactly what the orphan grouping reads.
  const deleted = await evaluate(`(async () => {
    const out = []
    for (const id of ${json(parents)}) {
      const page = await window.scry.conversations.read(id)
      await window.scry.conversations.update(id, page.summary.revision, { kind: 'archive', archived: true })
      const plan = await window.scry.conversations.previewDeletion(id)
      out.push(await window.scry.conversations.delete(id, plan.fingerprint)
        .then(result => ({ ok: result.ok === true }), error => ({ error: String(error) })))
    }
    return out
  })()`)
  check(deleted.every(result => result.ok === true),
    `every extra source must really be deleted before its children can be grouped: ${json(deleted)}`)
  const expectedGroups = existingGroups + EXTRA_SOURCES
  /** One page of the sidebar's own orphan list. */
  const readGroups = () => evaluate(`(() => {
    const root = document.querySelector('[data-side-chat-orphans]')
    if (!root) return null
    const groups = [...root.querySelectorAll('[data-orphan-group-key]')]
    return { page: root.querySelector('[data-orphan-groups-page]')?.dataset.orphanGroupsPage ?? null,
      range: root.querySelector('[data-orphan-groups-range]')?.dataset.orphanGroupsRange ?? null,
      label: root.querySelector('[data-orphan-groups-range]')?.textContent?.trim() ?? null,
      keys: groups.map(node => node.dataset.orphanGroupKey),
      rows: groups.map(node => node.querySelectorAll('[data-orphan-side-chat-id]').length),
      renderedRows: root.querySelectorAll('[data-orphan-side-chat-id]').length,
      pagerRows: [...root.querySelectorAll('[data-orphan-rows-page]')].map(node => node.dataset.orphanRowsPage) }
  })()`)
  await wait(`(() => {
    const range = document.querySelector('[data-orphan-groups-range]')?.dataset.orphanGroupsRange ?? ''
    return range.endsWith('/${expectedGroups}')
  })()`, 40000).catch(async () => {
    throw new Error(`the sidebar never grouped ${expectedGroups} sources: ${json(await evaluate(`(() => ({
      orphans: document.querySelector('[data-side-chat-orphans]') != null,
      range: document.querySelector('[data-orphan-groups-range]')?.dataset.orphanGroupsRange ?? null,
      keys: [...document.querySelectorAll('[data-orphan-group-key]')].map(node => node.dataset.orphanGroupKey) }))()`))}`)
  })
  await idle()
  const firstPage = await readGroups()
  check(firstPage.page === `1/${Math.ceil(expectedGroups / GROUP_PAGE)}`,
    `the first group page must report where it sits: ${json(firstPage)}`)
  check(firstPage.keys.length <= GROUP_PAGE,
    `one group page must never mount more than ${GROUP_PAGE} groups: ${json(firstPage)}`)
  check(firstPage.rows.every(count => count <= ROW_BATCH),
    `no group may mount more than ${ROW_BATCH} rows: ${json(firstPage)}`)
  check(firstPage.renderedRows <= GROUP_PAGE * ROW_BATCH,
    `the orphan list must stay inside one page of groups and rows: ${json(firstPage)}`)
  await capture('orphan-groups-page-one')
  const seen = [...firstPage.keys]
  const pages = Math.ceil(expectedGroups / GROUP_PAGE)
  for (let page = 2; page <= pages; page += 1) {
    await clickAt(`document.querySelector('[data-orphan-groups-next]')`)
    await wait(`document.querySelector('[data-orphan-groups-page]')?.dataset.orphanGroupsPage === '${page}/${pages}'`, 20000)
    await idle()
    const current = await readGroups()
    check(current.keys.length <= GROUP_PAGE,
      `group page ${page} must stay bounded: ${json(current)}`)
    check(current.rows.every(count => count <= ROW_BATCH),
      `group page ${page} mounted more rows than one page: ${json(current)}`)
    // Replacement, not accumulation: another page cannot repeat a key already on screen.
    check(!current.keys.some(key => seen.includes(key)),
      `group page ${page} repeated a group from an earlier page: ${json({ seen, current })}`)
    check(current.renderedRows <= GROUP_PAGE * ROW_BATCH,
      `group page ${page} grew past the page bounds: ${json(current)}`)
    seen.push(...current.keys)
    if (page === pages) await capture('orphan-groups-page-last')
  }
  // The thirteenth group is really on the last page and every created source is counted.
  check(seen.length === expectedGroups,
    `paging must reach every group without repeats: ${json({ seen, expectedGroups })}`)
  check(parents.every(id => seen.includes(`conversation:${id}`)),
    `every deleted source must own its own group: ${json({ seen, parents })}`)
  check((knownKeys ?? []).every(key => seen.includes(key)),
    `the earlier orphan group must survive paging: ${json({ seen, knownKeys })}`)
  // Walking back is part of paging: page three must return to page two unchanged.
  await clickAt(`document.querySelector('[data-orphan-groups-previous]')`)
  await wait(`document.querySelector('[data-orphan-groups-page]')?.dataset.orphanGroupsPage === '${pages - 1}/${pages}'`, 20000)
  await idle()
  const back = await readGroups()
  check(back.keys.length <= GROUP_PAGE && back.keys.every(key => seen.includes(key)),
    `walking back must show a real earlier page: ${json(back)}`)
  // The children of these sources stay their own records with their own frozen snapshot.
  const childPages = await evaluate(`Promise.all(${json(children)}.map(id => window.scry.conversations.read(id)
    .then(page => ({ id, source: page.sideChat?.source?.kind ?? null, through: page.sideChat?.throughOrdinal ?? null }),
      error => ({ id, error: String(error) }))))`)
  check(childPages.every(page => page.source === 'conversation' && (page.through ?? 0) >= 1),
    `every grouped child must keep its own frozen provenance: ${json(childPages)}`)
  return { extraSources: parents.length, expectedGroups, pages: seen.length,
    firstPage: { page: firstPage.page, groups: firstPage.keys.length, rows: firstPage.renderedRows, keys: firstPage.keys },
    lastPage: { page: back.page, groups: back.keys.length }, children: children.length, deleted: deleted.length }
}
