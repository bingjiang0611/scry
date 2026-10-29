// Production React/CSS in an isolated sandboxed Electron window, not an App acceptance test.
export async function exerciseChatPreviewDom() {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const waitFor = async (predicate) => {
    const deadline = performance.now() + 5000
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`Timed out: ${predicate.toString()}`)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  }
  const query = (label) => document.querySelector(`[aria-label="${label}"]`)
  const rect = (element) => element.getBoundingClientRect()
  const visible = (element) => {
    const box = rect(element)
    return box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1
  }
  await waitFor(() => document.querySelectorAll('.user-attachment').length === 2)
  const thumbs = [...document.querySelectorAll('.user-attachment')]
  const thumbnailRows = new Set(thumbs.map((thumb) => Math.round(rect(thumb).top)))
  if (innerWidth >= 900) check(thumbnailRows.size === 1, 'Image thumbnails wrapped before filling the row')
  else check(thumbnailRows.size === 2, 'Image thumbnails did not wrap in the narrow layout')
  for (const thumb of thumbs) {
    thumb.focus()
    thumb.click()
    await waitFor(() => document.querySelector('.image-lightbox-stage img')?.style.visibility === 'visible')
    const dialog = document.querySelector('.image-lightbox')
    const overlay = dialog.parentElement
    const stage = dialog.querySelector('.image-lightbox-stage')
    const image = stage.querySelector('img')
    const close = query('关闭图片预览')
    check(overlay.parentElement === document.body, 'Preview is still inside contained transcript')
    check(rect(overlay).width === document.documentElement.clientWidth && rect(overlay).height === document.documentElement.clientHeight, 'Overlay does not cover viewport')
    check(overlay.contains(document.elementFromPoint(document.documentElement.clientWidth - 5, 5)), 'Summary remains above overlay')
    check(visible(close) && visible(query('放大图片')), 'Preview controls escaped viewport')
    check(rect(image).width <= stage.clientWidth + 1 && rect(image).height <= stage.clientHeight + 1, 'Initial image does not fit')
    check(document.activeElement === close, 'Close did not receive initial focus')
    // Focus must stay in the dialog; image clicks must not dismiss it.
    thumbs[1].focus()
    // Hidden BrowserWindows do not emit native focusin; exercise the document guard.
    thumbs[1].dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    check(dialog.contains(document.activeElement), 'Focus escaped modal')
    image.click()
    check(document.querySelector('.image-lightbox') === dialog, 'Image click dismissed preview')
    for (let i = 0; i < 4; i++) {
      query('放大图片').click()
      await waitFor(() => dialog.querySelector('.image-lightbox-reset').textContent === `${125 + i * 25}%`)
    }
    check(query('放大图片').disabled, 'Zoom upper bound missing')
    check(stage.scrollHeight > stage.clientHeight || stage.scrollWidth > stage.clientWidth, 'Zoom is clipped instead of scrollable')
    stage.scrollTo(stage.scrollWidth, stage.scrollHeight)
    check(stage.scrollTop > 0 || stage.scrollLeft > 0, 'Zoomed edges are unreachable')
    check(visible(close) && visible(query('缩小图片')), 'Zoom moved controls off screen')
    for (let i = 0; i < 6; i++) {
      query('缩小图片').click()
      await waitFor(() => dialog.querySelector('.image-lightbox-reset').textContent === `${175 - i * 25}%`)
    }
    check(query('缩小图片').disabled, 'Zoom lower bound missing')
    dialog.querySelector('.image-lightbox-reset').click()
    await waitFor(() => dialog.querySelector('.image-lightbox-reset').textContent === '100%')
    check(!query('缩小图片').disabled, 'Reset zoom did not restore the zoom range')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => !document.querySelector('.image-lightbox'))
    check(document.activeElement === thumb, 'Escape did not restore thumbnail focus')
    thumb.click()
    await waitFor(() => document.querySelector('.image-lightbox-stage img')?.style.visibility === 'visible')
    check(document.querySelector('.image-lightbox-reset').textContent === '100%', 'Reopen retained stale zoom')
    query('关闭图片预览').click()
    await waitFor(() => !document.querySelector('.image-lightbox'))
    thumb.click()
    await waitFor(() => document.querySelector('.image-lightbox'))
    document.querySelector('.modal-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await waitFor(() => !document.querySelector('.image-lightbox'))
    check(document.activeElement === thumb, 'Backdrop close did not restore focus')
  }
  // macOS 标题栏前 52px 是 -webkit-app-region 拖拽带：落在那里的原生点击会变成窗口拖动，
  // 按钮收不到 click。关闭按钮必须整块在拖拽带下方，覆盖层自己也要声明 no-drag。
  document.documentElement.dataset.platform = 'macos'
  thumbs[0].click()
  await waitFor(() => document.querySelector('.image-lightbox-stage img')?.style.visibility === 'visible')
  const platformDialog = document.querySelector('.image-lightbox')
  const platformClose = query('关闭图片预览')
  check(rect(platformClose).top >= 52, 'Preview close button sits inside the macOS titlebar drag strip')
  check(
    getComputedStyle(platformDialog.parentElement).getPropertyValue('-webkit-app-region') === 'no-drag',
    'Preview overlay does not claim no-drag over the titlebar drag strip'
  )
  delete document.documentElement.dataset.platform
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await waitFor(() => !document.querySelector('.image-lightbox'))
  const piTurns = document.querySelectorAll('#pi-feedback-fixture .turn-assistant')
  check(piTurns.length === 2, 'Pi live/history feedback fixtures did not mount')
  for (const turn of piTurns) {
    check(!turn.textContent.includes('TPS 25.7'), 'Pi info notification leaked into conversation')
    check(turn.textContent.includes('已完成代码检查。'), 'Pi reply was hidden with notification')
    check(turn.querySelector('[aria-label="Pi 扩展通知"]')?.textContent.includes('扩展警告内容'), 'Pi warning was hidden or mislabeled')
    const commands = turn.querySelectorAll('[aria-label="Pi 命令反馈"]')
    check(commands.length === 1 && commands[0].textContent.includes('/test-command 已执行'), 'Pi command feedback was hidden or mixed with notifications')
  }
  const pausedGoal = document.querySelector('#goal-paused-fixture')
  pausedGoal.hidden = false
  const termination = pausedGoal.querySelector('[role="status"]')
  check(visible(termination), 'Tool termination explanation is not visible')
  check(termination.textContent.includes('including after resume'), 'Lost the actual Goal recovery restriction')
  check(termination.textContent.includes('执行结束不代表目标已验证完成'), 'Tool settlement claims Goal completion')
  check(!pausedGoal.querySelector('.errline'), 'Tool termination still renders as a Provider error')
  check(!pausedGoal.textContent.includes('继续当前会话重试'), 'Goal pause still advises blind retry')
  pausedGoal.hidden = true
  const performanceFixture = document.querySelector('#performance-fixture')
  const formatWhole = performanceFixture.querySelector('.md-format-whole')
  check(formatWhole != null, 'Long Markdown did not defer full formatting')
  check(!performanceFixture.querySelector('h2'), 'Unsafe long Markdown formatted before user request')
  formatWhole.click()
  await waitFor(() => performanceFixture.querySelector('h2') != null)
  check(performanceFixture.querySelectorAll('[data-trace-event-id]').length === 0, 'Collapsed tools mounted eagerly')
  // A completed turn only mounts its tail (src/renderer/completed-turn-flow.ts), so the earlier tool
  // flow sits behind the real reveal control; expand it before measuring the group's lazy mount.
  const flowReveal = performanceFixture.querySelector('.turn-flow-reveal')
  check(flowReveal != null, 'Historical tool flow has no real reveal entry')
  flowReveal.click()
  await waitFor(() => performanceFixture.querySelector('.turn-flow-reveal') == null)
  check(performanceFixture.querySelectorAll('[data-trace-event-id]').length === 0, 'Revealing the earlier flow mounted closed tool cards')
  const toolGroup = performanceFixture.querySelector('.tool-group-row')
  check(toolGroup != null, 'Revealed historical flow lost its tool group')
  toolGroup.click()
  await waitFor(() => performanceFixture.querySelectorAll('[data-trace-event-id]').length === 100)
  toolGroup.click()
  await waitFor(() => performanceFixture.querySelectorAll('[data-trace-event-id]').length === 0)
  const projectPicker = () => document.querySelector('#composer-project .composer-context')
  check(projectPicker() != null, 'New draft lost project selection')
  const input = document.querySelector('#composer-project textarea')
  const draft = input.value
  const enter = (options = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })
    input.dispatchEvent(event)
    return event
  }
  check(!enter({ shiftKey: true }).defaultPrevented, 'Shift+Enter no longer allows a newline')
  check(enter({ repeat: true }).defaultPrevented, 'Repeated Enter leaked a default newline')
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  check(enter({ isComposing: true }).defaultPrevented, 'IME Enter leaked a default newline')
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '消息' }))
  check(enter().defaultPrevented, 'Post-composition Enter leaked a default newline')
  check(input.dataset.sends == null && input.value === draft, 'IME confirmation submitted or changed the draft')
  // Both keydowns run in this same task: no timing sleep may hide a swallowed key.
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
  check(enter().defaultPrevented, 'Send Enter leaked a default newline')
  check(input.dataset.sends === '1', 'A fresh Enter after IME confirmation was swallowed')
  await waitFor(() => projectPicker() == null)
  check(document.querySelector('#composer-project textarea') === input, 'Hiding project selection remounted composer input')
  await waitFor(() => input.value === '')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await waitFor(() => input.value === '测试消息')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await waitFor(() => input.value === '更早的消息')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await waitFor(() => input.value === '测试消息')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await waitFor(() => input.value === '')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '手动输入')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => input.value === '手动输入')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  check(input.value === '手动输入', 'History replaced a non-empty draft')
  document.querySelector('#new-draft').click()
  await waitFor(() => projectPicker() != null)
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '输入' }))
  input.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }))
  enter()
  check(input.dataset.sends === '2', 'Enter after Space confirmed the IME candidate was swallowed')
  await waitFor(() => input.value === '')
  return { imeConfirmationProtected: true, immediateEnterSends: true, spaceConfirmationSends: true, viewport: [innerWidth, innerHeight], portraitAndLandscape: true, attachmentFlow: true, viewportOverlay: true, zoomScroll: true, closePaths: true, focusRestore: true, markdownDeferred: true, toolsDeferred: true, projectPickerLifecycle: true, promptHistoryNavigation: true, piFeedbackSeparated: true }
}
