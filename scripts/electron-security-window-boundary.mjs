import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function exerciseWindowBoundary(smokeContext) {
  const { evaluate, workspace, page } = smokeContext
  const windowChrome = await evaluate(`(async () => {
    const toggle = document.querySelector('button[title="右侧工作区"]')
    if (toggle?.getAttribute('aria-pressed') !== 'true') toggle?.click()
    await new Promise(resolve => requestAnimationFrame(resolve))
    const paneDeadline = Date.now() + 2000
    while (document.querySelector('#right-surface-pane')?.getAnimations().some(animation => animation.id === 'scry-pane' && animation.playState !== 'finished')) {
      if (Date.now() > paneDeadline) throw new Error('Pane motion did not settle before window chrome inspection')
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    const inspect = (selector) => {
      const scoped = selector.startsWith('.surface') || selector === '.right-surface-panel'
      const node = document.querySelector(scoped ? '[data-session-surface-current="true"] ' + selector : selector)
      if (!node) return null
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return {
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        background: style.backgroundColor,
        drag: style.getPropertyValue('-webkit-app-region'),
        paddingLeft: style.paddingLeft,
        position: style.position,
        borderRadius: style.borderRadius
      }
    }
    const topbarAction = document.querySelector('.topbar button')
    const surfaceAction = document.querySelector('[data-session-surface-current="true"] .surface-topbar button')
    const root = document.documentElement
    const previousTheme = root.dataset.theme
    const previousBackground = inspect('.main-area')?.background
    const waitForBackground = async (expected) => {
      const deadline = Date.now() + 2000
      while (inspect('.main-area')?.background !== expected) {
        if (Date.now() > deadline) throw new Error('Theme background did not settle: ' + expected)
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
    }
    root.dataset.theme = 'light'
    // Computed styles can initially report the old color during the theme transition.
    await waitForBackground('rgb(255, 255, 255)')
    const lightBackgrounds = {
      sidebar: inspect('.sidebar')?.background,
      brand: inspect('.sb-brand')?.background,
      main: inspect('.main-area')?.background,
      topbar: inspect('.topbar')?.background,
      surface: inspect('.right-surface-panel')?.background,
      surfaceTopbar: inspect('.surface-topbar')?.background
    }
    if (previousTheme) root.dataset.theme = previousTheme
    else delete root.dataset.theme
    await waitForBackground(previousBackground)
    return {
      platform: document.documentElement.dataset.platform,
      viewportWidth: document.documentElement.clientWidth,
      sidebar: inspect('.sidebar'),
      brand: inspect('.sb-brand'),
      main: inspect('.main-area'),
      topbar: inspect('.topbar'),
      surfaceSlot: inspect('.right-panel-slot'),
      surface: inspect('.right-surface-panel'),
      surfaceTopbar: inspect('.surface-topbar'),
      topbarActionDrag: topbarAction
        ? getComputedStyle(topbarAction).getPropertyValue('-webkit-app-region')
        : null,
      surfaceActionDrag: surfaceAction
        ? getComputedStyle(surfaceAction).getPropertyValue('-webkit-app-region')
        : null,
      lightBackgrounds
    }
  })()`)
  // 这组断言验证 macOS 的集成标题栏：隐藏标题栏、红绿灯安全区与 -webkit-app-region。
  // Linux 由窗口管理器提供边框，没有这些结构；这里不臆造等价断言，跳过并在目标机人工验收。
  const integratedTitlebar = process.platform === 'darwin'
  assert.equal(windowChrome.platform, integratedTitlebar ? 'macos' : 'linux')
  if (integratedTitlebar) {
    assert.deepEqual(
      [windowChrome.brand?.top, windowChrome.topbar?.top],
      [0, 0],
      'macOS primary app columns must extend to the top window edge'
    )
    assert.deepEqual(
      [windowChrome.surfaceSlot?.top, windowChrome.surfaceTopbar?.top],
      [0, 0],
      'on-demand Surface must join the integrated titlebar at the window edge'
    )
  }
  assert.deepEqual(
    [windowChrome.surfaceSlot?.position, windowChrome.surfaceSlot?.borderRadius],
    ['static', '0px'],
    'on-demand Surface must remain a docked split workspace'
  )
  assert.ok(windowChrome.surfaceSlot?.width >= 360, 'docked Surface fell below its usable width')
  assert.equal(
    windowChrome.viewportWidth - windowChrome.surfaceSlot?.right,
    0,
    'docked Surface lost its right-edge alignment'
  )
  if (integratedTitlebar) {
    assert.deepEqual(
      [windowChrome.brand?.height, windowChrome.topbar?.height, windowChrome.surfaceTopbar?.height],
      [52, 52, 52],
      'macOS app chrome must share the 52px integrated titlebar height'
    )
    assert.equal(windowChrome.brand?.paddingLeft, '80px', 'sidebar chrome must reserve the traffic-light safe area')
    assert.deepEqual(
      [windowChrome.brand?.drag, windowChrome.topbar?.drag, windowChrome.surfaceTopbar?.drag],
      ['drag', 'drag', 'drag'],
      'integrated titlebars must remain draggable'
    )
    assert.deepEqual(
      [windowChrome.topbarActionDrag, windowChrome.surfaceActionDrag],
      ['no-drag', 'no-drag'],
      'titlebar actions must remain interactive'
    )
  }
  assert.equal(windowChrome.brand?.background, 'rgba(0, 0, 0, 0)')
  assert.equal(windowChrome.topbar?.background, windowChrome.main?.background)
  assert.equal(windowChrome.surfaceTopbar?.background, 'rgba(0, 0, 0, 0)')
  assert.equal(windowChrome.lightBackgrounds.brand, 'rgba(0, 0, 0, 0)')
  assert.equal(windowChrome.lightBackgrounds.topbar, windowChrome.lightBackgrounds.main)
  assert.equal(windowChrome.lightBackgrounds.surfaceTopbar, 'rgba(0, 0, 0, 0)')
  assert.equal(windowChrome.lightBackgrounds.main, 'rgb(255, 255, 255)')
  assert.notEqual(windowChrome.lightBackgrounds.main, windowChrome.main?.background)

  const collapsedChrome = await evaluate(`(async () => {
    const waitFor = async (predicate, timeout = 2_000) => {
      const deadline = Date.now() + timeout
      while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return predicate()
    }
    // 入场动画用 transform 位移 pane；待定动画在无合成器的环境里可能永不启动，
    // 所以布局断言看去掉 transform 后的盒子左边（offsetLeft 语义），不看 getBoundingClientRect。
    const layoutLeft = (node) => {
      if (!node) return -1
      const rect = node.getBoundingClientRect()
      const transform = getComputedStyle(node).transform
      const offset = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m41 : 0
      return rect.left - offset
    }
    const splitter = document.querySelector('.sidebar-resizer')
    splitter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const collapsed = await waitFor(() => document.querySelector('.app')?.classList.contains('sidebar-collapsed') === true)
    const mainLeft = Math.round(document.querySelector('.main-area')?.getBoundingClientRect().left ?? -1)
    const mainActionLeft = Math.round(document.querySelector('.topbar button')?.getBoundingClientRect().left ?? -1)

    const analyticsButton = [...document.querySelectorAll('button.sb-navitem')]
      .find((node) => node.textContent?.includes('分析'))
    analyticsButton?.click()
    const analytics = await waitFor(() => !!document.querySelector('.usage-page'))
    const analyticsLoading = document.querySelector('.lazy-panel-loading')?.textContent
    const auxTopbar = document.querySelector('.aux-view-topbar')
    const auxRect = auxTopbar?.getBoundingClientRect()
    const auxDrag = auxTopbar ? getComputedStyle(auxTopbar).getPropertyValue('-webkit-app-region') : null
    const analyticsTop = Math.round(document.querySelector('.usage-page')?.getBoundingClientRect().top ?? -1)

    document.querySelector('button.sb-sess')?.click()
    const chatRestored = await waitFor(() => !!document.querySelector('.topbar'))

    document.querySelector('[data-session-surface-current="true"] button[aria-label="最大化右侧工作区"]')?.click()
    let initialSurfaceChrome, surfaceChromeState
    const maximized = await waitFor(() => {
      if (!document.querySelector('.app')?.classList.contains('right-panel-maximized')) return false
      const topbar = document.querySelector('[data-session-surface-current="true"] .surface-topbar')
      surfaceChromeState = {
        appClass: document.querySelector('.app')?.className,
        platform: document.documentElement.dataset.platform,
        paddingLeft: topbar ? getComputedStyle(topbar).paddingLeft : null,
        tabsScrollLeft: topbar?.querySelector('.surface-tabs')?.scrollLeft,
        surfaceLeft: layoutLeft(document.querySelector('.right-panel-slot')),
        actionLeft: layoutLeft(topbar?.querySelector('button')),
        gridColumns: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
        mainDisplay: getComputedStyle(document.querySelector('.main-area')).display
      }
      initialSurfaceChrome ??= surfaceChromeState
      // 最大化后 pane 必须落到侧栏折叠留下的位置上。这个判据与平台无关：
      // 红绿灯安全区是 macOS 自绘标题栏的额外约束，放在下面的 macOS 分支里断言。
      return surfaceChromeState.surfaceLeft >= 0 && surfaceChromeState.surfaceLeft < 16
    })
    const surfaceLeft = layoutLeft(document.querySelector('.right-panel-slot'))
    const surfaceActionLeft = layoutLeft(document.querySelector('[data-session-surface-current="true"] .surface-topbar button'))

    document.querySelector('[data-session-surface-current="true"] button[aria-label="恢复右侧工作区"]')?.click()
    await waitFor(() => document.querySelector('.app')?.classList.contains('right-panel-maximized') === false)
    splitter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const restored = await waitFor(() => document.querySelector('.app')?.classList.contains('sidebar-collapsed') === false)
    return {
      collapsed,
      mainLeft,
      mainActionLeft,
      analytics,
      analyticsLoading,
      auxTop: Math.round(auxRect?.top ?? -1),
      auxHeight: Math.round(auxRect?.height ?? -1),
      auxDrag,
      analyticsTop,
      chatRestored,
      maximized,
      surfaceLeft,
      surfaceActionLeft,
      initialSurfaceChrome,
      surfaceChromeState,
      restored
    }
  })()`)
  assert.equal(collapsedChrome.collapsed, true)
  assert.ok(collapsedChrome.mainLeft < 16, `collapsed sidebar did not release its layout width: ${JSON.stringify(collapsedChrome)}`)
  assert.equal(collapsedChrome.analytics, true, `Analytics transition failed: ${JSON.stringify(collapsedChrome)}`)
  assert.equal(collapsedChrome.chatRestored, true)
  assert.equal(collapsedChrome.maximized, true, `maximized Surface never settled into the collapsed sidebar track: ${JSON.stringify(collapsedChrome)}`)
  assert.equal(collapsedChrome.restored, true)
  // 布局断言与平台无关：最大化后工作区必须铺到侧栏折叠后留下的位置。
  assert.ok(collapsedChrome.surfaceLeft < 16, `maximized Surface did not move into the collapsed sidebar track: ${JSON.stringify(collapsedChrome)}`)
  if (integratedTitlebar) {
    assert.ok(collapsedChrome.mainActionLeft >= 80, `collapsed main chrome overlaps traffic lights: ${JSON.stringify(collapsedChrome)}`)
    assert.deepEqual(
      [collapsedChrome.auxTop, collapsedChrome.auxHeight, collapsedChrome.auxDrag],
      [0, 52, 'drag'],
      `auxiliary view is missing integrated window chrome: ${JSON.stringify(collapsedChrome)}`
    )
    assert.ok(collapsedChrome.analyticsTop >= 52, `Analytics overlaps traffic lights: ${JSON.stringify(collapsedChrome)}`)
    assert.ok(collapsedChrome.surfaceActionLeft >= 80, `collapsed Surface chrome overlaps traffic lights: ${JSON.stringify(collapsedChrome)}`)
  }

  const transportPicker = await evaluate(`(async () => {
    const deadline = Date.now() + 2_000
    let recent
    while (!recent && Date.now() < deadline) {
      recent = document.querySelector('button.sb-sess')
      if (!recent) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    document.querySelector('button.sb-new')?.click()
    const unlockDeadline = Date.now() + 2_000
    let unlockedAgent
    while ((!unlockedAgent || unlockedAgent.disabled) && Date.now() < unlockDeadline) {
      unlockedAgent = document.querySelector('button.clibtn')
      if (!unlockedAgent || unlockedAgent.disabled) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    unlockedAgent?.click()
    const menuDeadline = Date.now() + 2_000
    while (!document.querySelector('.climenu') && Date.now() < menuDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const button = [...document.querySelectorAll('button')].find((node) => node.title?.includes('API/BYOK'))
    return {
      recentFound: !!recent,
      newSessionAgentUnlocked: !!unlockedAgent && !unlockedAgent.disabled,
      menuFound: !!document.querySelector('.climenu'),
      apiPlaceholderFound: !!button
    }
  })()`)
  assert.deepEqual(transportPicker, {
    recentFound: true,
    newSessionAgentUnlocked: true,
    menuFound: true,
    apiPlaceholderFound: false
  })

  const modal = await evaluate(`(async () => {
    const trigger = document.querySelector('button[title="MCP"]')
    if (!trigger) throw new Error('MCP modal trigger is missing')
    trigger.focus()
    const triggerState = {
      disabled: trigger.disabled,
      focused: document.activeElement === trigger,
      width: trigger.getBoundingClientRect().width,
      height: trigger.getBoundingClientRect().height,
      agentMenuOpen: !!document.querySelector('.climenu')
    }
    trigger.click()
    let dialog = null
    let focusedInside = false
    for (let attempt = 0; attempt < 40; attempt++) {
      dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      focusedInside = !!dialog && dialog.contains(document.activeElement)
      if (focusedInside) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!dialog) throw new Error('MCP modal did not open: ' + JSON.stringify({
      triggerState,
      connected: trigger.isConnected,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => node.outerHTML.slice(0, 300)),
      activeElement: document.activeElement?.outerHTML.slice(0, 300)
    }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    let closed = false
    let restored = false
    for (let attempt = 0; attempt < 40; attempt++) {
      closed = !document.querySelector('[role="dialog"]')
      restored = document.activeElement === trigger
      if (closed && restored) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return {
      opened: !!dialog,
      labelled: !!dialog?.getAttribute('aria-labelledby'),
      focusedInside,
      closed,
      restored
    }
  })()`)
  assert.deepEqual(modal, { opened: true, labelled: true, focusedInside: true, closed: true, restored: true })

  const subframeIpc = await evaluate(`(async () => {
    const frame = document.createElement('iframe')
    frame.srcdoc = '<p>untrusted subframe</p>'
    document.body.append(frame)
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      const api = frame.contentWindow?.scry
      if (!api) return 'not_exposed'
      await api.listProjects()
      return 'allowed'
    } catch {
      return 'rejected'
    } finally {
      frame.remove()
    }
  })()`)
  assert.notEqual(subframeIpc, 'allowed', 'an untrusted subframe reached privileged IPC')

  // 只上报窗口由谁提供边框：macOS 是应用自绘标题栏，Linux 交给窗口管理器。
  const chrome = { platform: windowChrome.platform }

  return { windowChrome, collapsedChrome, transportPicker, modal, subframeIpc, chrome }
}
