/**
 * What a failed side-chat create leaves behind, against the mounted production hook.
 *
 * Serialized into the fixture's main process by `side-chat-workspace-races-smoke.mjs`, so it
 * may only use the driver helpers it is handed. A refusal must settle its command instead
 * of stranding the parent on an endless read-only check, and only an unreadable lookup may
 * keep a command for a later check.
 */
export async function exerciseCreateSettlement({ read, wait, must, click, state, pending, requests, switchTo, answer,
  settleList, preview, summary, evidence }) {
  // 6. A create the host refused while another parent was on screen: nothing was created,
  //    so the refusal writes no notice into the visible parent and leaves no command that
  //    would turn the original parent's next click into an endless read-only check.
  await switchTo('scope-A', ['tab-A'])
  await settleList(['tab-A'], ['tab-A'])
  await click('[data-races-create]')
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'preview')`, 'refused-create preview')
  await answer('preview', preview('scope-A'))
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'create')`, 'refused create')
  await switchTo('scope-B', ['tab-B'])
  await answer('create', JSON.stringify('来源快照范围已变化，请重新预览；本次未创建侧聊'), { failed: true })
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'find')`, 'receipt lookup')
  await answer('find', "({ commandId: 'fixture', status: 'not-found' })")
  await settleList(['tab-B'], ['tab-B'])
  const afterRefusedCreate = await state()
  must(afterRefusedCreate.notice === '' && afterRefusedCreate.tabs === 'tab-B',
    `a refused create wrote its notice into another parent: ${JSON.stringify(afterRefusedCreate)}`)
  must(await read(`JSON.parse(localStorage.getItem('scry.side-chat-create-commands.v1') ?? '[]').length === 0`),
    'a conclusively refused create left its command in the durable ledger')
  await switchTo('scope-A', ['tab-A'])
  await settleList(['tab-A'], ['tab-A'])
  await click('[data-races-create]')
  // No dead command stands in the way: the click is an ordinary create and starts with a
  // fresh preview, not with a lookup of the refused command.
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'preview')`, 'fresh preview after a refusal')
  must(!(await pending()).some((entry) => entry.kind === 'find'), 'a settled refusal was checked again instead of creating')
  await answer('preview', preview('scope-A'))
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'create')`, 'create after a refusal')
  // The host's own reason reaches the parent that asked.
  await answer('create', JSON.stringify('来源快照范围已变化，请重新预览；本次未创建侧聊'), { failed: true })
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'find')`, 'receipt lookup in the asking parent')
  await answer('find', "({ commandId: 'fixture', status: 'not-found' })")
  await wait(`document.querySelector('[data-races-notice]').textContent.includes('来源快照范围已变化')`, 'refusal reason')
  evidence.refusedCreate = { noticeInOther: afterRefusedCreate.notice, noticeInOwn: (await state()).notice }

  // 7. Only an unreadable lookup keeps the command. The next click checks it read-only
  //    first; once the host answers that nothing was created, that same click carries on
  //    as one new create instead of stranding the parent on a dead command.
  await click('[data-races-create]')
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'preview')`, 'unreadable-lookup preview')
  await answer('preview', preview('scope-A'))
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'create')`, 'lost-reply create')
  await answer('create', JSON.stringify('send reply lost'), { failed: true })
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'find')`, 'unreadable receipt lookup')
  await answer('find', JSON.stringify('ipc down'), { failed: true })
  await wait(`document.querySelector('[data-races-notice]').textContent.includes('暂时读不到')`, 'unknown notice')
  must(await read(`JSON.parse(localStorage.getItem('scry.side-chat-create-commands.v1') ?? '[]').length === 1`),
    'an unreadable lookup discarded the durable command')
  const createsBefore = (await requests()).filter((entry) => entry.kind === 'create').length
  await click('[data-races-create]')
  // The durable command turns the click into a read-only check first: a preview before the
  // lookup answered would mean a second creation was starting blind.
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'find')`, 'read-only receipt check')
  must(!(await pending()).some((entry) => entry.kind === 'preview'), 'checking an unknown command restarted a create before the answer')
  must((await requests()).filter((entry) => entry.kind === 'create').length === createsBefore,
    'checking an unknown command replayed the create')
  await answer('find', "({ commandId: 'fixture', status: 'not-found' })")
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'preview')`, 'create continues after a conclusive not-found')
  must(await read(`JSON.parse(localStorage.getItem('scry.side-chat-create-commands.v1') ?? '[]').length === 0`),
    'a command the host conclusively did not create stayed in the ledger')
  await answer('preview', preview('scope-A'))
  await wait(`window.__scryRaces.pending.some(entry => entry.kind === 'create')`, 'create after the check')
  await answer('create', summary('child-after-check'))
  await wait(`document.querySelector('[data-races-created]').textContent === 'child-after-check'`, 'child opened after the check')
  const createsAfter = (await requests()).filter((entry) => entry.kind === 'create').length
  must(createsAfter === createsBefore + 1,
    `one click after a settled command must dispatch exactly one create: ${JSON.stringify({ createsBefore, createsAfter })}`)
  const sources = (await requests()).filter((entry) => entry.kind === 'create').map((entry) => JSON.parse(entry.source))
  must(sources.every((source) => source.nativeSessionId === 'native-A' && source.providerId === 'codex'),
    `every create must keep its own parent's exact source tuple: ${JSON.stringify(sources)}`)
  evidence.unknownReceipt = { createsBefore, createsAfter, created: (await state()).created, sources }
}
