import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

// A session whose worktree was removed still opens its native history read-only; the
// composer keeps the draft and blocks sending until the directory exists again.
export async function exerciseMissingWorkspaceHistory({ evaluate, cdp, wait, segmentDir, nativePath, nativeSessionId, canonicalWorkspace, context }) {
  // Return to a native-only fixture and delete its worktree, not its transcript.
  rmSync(segmentDir, { recursive: true })
  writeFileSync(nativePath, [
    { type: 'session', version: 3, id: nativeSessionId, cwd: canonicalWorkspace },
    { type: 'message', id: 'missing-user', parentId: null, timestamp: '2026-10-13T06:00:00Z', message: { role: 'user', content: 'missing worktree native prompt' } },
    { type: 'message', id: 'missing-reply', parentId: 'missing-user', timestamp: '2026-10-13T06:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'missing worktree native reply' }] } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  rmSync(canonicalWorkspace, { recursive: true })
  const missingPage = await evaluate(`window.scry.loadSession(${JSON.stringify(context)}, { limit: 1 })`)
  assert.equal(missingPage.workspaceMissing, true)
  assert.ok(missingPage.turns[0].items.some(item => item.text === 'missing worktree native reply'))
  const reopenFromSidebar = () => evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('手机会话恢复测试')).click()`)
  await reopenFromSidebar()
  await wait(`document.body.textContent.includes('missing worktree native reply') && document.body.textContent.includes('原工作目录已不存在')`)
  await evaluate(`document.querySelector('textarea').focus()`)
  await cdp.send('Input.insertText', { text: 'draft in missing worktree' })
  await wait(`document.querySelector('textarea')?.value === 'draft in missing worktree'`)
  const readOnly = await evaluate(`({
    sendDisabled: document.querySelector('button.send')?.disabled,
    workspacePanel: !!document.querySelector('button[aria-label="右侧工作区"]')
  })`)
  assert.deepEqual(readOnly, { sendDisabled: true, workspacePanel: false })
  mkdirSync(canonicalWorkspace)
  await reopenFromSidebar()
  await wait(`!document.body.textContent.includes('原工作目录已不存在') && !!document.querySelector('button[aria-label="右侧工作区"]')`)
}
