import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHILD_COMPOSER, CHILD_PANEL, MAIN_COMPOSER, json, readJsonLines, sideChatDriver
} from './side-chat-driving.mjs'

/**
 * Side-chat execution acceptance in the isolated production App.
 *
 * Every step is a real pointer click on the shipped surface; the Provider is the packaged
 * fixture adapter, so the run really executes a tool/file action in the temporary
 * workspace and reports its own input receipt. The IPC counters come from the App's own
 * `ipcMain.handle` registration.
 */
export async function exerciseSideChatExecution({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, workspace, rendererFailures = [] }) {
  const {
    driver, capture, click, idle, wait, conversation,
    type, send, showPanel, createChild, selectProvider, waitSettled
  } = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures })

  // A real parent turn first: a side chat needs one completed source turn to freeze.
  await click('button.sb-sess')
  await wait(`document.querySelector('.sb-new') != null`)
  await idle()
  await click('.sb-new')
  await idle()
  await showPanel()
  await send(MAIN_COMPOSER, 'side chat parent turn')
  await wait(`document.querySelector('#main-pane .tool-group-row') != null && document.querySelector('#main-pane .stop') == null`)
  await idle()
  const parentRows = await evaluate(`[...document.querySelectorAll('.sb-sess')].map(row => ({ id: row.dataset.conversationId ?? null, text: row.textContent }))`)
  const parentRowsForPrompt = parentRows.filter(row => row.text.includes('side chat parent turn'))
  check(parentRowsForPrompt.length === 1, `the parent conversation must have exactly one sidebar row: ${json(parentRows)}`)
  const parentRun = readJsonLines(inputsPath).at(-1)
  check(parentRun?.prompt === 'side chat parent turn', `the parent turn never reached the fixture: ${json(parentRun)}`)

  // Step A — the surface sends its first real question and the fixture really runs.
  const childId = await createChild()
  // The child's own frozen source says what this side chat was frozen from. A parent
  // driven as a Provider session freezes a native source, so no conversation id exists.
  const source = await evaluate(`window.scry.conversations.read(${json(childId)}).then(page => page.sideChat?.source ?? null)`)
  const parentConversationId = source?.kind === 'conversation' ? source.conversationId : null
  check(source != null, `the child has no frozen source: ${json(parentRows)}`)
  const firstRender = await evaluate(`(() => {
    const send = document.querySelector('${CHILD_PANEL} .send')
    const surface = document.querySelector('${CHILD_PANEL} .side-chat-surface')
    const composer = surface?.querySelector('.runtime-composer')
    const body = surface?.querySelector('.chat-body')
    const surfaceRect = surface?.getBoundingClientRect()
    const composerRect = composer?.getBoundingClientRect()
    return {
      sendDisabled: send?.disabled ?? null,
      sendTitle: send?.getAttribute('title') ?? null,
      blockedAttribute: surface?.dataset.sideChatSendBlocked ?? null,
      emptyState: surface?.querySelector('[data-status="new-side-chat"]')?.textContent ?? null,
      genericEmpty: surface?.querySelector('[data-status="empty"]')?.textContent ?? null,
      composerBottomGap: surfaceRect && composerRect ? Math.round(surfaceRect.bottom - composerRect.bottom) : null,
      bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : null,
      providerChip: surface?.querySelector('.clibtn')?.textContent?.trim() ?? null,
      providerChipWidth: surface ? Math.round(surface.querySelector('.clibtn')?.getBoundingClientRect().width ?? 0) : null,
      provenanceLines: (() => {
        const line = surface?.querySelector('[data-side-chat-provenance]')
        if (!line) return null
        return Math.round(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight || '16'))
      })(),
      titles: [...document.querySelectorAll('[data-side-chat-panel] .side-chat-surface-title, [data-side-chat-panel] .conversation-title')].map(node => node.textContent)
    }
  })()`)
  check(firstRender.titles.length === 1, `the child shows one title, not a repeated heading: ${json(firstRender.titles)}`)
  check(firstRender.emptyState != null && firstRender.genericEmpty == null,
    `a new side chat must not claim to be an old archived session: ${json(firstRender)}`)
  // An empty draft disables the send button by design; what must not happen is a child
  // that cannot send at all. No block reason is attached, and typing enables it below.
  check(firstRender.blockedAttribute === null && firstRender.sendTitle === '发送',
    `a fresh child must not carry a send block: ${json(firstRender)}`)
  check(firstRender.composerBottomGap !== null && firstRender.composerBottomGap <= 24,
    `the child composer must sit at the column bottom: ${json(firstRender)}`)
  check(firstRender.provenanceLines === 1, `the source line must stay one row: ${json(firstRender)}`)
  check((firstRender.providerChip?.length ?? 0) >= 4, `the Provider chip must stay readable: ${json(firstRender)}`)
  await capture('side-chat-first-render')

  // Every registered Provider is a real send target: the old three-Provider guard refused
  // Qoder/OpenCode here, and that refusal is exactly what this run must never accept again.
  const conversationProviders = ['codex', 'claude', 'qoder', 'opencode', 'pi:0123456789abcdef']
  const receipts = []
  let turns = 0
  /** Type like a user, prove the send is not blocked, then really click it. */
  const sendChildPrompt = async (prompt) => {
    await type(CHILD_COMPOSER, prompt)
    const gate = await evaluate(`(() => ({
      disabled: document.querySelector('${CHILD_PANEL} .send')?.disabled ?? null,
      status: document.querySelector('${CHILD_PANEL} .runtime-composer')?.textContent ?? ''
    }))()`)
    check(!gate.status.includes('跨 Agent 接续'),
      `a registered Provider was refused as unsupported: ${json({ prompt, gate })}`)
    check(gate.disabled === false, `the send stayed disabled for a registered Provider: ${json({ prompt, gate })}`)
    turns += 1
    const before = readJsonLines(inputsPath).length
    await click(`${CHILD_PANEL} .send`)
    // A refused send keeps the draft, so the timeout is reported with the shipped reason
    // instead of a bare state wait.
    await wait(`document.querySelector(${json(CHILD_COMPOSER)})?.value === ''`, 20000).catch(async () => {
      const refusal = await evaluate(`(() => ({
        value: document.querySelector(${json(CHILD_COMPOSER)})?.value ?? null,
        status: document.querySelector('${CHILD_PANEL} .runtime-composer')?.textContent ?? '',
        sendTitle: document.querySelector('${CHILD_PANEL} .send')?.getAttribute('title') ?? null
      }))()`)
      throw new Error(`the send was refused instead of dispatched: ${json({ prompt, refusal, fixtureRuns: readJsonLines(inputsPath).length - before })}`)
    })
    return { page: await waitSettled(childId, turns), runs: readJsonLines(inputsPath).slice(before) }
  }
  /** One real send through the clicked composer, with its own fixture evidence. */
  const sendOnce = async (provider, prompt, options = {}) => {
    const { page, runs } = await sendChildPrompt(prompt)
    const run = runs.at(-1)
    check(run !== undefined, `Provider ${provider} never reached the fixture: ${json({ prompts: readJsonLines(inputsPath).map(entry => entry.prompt).slice(-3) })}`)
    check(run.providerId === provider.split(':')[0], `the child did not run the chosen Provider: ${json(run)}`)
    const last = page.turns.at(-1)
    const delivery = last.delivery
    const nativeTurnId = last.history?.providerTurnId ?? last.archive?.providerTurnId ?? null
    check(delivery.status === 'accepted', `${provider} input was not accepted: ${json(delivery)}`)
    check(nativeTurnId != null, `${provider} produced no native turn id: ${json({ runId: last.runId, status: last.status })}`)
    check(run.sessionId === delivery.nativeSessionId,
      `${provider} ran a different native session than it recorded: ${json({ run: run.sessionId, delivery: delivery.nativeSessionId })}`)
    check(delivery.nativeSessionId !== parentRun.sessionId,
      `${provider} reused the parent native session: ${json({ child: delivery.nativeSessionId, parent: parentRun.sessionId })}`)
    if (options.frozenSource) {
      check(run.historicalContext != null, `the first send to ${provider} lost its frozen source: ${json({ prompt: run.prompt })}`)
      check(run.outgoingPrompt.includes('side chat parent turn'), `the frozen source did not reach ${provider}'s input`)
      check(run.outgoingPrompt.split('side chat parent turn').length === 2, `the frozen source was delivered to ${provider} more than once`)
      check(run.resume == null, `a first send to ${provider} must not resume an unknown session: ${json(run.resume)}`)
    }
    if (options.resumes) {
      check(run.resume === options.resumes, `a later ${provider} send must resume its own child session: ${json({ resume: run.resume, expected: options.resumes })}`)
      check(run.historicalContext == null, `a continued ${provider} send re-sent a frozen source it already had`)
    }
    // The fixture performs a real write inside the temporary workspace; the acceptance
    // reads the file and the recorded tool result instead of trusting the reply text.
    const wrote = /^side chat write (\S+)$/.exec(run.prompt)
    const toolEvidence = wrote ? (() => {
      const file = `side-chat-${wrote[1]}.txt`
      const body = readFileSync(join(workspace, file), 'utf8')
      const item = (last.history?.items ?? []).find(candidate => candidate.kind === 'tool' && candidate.filePath === file)
      check(body.startsWith(`${run.providerId} ${run.runId} `), `${provider} did not really write its file: ${json({ file, body: body.slice(0, 80) })}`)
      check(item != null, `${provider} recorded no tool result for the file it wrote: ${json({ file, prompt: run.prompt })}`)
      return { file, tool: item.tool, fileOp: item.fileOp ?? null, bytes: body.length }
    })() : null
    receipts.push({ provider, runId: run.runId, sessionId: run.sessionId, resume: run.resume,
      contextHash: run.historicalContext?.contentHash ?? null, delivery: delivery.status,
      nativeSessionId: delivery.nativeSessionId, nativeTurnId, outcome: delivery.outcome ?? null,
      status: last.status ?? null, prompt, toolEvidence })
  }

  // The parent must stay exactly as it was while five Providers run inside its children.
  const parentFixtureRunsBefore = readJsonLines(inputsPath).filter(run => run.prompt === 'side chat parent turn').length
  const parentBodyBefore = await evaluate(`document.querySelector('#main-pane .chat-body')?.textContent ?? null`)
  for (const provider of conversationProviders) {
    await selectProvider(provider)
    await sendOnce(provider, `side chat write ${provider.split(':')[0]}1`, { frozenSource: true })
    // The second send proves the child continues the native session it just created.
    await sendOnce(provider, `side chat write ${provider.split(':')[0]}2`, { resumes: receipts.at(-1).sessionId })
  }
  const providerSessions = new Set(receipts.map(receipt => receipt.sessionId))
  check(providerSessions.size === conversationProviders.length,
    `each Provider owns its own native child session: ${json([...providerSessions])}`)
  check(receipts.length === conversationProviders.length * 2, `every Provider must send twice: ${json(receipts.map(receipt => receipt.provider))}`)
  const parentBodyAfter = await evaluate(`document.querySelector('#main-pane .chat-body')?.textContent ?? null`)
  check(parentBodyAfter === parentBodyBefore, 'the child sends changed the parent transcript')
  check(readJsonLines(inputsPath).filter(run => run.prompt === 'side chat parent turn').length === parentFixtureRunsBefore,
    'a child send dispatched another parent run')
  // The child's own file evidence is its own: the file its last run wrote is rendered in
  // the child body, never in the parent transcript, and the child composer offers no
  // workspace or reference control it could use to borrow the parent's.
  const isolation = await evaluate(`(() => {
    const child = document.querySelector('${CHILD_PANEL}')
    const file = ${json(receipts.at(-1)?.toolEvidence?.file ?? '')}
    const childText = child?.querySelector('.chat-body')?.textContent ?? ''
    const mainText = document.querySelector('#main-pane .chat-body')?.textContent ?? ''
    return { file, childShowsOwnFile: file !== '' && childText.includes(file),
      parentShowsChildFile: file !== '' && mainText.includes(file),
      childWorkspacePicker: child?.querySelector('.runtime-composer .location-picker, .runtime-composer [aria-label*="工作区"]') != null,
      childTool: ${json(receipts.at(-1)?.toolEvidence?.tool ?? null)} }
  })()`)
  check(isolation.childTool != null && isolation.childShowsOwnFile,
    `the child's own file evidence is missing from its own body: ${json(isolation)}`)
  check(isolation.parentShowsChildFile === false,
    `the child's file evidence leaked into the parent transcript: ${json(isolation)}`)
  check(isolation.childWorkspacePicker === false,
    `the child composer offered a workspace control of its own: ${json(isolation)}`)
  await capture('side-chat-child-isolation')
  await capture('side-chat-five-provider-sends')

  const afterAll = await conversation(childId)
  check(afterAll.summary.title.startsWith('side chat write codex1'),
    `the child title must follow the first question: ${json(afterAll.summary.title)}`)
  check(afterAll.summary.title.length <= 120, 'the derived title must be truncated')
  const frozen = afterAll.sideChat ?? afterAll.summary.sideChat ?? null
  check(frozen?.source?.kind === 'native-session' && frozen.source.cwd === workspace,
    `the child must record the source it froze: ${json(frozen?.source ?? null)}`)
  check(frozen.source.nativeSessionId === parentRun.sessionId,
    `the frozen source must name the parent native session: ${json({ source: frozen.source, parent: parentRun.sessionId })}`)
  check(frozen.throughOrdinal >= 1 && frozen.throughRunId === parentRun.runId,
    `the frozen source must point at the parent turn it captured: ${json(frozen)}`)
  await capture('side-chat-child-turns')

  return {
    childId,
    parentConversationId, source,
    frozenSource: { kind: frozen.source.kind, throughOrdinal: frozen.throughOrdinal, throughRunId: frozen.throughRunId, messageCount: frozen.messageCount, prefixFingerprint: frozen.prefixFingerprint },
    firstRender,
    receipts,
    providerSessions: [...providerSessions],
    title: afterAll.summary.title,
    childTurns: afterAll.turns.length,
    parentNativeSession: parentRun.sessionId,
    isolation,
    workspaceEvidence: readJsonLines(callsPath).filter(call => call.operation === 'run').length,
    workspace,
    captures: driver.captures
  }
}

export async function verifySideChatRestart({ cdp, evaluate, check, documentEpoch, childId,
  ipcCountsPath, inputsPath, callsPath, expectedComposerValue = '' }) {
  const { capture, click, clickAt, idle, wait } = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, label: 'Side-chat restart' })
  await wait(`performance.timeOrigin !== ${json(documentEpoch)} && Boolean(window.scry?.conversations && document.querySelector('.sidebar'))`)
  await wait(`document.querySelectorAll('.sb-sess').length > 0`)
  await idle()
  const rows = await evaluate(`[...document.querySelectorAll('.sb-sess')].map(row => ({ text: row.textContent, active: row.classList.contains('active') }))`)
  check(rows.length >= 2, `the restart must still list the parent and its child: ${json(rows)}`)
  // Reopening the source conversation is what a user does after a restart; the child tab
  // and its own record must come back without replaying a send.
  const parentIndex = rows.findIndex(row => row.text.includes('side chat parent turn'))
  check(parentIndex >= 0, `the restarted sidebar lost the parent conversation: ${json(rows)}`)
  check(rows[parentIndex].text.includes('侧聊'), `the parent row must still count its side chat: ${json(rows[parentIndex])}`)
  await clickAt(`[...document.querySelectorAll('.sb-sess')][${parentIndex}]`)
  await wait(`[...document.querySelectorAll('.sb-sess')][${parentIndex}].classList.contains('active') === true`)
  await idle()
  if (await evaluate(`document.querySelector('.panel-pill:not(.summary-pill)').getAttribute('aria-pressed') !== 'true'`)) {
    await clickAt(`document.querySelector('.panel-pill:not(.summary-pill)')`)
  }
  await wait(`document.querySelector('#right-surface-pane [data-session-surface-current="true"]') != null`)
  await idle()
  const restoredFirst = await evaluate(`(() => {
    const pane = document.querySelector('#right-surface-pane')
    const surface = pane.querySelector('[data-session-surface-current="true"]')
    return { tabs: [...pane.querySelectorAll('[data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId),
      autoSelectedChild: surface.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId ?? null }
  })()`)
  check(restoredFirst.tabs.includes(childId), `the restarted workbench must restore the child tab: ${json(restoredFirst)}`)
  if (restoredFirst.autoSelectedChild !== childId) {
    // The tab strip is the way back in: clicking the restored tab must show that child.
    await click(`[data-side-chat-tab-id="${childId}"] [role="tab"]`)
    await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId === ${json(childId)}`)
    await idle()
  }
  const restored = await evaluate(`(() => {
    const pane = document.querySelector('#right-surface-pane')
    const surface = pane.querySelector('[data-session-surface-current="true"]')
    return {
      panelPressed: document.querySelector('.panel-pill:not(.summary-pill)')?.getAttribute('aria-pressed') ?? null,
      tabs: [...pane.querySelectorAll('[data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId),
      selectedTab: surface.querySelector('[data-side-chat-tab-id][aria-selected="true"]')?.dataset.sideChatTabId ?? null,
      childId: surface.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId ?? null,
      composerValue: surface.querySelector('.runtime-composer textarea')?.value ?? null,
      sendTitle: surface.querySelector('.send')?.getAttribute('title') ?? null
    }
  })()`)
  await capture('side-chat-restored')
  check(restored.tabs.includes(childId), `the restarted workbench must restore the child tab: ${json(restored)}`)
  check(restored.childId === childId, `the restored tab must show the same child: ${json(restored)}`)
  // The composer comes back exactly as the durable draft left it: never a replayed send
  // target, and never a silently emptied draft.
  check(restored.composerValue === expectedComposerValue,
    `a restored child must show exactly its durable draft: ${json({ restored, expectedComposerValue })}`)
  const page = await evaluate(`window.scry.conversations.read(${json(childId)})`)
  return { ...restored, turns: page.turns.length, revision: page.summary.revision, activeRunId: page.summary.activeRunId ?? null }
}
