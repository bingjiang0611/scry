import { CHILD_COMPOSER, CHILD_PANEL, SIDE_CHAT_SURFACE, json, sideChatDriver } from './side-chat-driving.mjs'
import { createWindowResize } from './side-chat-window-control.mjs'

/**
 * Side-chat layout, keyboard and composition acceptance in the isolated production App.
 *
 * The window is really resized through the isolated main process, the color scheme is
 * really switched, and keys and IME composition are real Chromium input events, so a pass
 * here means the shipped surface stays usable in the narrow, short, light and dark layouts
 * instead of only at one size.
 */
export async function exerciseSideChatLayout({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, childId, windowControlPath, rendererFailures = [] }) {
  const {
    driver, capture, click, clearDraft, keyStroke, idle, wait, conversation, inputs
  } = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat layout' })
  // A real window resize, not an emulated viewport: see side-chat-window-control.mjs.
  const { resize, applied: windowSizes } = createWindowResize({ wait, idle, check, windowControlPath, json })
  /**
   * Show the workbench itself. `showChild` returns early when the child surface is still
   * mounted from a hidden panel, so the narrow sections reveal the panel explicitly.
   */
  const revealPanel = async () => {
    if (await evaluate(`document.querySelector('.app.right-panel-hidden') == null`)) return
    await click('.panel-pill:not(.summary-pill)')
    await wait(`document.querySelector('.app.right-panel-hidden') == null`)
    await idle()
    await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId === ${json(childId)}`)
  }
  const showChild = async () => {
    const current = await evaluate(`document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId ?? null`)
    if (current === childId) return
    if (await evaluate(`document.querySelector('.panel-pill:not(.summary-pill)').getAttribute('aria-pressed') !== 'true'`)) {
      await click('.panel-pill:not(.summary-pill)')
    }
    if (await evaluate(`document.querySelector('#right-surface-pane [data-session-surface-current="true"]') == null`)) return
    const tab = `[data-side-chat-tab-id="${childId}"] [role="tab"]`
    if (await evaluate(`document.querySelector('${tab}') != null`)) await click(tab)
    await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId === ${json(childId)}`, 20000)
    await idle()
  }

  // Measurements the panel and the chip must keep at every supported width.
  const panelFacts = () => evaluate(`(() => {
    const surface = document.querySelector('${CHILD_PANEL} .side-chat-surface')
    const composer = document.querySelector('${CHILD_PANEL} .runtime-composer')
    const chip = document.querySelector('${CHILD_PANEL} .runtime-composer .clibtn')
    const surfaceRect = surface.getBoundingClientRect()
    const composerRect = composer.getBoundingClientRect()
    const provenance = surface.querySelector('[data-side-chat-provenance]')
    return {
      surfaceWidth: Math.round(surfaceRect.width), surfaceVisible: surface.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      chipWidth: Math.round(chip.getBoundingClientRect().width), chipText: chip.textContent.trim(),
      sendWidth: Math.round(document.querySelector('${CHILD_PANEL} .runtime-composer .send').getBoundingClientRect().width),
      composerInside: composerRect.x >= 0 && composerRect.right <= window.innerWidth && composerRect.y >= 0 && composerRect.bottom <= window.innerHeight,
      composerDescribed: Math.round(composerRect.height),
      bottomGap: Math.round(surfaceRect.bottom - composerRect.bottom),

      surfaceOverflow: Math.round(surface.scrollWidth - surface.clientWidth),
      provenanceRows: provenance ? Math.round(provenance.getBoundingClientRect().height / parseFloat(getComputedStyle(provenance).lineHeight || '16')) : null,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      narrow: document.querySelector('.app-shell.narrow-single-column') != null,
      pane: document.querySelector('.app-shell')?.dataset.narrowPane ?? null,
      panelWidth: Math.round(document.querySelector('#right-surface-pane')?.getBoundingClientRect().width ?? 0),
      mainDisplay: getComputedStyle(document.querySelector('#main-pane')).display,
      slotDisplay: getComputedStyle(document.querySelector('#right-surface-pane')).display,
      resizerPresent: document.querySelector('.panel-resizer[aria-controls="right-surface-pane"]') != null,
      grid: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
      slotColumn: getComputedStyle(document.querySelector('#right-surface-pane')).gridColumn,
      sidebarWidth: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)
    }
  })()`)

  // 1. A wide real window keeps both panes side by side; the panel then shrinks to its
  //    own minimum with the resizer's keyboard control.
  await resize(1400, 900)
  await showChild()
  const wide = await panelFacts()
  check(wide.narrow === false, `a 1400px window must keep both panes side by side: ${json(wide)}`)
  check(wide.pane === null, `a wide window must not claim the narrow single column: ${json(wide)}`)
  check(wide.mainDisplay !== 'none' && wide.slotDisplay !== 'none',
    `a wide window must show the conversation and the workbench: ${json(wide)}`)
  check(wide.resizerPresent, `a wide window must keep the panel resizer: ${json(wide)}`)
  await capture('layout-wide-window')
  const resizer = `.panel-resizer[aria-controls="right-surface-pane"]`
  if (await evaluate(`document.querySelector('${resizer}') != null`)) {
    await evaluate(`document.querySelector('${resizer}').focus()`)
    // The resizer sits left of the panel: shrinking it means moving the splitter right.
    for (let step = 0; step < 40; step += 1) {
      const width = await evaluate(`document.querySelector('#right-surface-pane').getBoundingClientRect().width`)
      if (width <= 400) break
      await keyStroke({ key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
      await idle()
    }
  }
  const narrowPanel = await panelFacts()
  check(narrowPanel.panelWidth <= 430, `the resizer did not reach the panel minimum: ${json(narrowPanel)}`)
  check(narrowPanel.chipWidth >= 120 && narrowPanel.chipText.includes('codex'),
    `the Provider chip must stay readable at the panel minimum: ${json(narrowPanel)}`)
  check(narrowPanel.sendWidth >= 28, `the send control became unusable at the panel minimum: ${json(narrowPanel)}`)
  check(narrowPanel.composerInside, `the composer left the viewport at the panel minimum: ${json(narrowPanel)}`)
  check(narrowPanel.surfaceOverflow <= 1, `the child surface scrolls sideways at the panel minimum: ${json(narrowPanel)}`)
  check(narrowPanel.bottomGap <= 24, `the composer must stay at the column bottom at the panel minimum: ${json(narrowPanel)}`)
  check(narrowPanel.provenanceRows !== null && narrowPanel.provenanceRows <= 2,
    `the source line must stay compact at the panel minimum: ${json(narrowPanel)}`)
  await capture('layout-narrow-panel')

  // 2. The measured breakpoint itself, in a real window: the shell keeps one column when
  //    the chat would no longer fit beside the workbench (880px chat + sidebar + resizer).
  await resize(1100, 900)
  await showChild()
  const narrowSide = await panelFacts()
  check(narrowSide.narrow === true, `a 1100px window must use the measured single column: ${json(narrowSide)}`)
  check(narrowSide.pane === 'panel', `the shown narrow pane must be the workbench here: ${json(narrowSide)}`)
  check(narrowSide.mainDisplay === 'none', `the narrow single column must not keep the hidden pane laid out: ${json(narrowSide)}`)
  // The panel fills the one column instead of floating as the old fixed-width overlay.
  const narrowColumn = 1100 - narrowSide.sidebarWidth - 6
  check(Math.abs(narrowSide.panelWidth - narrowColumn) <= 2,
    `the narrow workbench must fill the column ${narrowColumn}px: ${json(narrowSide)}`)
  check(narrowSide.pageOverflow <= 0, `the narrow window scrolls sideways: ${json(narrowSide)}`)
  check(narrowSide.composerInside && narrowSide.surfaceOverflow <= 1,
    `the child composer must stay usable in the narrow window: ${json(narrowSide)}`)
  await capture('layout-narrow-window')
  // The panel keeps its own hide control, so the conversation is always reachable again.
  // Several workbenches stay mounted for merged sessions, so the control is addressed
  // inside the current surface instead of by a document-wide attribute match.
  const hideControl = `${SIDE_CHAT_SURFACE} [aria-label="隐藏右侧工作区"]`
  const hideMatches = await evaluate(`document.querySelectorAll(${json(hideControl)}).length`)
  check(hideMatches === 1, `the narrow workbench must offer exactly one hide control: ${hideMatches}`)
  await click(hideControl)
  await wait(`document.querySelector('.app-shell')?.dataset.narrowPane === 'main'`)
  await idle()
  const backToConversation = await evaluate(`(() => ({
    pane: document.querySelector('.app-shell')?.dataset.narrowPane ?? null,
    mainDisplay: getComputedStyle(document.querySelector('#main-pane')).display,
    slotDisplay: getComputedStyle(document.querySelector('#right-surface-pane')).display
  }))()`)
  check(backToConversation.mainDisplay !== 'none' && backToConversation.slotDisplay === 'none',
    `the narrow layout must return to the conversation: ${json(backToConversation)}`)
  await capture('layout-narrow-conversation')

  // 3. The minimum window, and a low window with the same workbench open. The workbench's
  // own controls only exist while it is open, so the window is measured revealed.
  await resize(860, 720)
  await revealPanel()
  const workbench = await evaluate(`(() => ({
    tabs: [...document.querySelectorAll('#right-surface-pane [data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId),
    surface: document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId ?? null
  }))()`)
  // A tab that vanished because a lookup answered for another scope is a finding here.
  check(workbench.surface === childId, `the workbench lost the child it was showing: ${json({ workbench, childId })}`)
  const minimumWindow = await panelFacts()
  check(minimumWindow.narrow === true, `the minimum window must stay single column: ${json(minimumWindow)}`)
  check(minimumWindow.pageOverflow <= 0, `the minimum window scrolls sideways: ${json(minimumWindow)}`)
  check(minimumWindow.sidebarWidth >= 150, `the minimum window collapsed the sidebar away: ${json(minimumWindow)}`)
  const minimumPanel = await panelFacts()
  check(minimumPanel.composerInside && minimumPanel.surfaceOverflow <= 1 && minimumPanel.chipWidth >= 100,
    `the workbench must stay usable at the minimum window: ${json(minimumPanel)}`)
  await capture('layout-minimum-window')
  await resize(1200, 600)
  await revealPanel()
  const lowWindow = await panelFacts()
  check(lowWindow.composerInside, `the composer left a 600px-high window: ${json(lowWindow)}`)
  check(lowWindow.bottomGap <= 24, `the composer must stay at the column bottom at 600px height: ${json(lowWindow)}`)
  check(lowWindow.surfaceOverflow <= 1, `the child surface scrolls sideways at 600px height: ${json(lowWindow)}`)
  const chatBodyHeight = await evaluate(`Math.round(document.querySelector('${CHILD_PANEL} .chat-body').getBoundingClientRect().height)`)
  check(chatBodyHeight >= 80, `a 600px-high window left no readable transcript space: ${chatBodyHeight}`)
  // The six shipped tool surfaces are still offered next to the side-chat entries.
  await click(`${SIDE_CHAT_SURFACE} [aria-label="添加 Surface"]`)
  await wait(`document.querySelector('${SIDE_CHAT_SURFACE} .surface-menu [role="menuitem"]') != null`)
  const tools = await evaluate(`(() => {
    const menu = document.querySelector('${SIDE_CHAT_SURFACE} .surface-menu')
    const rect = menu.getBoundingClientRect()
    return { items: [...menu.querySelectorAll('[role="menuitem"]')].map(node => node.textContent.trim()),
      inside: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
      height: Math.round(rect.height) }
  })()`)
  check(tools.items.length >= 8, `the low window lost one of the six tool surfaces: ${json(tools)}`)
  check(tools.inside, `the Surface menu was clipped by the low window: ${json(tools)}`)
  await capture('layout-low-window')
  await keyStroke({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await idle()

  // 4. Light and dark really render, and the child surface keeps readable contrast.
  const surfaceColors = async () => evaluate(`(() => {
    const surface = document.querySelector('${CHILD_PANEL} .side-chat-surface')
    const text = surface.querySelector('.chat-body, .side-chat-surface-empty') ?? surface
    const lum = (value) => {
      const [r, g, b] = value.replace(/[^0-9.,]/g, '').split(',').slice(0, 3).map(Number).map((channel) => {
        const c = channel / 255
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const background = getComputedStyle(document.body).backgroundColor
    const surfaceBackground = getComputedStyle(surface).backgroundColor
    const color = getComputedStyle(text).color
    const surfaceLum = lum(surfaceBackground === 'rgba(0, 0, 0, 0)' ? background : surfaceBackground)
    const textLum = lum(color)
    const ratio = (Math.max(surfaceLum, textLum) + 0.05) / (Math.min(surfaceLum, textLum) + 0.05)
    return { background, surfaceBackground, color, ratio: Math.round(ratio * 100) / 100,
      dark: matchMedia('(prefers-color-scheme: dark)').matches }
  })()`)
  // The App's theme is its own setting (`scry.theme` -> `data-theme`), read at boot, so
  // each scheme is applied by the real reload path instead of an emulated media feature.
  const schemes = {}
  for (const theme of ['light', 'dark']) {
    await evaluate(`localStorage.setItem('scry.theme', ${json(theme)})`)
    await cdp.send('Page.reload', {})
    // The reload briefly leaves no document, so the probe must tolerate a missing root.
    await wait(`document.documentElement?.dataset?.theme === ${json(theme)} && document.querySelector('.sidebar') != null`, 30000)
    await idle()
    await showChild()
    schemes[theme] = await surfaceColors()
    await capture(`layout-scheme-${theme}`)
  }
  check(schemes.light.dark === false && schemes.dark.dark === true,
    `the rendered color scheme does not follow the App theme: ${json(schemes)}`)
  check(schemes.light.background !== schemes.dark.background,
    `light and dark render the same background: ${json(schemes)}`)
  for (const theme of ['light', 'dark']) {
    check(schemes[theme].ratio >= 4.5, `the child text is not readable in ${theme}: ${json(schemes[theme])}`)
  }

  // 5. Keyboard: the tab strip is reachable and closable without a pointer.
  await showChild()
  const tabSelector = `[data-side-chat-tab-id="${childId}"] [role="tab"]`
  await click(tabSelector)
  const focusTab = async () => evaluate(`document.activeElement?.getAttribute('role') ?? null`)
  await evaluate(`document.querySelector('${tabSelector}').focus()`)
  check(await focusTab() === 'tab', 'the child tab cannot take focus')
  const tabKeys = []
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    await keyStroke({ key, code: key, windowsVirtualKeyCode: key === 'Home' ? 36 : key === 'End' ? 35 : key === 'ArrowRight' ? 39 : 37 })
    await idle()
    tabKeys.push({ key, focus: await evaluate(`document.activeElement?.textContent ?? null`),
      selected: await evaluate(`[...document.querySelectorAll('#right-surface-pane [data-side-chat-tab-id]')]
        .filter(node => node.querySelector('[aria-selected="true"]')).length`) })
  }
  check(tabKeys.every(entry => entry.selected === 1), `the tab strip lost its single selection while using the keyboard: ${json(tabKeys)}`)
  check(tabKeys.every(entry => entry.focus != null), `a tab key left the focus on nothing: ${json(tabKeys)}`)

  // 6. Real IME composition must not send, and committing it must not lose the text.
  await click(CHILD_COMPOSER)
  const beforeComposition = inputs().length
  const turnsBefore = (await conversation(childId)).turns.length
  await cdp.send('Input.imeSetComposition', { text: '侧边会话', selectionStart: 4, selectionEnd: 4 })
  await new Promise(resolve => setTimeout(resolve, 200))
  await keyStroke({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise(resolve => setTimeout(resolve, 400))
  const composing = await evaluate(`(() => ({ value: document.querySelector('${CHILD_COMPOSER}')?.value ?? null,
    composing: document.querySelector('${CHILD_COMPOSER}')?.matches(':focus') ?? false }))()`)
  check(composing.value === '侧边会话', `an IME composition was not kept in the composer: ${json(composing)}`)
  const imeDispatched = inputs().length !== beforeComposition
  check(!imeDispatched, 'Enter during IME composition dispatched a Provider run')
  check((await conversation(childId)).turns.length === turnsBefore, 'Enter during IME composition created a turn')
  await cdp.send('Input.insertText', { text: '侧边会话' })
  await wait(`document.querySelector('${CHILD_COMPOSER}')?.value === '侧边会话'`)
  await clearDraft(CHILD_COMPOSER)
  await capture('layout-ime')

  // 7. Snapshot and Provider text is untrusted: it renders as text, never as markup.
  await click(CHILD_COMPOSER)
  await cdp.send('Input.insertText', { text: 'side chat reply <img src=x onerror=alert(1)>' })
  await wait(`document.querySelector('${CHILD_COMPOSER}')?.value.includes('img src') === true`)
  const turnsBeforeInjection = (await conversation(childId)).turns.length
  await click(`${CHILD_PANEL} .send`)
  await wait(`window.scry.conversations.read(${json(childId)}).then(page => page.turns.length === ${turnsBeforeInjection + 1}
    && page.turns.at(-1)?.delivery.outcome === 'completed')`, 40000)
  // The child transcript is windowed, so the newest turn is reached by a real scroll.
  const bodyPoint = await driver.pointerAt(`document.querySelector('${CHILD_PANEL} .chat-body')`)
  for (let wheel = 0; wheel < 8; wheel += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...bodyPoint, deltaX: 0, deltaY: 1200 })
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  await wait(`document.querySelector('${CHILD_PANEL} .chat-body')?.textContent.includes('onerror=alert(1)') === true`, 15000)
    .catch(() => undefined)
  const injected = await evaluate(`(() => {
    const body = document.querySelector('${CHILD_PANEL} .chat-body')
    const text = body.textContent ?? ''
    const start = text.indexOf('side chat reply')
    return { img: body.querySelectorAll('img').length, script: body.querySelectorAll('script').length,
      text: text.includes('<img src=x onerror=alert(1)>'), context: start < 0 ? text.slice(-200) : text.slice(start, start + 160) }
  })()`)
  check(injected.img === 0 && injected.script === 0, `Provider text was rendered as markup: ${json(injected)}`)
  check(injected.text, `Provider text was not shown verbatim: ${json(injected)}`)
  await capture('layout-untrusted-text')

  await resize(1400, 900)
  await showChild()
  return {
    wide, minimumWindow, minimumPanel, lowWindow,
    narrowWindow: { ...narrowSide, column: narrowColumn, backToConversation },
    surfaces: tools, chatBodyHeight, windowSizes,
    narrowPanel, schemes: Object.fromEntries(Object.entries(schemes).map(([scheme, value]) => [scheme, { ratio: value.ratio, background: value.background }])),
    tabKeys, ime: { value: composing.value, dispatchedDuringComposition: imeDispatched },
    untrustedText: injected
  }
}
