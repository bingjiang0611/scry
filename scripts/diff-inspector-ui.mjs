import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function selectDiffScope({ click, wait, evaluate }, scope) {
  await click('.diff-scope-trigger')
  await wait(() => evaluate(`Boolean(document.querySelector('.diff-scope-menu'))`), 'compact diff scope menu')
  await click(`[data-diff-choice="${scope}"]`)
  await wait(() => evaluate(`!document.querySelector('.diff-scope-menu')`), 'scope selection closes the menu')
}

async function reloadReferenceOnlyTurn({ click, wait, evaluate, firstRunId, cdp, userDataDir }) {
  // Reproduce legacy reference-only turn patches in the isolated App archive. Reuse the
  // canonical stored body, not today's workspace contents or a fabricated renderer patch.
  const root = join(userDataDir, 'trace-archive-turns-v1')
  let restoredFiles = 0
  for (const name of readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(name => /\/turn-[a-f0-9]{64}\.json$/.test(name))) {
    const path = join(root, name)
    const archive = JSON.parse(readFileSync(path, 'utf8'))
    const turn = archive.turns.find(turn => turn.runId === firstRunId)
    if (!turn) continue
    const retained = turn.turnEvidence.diff.value.flatMap(snapshot => snapshot.files)
    for (const event of turn.items.filter(event => event.stage === 'turn_diff')) {
      for (const file of event.turnDiff.files) {
        const hash = createHash('sha256').update(file.patch).digest('hex')
        const content = retained.find(file => file.patchContent?.contentRef?.sha256 === hash)?.patchContent
        assert.ok(content, 'canonical evidence owns the original turn patch')
        const cwdKey = createHash('sha256').update(archive.cwd).digest('hex')
        assert.equal(readFileSync(join(userDataDir, 'trace-content-v1', cwdKey, 'content', 'sha256', hash.slice(0, 2), `${hash}.bin`), 'utf8'), file.patch)
        file.patchContent = { ...content, content: '', savedBytes: 0 }
        delete file.patch
        restoredFiles++
      }
    }
    writeFileSync(path, JSON.stringify(archive))
  }
  assert.ok(restoredFiles > 0, 'fixture contains a real recorded turn patch')
  await cdp.send('Page.reload')
  await wait(() => evaluate(`Boolean(document.querySelector('[data-pinned-summary-toggle]'))`), 'App renderer restored after archive reload')
  if (!await evaluate(`Boolean(document.querySelector('button.pinned-summary-row'))`)) await click('[data-pinned-summary-toggle]')
  await click('button.pinned-summary-row', 'Changes')
  await wait(() => evaluate(`Boolean(document.querySelector('.diff-scope-trigger'))`), 'Diff reopened from persisted history')
}

export async function exerciseTurnMenu({ click, key, wait, evaluate, screenshot, target, firstRunId, latestRunId, cdp, userDataDir, inputs, evidence }) {
  // Focused history regression; the default suite still runs every first-send/pressure check.
  const historyOnly = process.argv.includes('--diff-history-only')
  const invocations = inputs().length
  if (historyOnly) await reloadReferenceOnlyTurn({ click, wait, evaluate, firstRunId, cdp, userDataDir })
  const actions = { click, wait, evaluate }
  await selectDiffScope(actions, 'latest')
  await wait(() => evaluate(`document.querySelector('.diff-inspector')?.dataset.diffRunId === ${JSON.stringify(latestRunId)}`), 'latest turn is the last actual run')
  await click('.diff-scope-trigger')
  const menu = await evaluate(`(() => { const rect = document.querySelector('.diff-scope-menu').getBoundingClientRect();
    return { width: rect.width, left: rect.left, right: rect.right, viewport: innerWidth,
      oldTabs: Boolean(document.querySelector('.diff-scope-tabs, .diff-turn-picker select')) } })()`)
  assert.ok(menu.width <= 240 && menu.left >= 0 && menu.right <= menu.viewport)
  assert.equal(menu.oldTabs, false)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.diff-scope-menu > button')].map(node => node.dataset.diffChoice)`), ['branch', 'workspace', 'latest', 'turns'])
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.diff-scope-menu > button')].map(node => node.textContent.trim())`), ['Changes', 'Uncommitted', 'Latest turn', 'Turn'])
  await screenshot('diff-scope-menu-dark')
  await key('Escape', 'Escape', 27)
  assert.equal(await evaluate(`document.activeElement?.classList.contains('diff-scope-trigger')`), true)
  await click('.diff-scope-trigger')
  await click('[data-diff-choice="turns"]')
  await wait(() => evaluate(`document.querySelectorAll('.diff-turn-choice').length === 2`), 'both recorded turns are selectable')
  const bounds = await evaluate(`(() => { const rect = document.querySelector('.diff-turn-menu').getBoundingClientRect();
    return { left: rect.left, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight } })()`)
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height)
  await screenshot('diff-turn-menu-dark')

  // Mutate today's file: a historical turn must still show its retained patch, not this content.
  const file = join(target, 'remote-first.txt')
  const original = readFileSync(file, 'utf8')
  const later = 'unrelated later workspace edit\n'
  writeFileSync(file, later)
  try {
    await key('End', 'End', 35)
    await key('Enter', 'Enter', 13)
    await wait(() => evaluate(`document.querySelector('.diff-inspector')?.dataset.diffRunId === ${JSON.stringify(firstRunId)} &&
      document.querySelector('.diff-virtual-files')?.textContent.includes('remote-first.txt')`), 'oldest turn selected with native keyboard')
    assert.equal(await evaluate(`document.querySelector('.diff-virtual-files').textContent.includes('remote-second.txt')`), false)
    const patch = await evaluate(`document.querySelector('.diff-virtual-code').textContent`)
    assert.ok(patch.includes(original.trim()))
    assert.equal(patch.includes(later.trim()), false, 'history never reads current file content as its old patch')
    assert.equal(await evaluate(`document.querySelector('.diff-scope-trigger').textContent.trim()`), '第 1 轮')
    await screenshot('diff-first-turn')
  } finally { writeFileSync(file, original) }
  await selectDiffScope(actions, 'latest')
  await wait(() => evaluate(`document.querySelector('.diff-virtual-files')?.textContent.includes('remote-second.txt')`), 'latest turn restored')
  assert.equal(await evaluate(`document.querySelector('.diff-virtual-files').textContent.includes('remote-first.txt')`), false)
  assert.equal(await evaluate(`document.querySelector('.diff-scope-trigger').textContent.trim()`), 'Latest turn')
  assert.equal(inputs().length, invocations, 'history reload and scope selection never start a Provider')
  if (historyOnly) console.log(JSON.stringify({ test: 'reference-only historical diff after reload', immutableHistory: true, providerInvocations: invocations, evidence }))
  return historyOnly
}
