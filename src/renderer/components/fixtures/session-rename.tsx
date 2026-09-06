// Real React/DOM interaction fixture, run in an isolated Electron window by the colocated test.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from '../Sidebar'
import type { ProjectMeta } from '../../env'

const initial: ProjectMeta[] = [{ cwd: '/fixture', name: 'Fixture', mtime: 1, sessions: [
  { sessionId: 'q1', externalSessionId: 'q1', providerId: 'qoder', preview: '旧标题', mtime: 1, count: 1 },
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
const wait = async (check: () => boolean): Promise<void> => {
  const deadline = performance.now() + 4000
  while (!check()) {
    if (performance.now() > deadline) throw new Error('UI condition timed out')
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
const escape = (): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) }
async function run(): Promise<void> {
  createRoot(document.getElementById('root')!).render(<Fixture />)
  await wait(() => !!document.querySelector('.sb-sess'))
  const row = document.querySelector<HTMLButtonElement>('.sb-sess[data-provider="qoder"]')!
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }))
  await wait(() => !!document.querySelector('[role="menu"]'))
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
