// Real React/DOM interaction fixture, run in an isolated Electron window by the colocated test.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from '../Sidebar'
import type { ProjectMeta } from '../../env'
import '../../styles.css'

const initial: ProjectMeta[] = [{ cwd: '/fixture', name: 'Fixture', mtime: 1, sessions: [
  { sessionId: 'q1', externalSessionId: 'q1', providerId: 'qoder', preview: '完整的会话标题应该自动换行而不是再次省略，包含实现方案、验证结果以及后续计划。'.repeat(3), mtime: 1, count: 1 },
  { sessionId: 'p1', externalSessionId: 'p1', providerId: 'pi', agentProfileId: 'pi-a', preview: '置顶标题', mtime: 1, count: 1, pinnedAt: 1 }
] }]
let picks = 0
let calls = 0
let fail = true
let release: (() => void) | undefined
let savedIdentity = ''
function Fixture() {
  const [projects, setProjects] = useState(initial)
  return <Sidebar projects={projects} activeCwd="/fixture" onNewChat={() => {}} onPick={() => { picks++ }}
    onTogglePin={() => {}} onArchive={() => {}} onRenameSession={async (cwd, session, title) => {
      calls++
      savedIdentity = `${cwd}:${session.providerId}:${session.agentProfileId ?? ''}:${session.sessionId}`
      if (fail) throw new Error('模拟磁盘写入失败')
      await new Promise<void>((resolve) => { release = resolve })
      setProjects((current) => current.map((p) => ({ ...p, sessions: p.sessions.map((s) =>
        s.sessionId === session.sessionId ? { ...s, preview: title } : s) })))
    }} />
}
const assert = (ok: unknown, message: string): void => { if (!ok) throw new Error(message) }
const wait = async (check: () => boolean, label = check.toString()): Promise<void> => {
  const deadline = performance.now() + 4000
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`UI condition timed out: ${label}`)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
const input = (): HTMLInputElement => document.querySelector('[role="dialog"] input')!
function type(value: string): void {
  const field = input()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}
// A hidden Electron window updates activeElement but does not dispatch native focus events.
const focusRow = (row: HTMLElement): void => {
  row.focus()
  row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
}
const blurRow = (row: HTMLElement): void => {
  row.blur()
  row.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}
const escape = (): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }
async function run(): Promise<void> {
  createRoot(document.getElementById('root')!).render(<Fixture />)
  await wait(() => !!document.querySelector('.sb-sess'))
  const row = document.querySelector<HTMLButtonElement>('.sb-sess[data-provider="qoder"]')!
  // Hover must expose the full label outside the scroll-clipped sidebar, without a native title tooltip.
  assert(!row.hasAttribute('title'), 'native tooltip must not compete with hover card')
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await wait(() => !!document.querySelector('[role="tooltip"]'), 'initial hover')
  const tip = document.querySelector<HTMLElement>('[role="tooltip"]')!
  assert(tip.parentElement === document.body, 'tooltip must escape sidebar overflow')
  assert(tip.textContent!.includes(initial[0].sessions[0].preview), 'full title must remain available')
  assert(tip.textContent!.includes('Fixture') && tip.textContent!.includes('Qoder'), 'compact project and provider metadata')
  assert(!tip.textContent!.includes('/fixture') && !tip.textContent!.includes('最近活动：'), 'omit verbose metadata')
  assert(row.getAttribute('aria-describedby') === tip.id, 'accessible tooltip association')
  const box = tip.getBoundingClientRect()
  assert(box.width <= 340 && box.height < 180, 'long titles remain compact')
  assert(box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, 'tooltip stays in viewport')
  row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: tip }))
  tip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: row }))
  escape()
  await wait(() => !document.querySelector('[role="tooltip"]'))
  focusRow(row)
  await wait(() => !!document.querySelector('[role="tooltip"]'), 'keyboard focus after escape')
  document.querySelector('.sb-list')!.dispatchEvent(new Event('scroll'))
  await wait(() => !document.querySelector('[role="tooltip"]'))
  const pinnedRow = document.querySelector<HTMLButtonElement>('.sb-sess[data-provider="pi"]')!
  focusRow(pinnedRow)
  await wait(() => document.querySelector('[role="tooltip"]')?.textContent?.includes('置顶标题') === true)
  const shortBox = document.querySelector('[role="tooltip"]')!.getBoundingClientRect()
  assert(shortBox.width < 260 && shortBox.height < 90, 'short titles should shrink to content')
  // Repro: keep A focused (or pointer over its card) and hover B without a blur/leave on A.
  // A must disappear immediately, and neither delayed close nor renewed hover may revive it.
  let maxCards = 0
  const observer = new MutationObserver(() => { maxCards = Math.max(maxCards, document.querySelectorAll('[role="tooltip"]').length) })
  observer.observe(document.body, { childList: true, subtree: true })
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await wait(() => !pinnedRow.hasAttribute('aria-describedby'), 'new hover relinquishes focused row')
  await wait(() => document.querySelector('[role="tooltip"]')?.textContent?.includes(initial[0].sessions[0].preview) === true)
  row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: pinnedRow }))
  pinnedRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: row }))
  await wait(() => document.querySelector('[role="tooltip"]')?.textContent?.includes('置顶标题') === true)
  assert(document.querySelectorAll('[role="tooltip"]').length === 1 && maxCards <= 1, 'only one card across focus/hover handoffs')
  observer.disconnect()
  blurRow(pinnedRow)
  await wait(() => !document.querySelector('[role="tooltip"]'))
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await wait(() => !!document.querySelector('[role="tooltip"]'), 'reenter after pinned blur')
  row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
  await wait(() => !document.querySelector('[role="tooltip"]'))
  focusRow(row)
  await wait(() => !!document.querySelector('[role="tooltip"]'), 'focus before context menu')
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }))
  await wait(() => !!document.querySelector('[role="menu"]'))
  assert(!document.querySelector('[role="tooltip"]'), 'context menu dismisses tooltip')
  button('重命名').click()
  await wait(() => document.activeElement === input())
  assert(input().selectionStart === 0 && input().selectionEnd === input().value.length, 'title should be selected')
  assert(picks === 0, 'context menu must not switch conversations')
  type('')
  await wait(() => button('保存').disabled)
  type('新的会话名称')
  await wait(() => !button('保存').disabled)
  button('保存').click()
  await wait(() => !!document.querySelector('[role="alert"]'))
  assert(input().value === '新的会话名称', 'failed save must retain draft')
  assert(document.querySelector('[role="alert"]')?.textContent === '模拟磁盘写入失败', 'show real failure')
  fail = false
  button('保存').click()
  await wait(() => document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled === true)
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  escape()
  assert(!!document.querySelector('[role="dialog"]'), 'pending write should not dismiss')
  assert(calls === 2, 'duplicate submit should not duplicate writes')
  release!()
  await wait(() => !document.querySelector('[role="dialog"]') && row.textContent!.includes('新的会话名称'))
  assert(savedIdentity === '/fixture:qoder::q1', 'rename must retain source identity')
  await wait(() => document.activeElement === row)

  // Pinned sessions use the same menu; keyboard cancel and click cancel never persist.
  button('会话操作：置顶标题').click()
  await wait(() => !!document.querySelector('[role="menu"]'))
  button('重命名').click()
  await wait(() => !!input())
  type('不要保存')
  escape()
  await wait(() => !document.querySelector('[role="dialog"]'))
  assert(calls === 2, 'Escape must not save')
  button('会话操作：置顶标题').click()
  await wait(() => !!document.querySelector('[role="menu"]'))
  button('重命名').click()
  await wait(() => !!input())
  button('取消').click()
  await wait(() => !document.querySelector('[role="dialog"]'))
  assert(calls === 2, 'Cancel must not save')

  button('会话操作：置顶标题').click()
  await wait(() => !!document.querySelector('[role="menu"]'))
  button('重命名').click()
  await wait(() => !!input())
  type('Pi 新标题')
  button('保存').click()
  await wait(() => calls === 3 && document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled === true)
  release!()
  await wait(() => !document.querySelector('[role="dialog"]'))
  assert(savedIdentity === '/fixture:pi:pi-a:p1', 'Pi profile identity must be preserved')
  assert(button('会话操作：Pi 新标题'), 'pinned title updates')
}
void run().then(() => console.log('SCRY_RENAME_TEST_OK')).catch((error) => console.error('SCRY_RENAME_TEST_FAILED', String(error)))
