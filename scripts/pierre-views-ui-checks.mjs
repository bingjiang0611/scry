export async function exercise(contents, { measure = false } = {}) {
  const read = expression => contents.executeJavaScript(expression)
  const frames = () => read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
  const wait = async (expression, label) => {
    const deadline = Date.now() + 8000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out (${label}): ${expression}`)
      await frames()
    }
  }
  const must = (condition, message) => { if (!condition) throw new Error(message) }
  // Opt-in renderer timing for the workspace tree. A page-side mark keeps the two CDP
  // crossings out of the elapsed value; the fixture's own frame polling stays inside it.
  // Reported, never gated: hidden-window condition-observed timing is not paint evidence.
  const timings = {}
  const mark = async () => { if (measure) await read('window.__treeBenchMark = performance.now()') }
  const record = async name => {
    if (!measure) return
    timings[name] = Math.round(await read('performance.now() - window.__treeBenchMark'))
  }
  const query = selector => `(() => {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
    return roots.flatMap(root => [...root.querySelectorAll(${JSON.stringify(selector)})]);
  })()`
  const click = async (expression, button = 'left') => {
    const point = await read(`(() => {
      const element = ${expression};
      if (!element) throw new Error('Missing native target: ' + ${JSON.stringify(expression)});
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = element.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      let hit = document.elementFromPoint(x, y);
      while (hit?.shadowRoot) { const next = hit.shadowRoot.elementFromPoint(x, y); if (!next || next === hit) break; hit = next; }
      if (!hit || !(hit === element || element.contains(hit))) throw new Error('Occluded native target: ' + JSON.stringify({ target: element.outerHTML.slice(0, 400), hit: hit?.outerHTML.slice(0, 400), x, y, box: [r.x, r.y, r.width, r.height] }));
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button, clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button, clickCount: 1 })
    await frames()
  }
  const fill = async (expression, value) => {
    await click(expression)
    // Hidden fixtures have no app menu/Command-A accelerator. Use Electron's
    // native edit command; value changes still enter through native input.
    contents.selectAll()
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    if (value) await contents.insertText(value)
  }
  const mode = async value => { console.log('Pierre mode: ' + value); await click(`document.getElementById('mode-${value}')`) }
  const gutter = line => `${query(`[data-column-number="${line}"]`)}.find(node => node.getBoundingClientRect().height > 0)`
  await wait(`${query('[data-line] span[style]')}.length > 0`, 'offline TypeScript highlighting')
  await wait(`window.__pierreWorkers.filter(worker => worker.messages.includes('success:initialize')).length === 2 && window.__pierreWorkers.some(worker => worker.messages.includes('success:diff'))`, 'native worker highlighting response')
  const workerUrls = await read('window.__pierreWorkers.map(worker => worker.url)')
  must(await read(`window.__pierreWorkers.every(worker => !worker.messages.includes('error'))`), 'Native worker failed')
  await click(gutter(4))
  await wait(`document.querySelector('#comments').textContent.includes('LEFT')`, 'old-side line comment')
  await click(gutter(8))
  const comments = await read(`JSON.parse(document.querySelector('#comments').textContent)`)
  must(JSON.stringify(comments) === JSON.stringify([{ side: 'LEFT', line: 4 }, { side: 'RIGHT', line: 8 }]), `Incorrect comment mapping: ${JSON.stringify(comments)}`)

  await mode('patch')
  await click(`document.querySelector('input[aria-label="评论行号"]')`)
  await contents.insertText('9')
  await wait(`document.querySelector('.pierre-comment-target button')?.disabled === false`, 'captured keyboard comment target')
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await wait(`document.activeElement === document.querySelector('.pierre-comment-target button')`, 'Tab reaches the comment submit button')
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  contents.sendInputEvent({ type: 'char', keyCode: '\r' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await wait(`document.querySelector('#comments').textContent === '[{"side":"RIGHT","line":9}]'`, 'keyboard-only comment submission')

  await click(`document.getElementById('refresh-patch')`)
  await wait(`${query('[data-line]')}.some(node => node.textContent.includes('const refreshed = 6'))`, 'same-file snapshot refresh')
  must(await read(`!${query('[data-line]')}.some(node => node.textContent.includes('const after = 3'))`), 'Stale snapshot remained visible')

  await mode('truncated')
  await wait(`${query('[data-line]')}.length > 0`, 'partial patch remains inspectable')
  await click(gutter(4))
  must(await read(`document.querySelector('#comments').textContent === '[]'`), 'Truncated patch allowed a line comment')
  await mode('raw')
  await wait(`document.querySelector('.sc-notice')?.textContent.includes('原始正文')`, 'invalid patch explicitly raw')
  must(await read(`document.querySelector('#comments').textContent === '[]'`), 'Invalid patch assigned guessed comment coordinates')
  await mode('binary')
  await wait(`document.querySelector('.sc-notice')?.textContent.includes('二进制')`, 'binary evidence notice')
  must(await read(`${query('[data-line]')}.length === 0`), 'Binary evidence rendered a synthetic text diff')

  await mode('stack')
  await wait(`${query('[data-line]')}.some(node => node.textContent.includes('after'))`, 'stacked captured patch')
  must(await read(`!${query('[data-line]')}.some(node => node.textContent.includes('context-10'))`), 'Captured context was not folded')
  await click(`document.querySelector('[data-expand-context]')`)
  await wait(`${query('[data-line]')}.some(node => node.textContent.includes('context-10'))`, 'expand captured context')
  await click(`[...document.querySelectorAll('.diff-code-toolbar button')].find(node => node.textContent === 'Split')`)
  await wait(`${query('pre[data-diff-type="split"] [data-line]')}.some(node => node.textContent.includes('after'))`, 'split captured patch')
  await wait(`${query('code[data-deletions]')}.some(code => getComputedStyle(code).pointerEvents === 'auto')`, 'split body accepts native wheel input')
  const horizontalPoint = await read(`(() => {
    const code = ${query('code[data-deletions]')}[0], box = code.getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 60) };
  })()`)
  contents.sendInputEvent({ type: 'mouseMove', ...horizontalPoint })
  contents.sendInputEvent({ type: 'mouseWheel', ...horizontalPoint, deltaX: -160, deltaY: 0, canScroll: true })
  await wait(`${query('code[data-deletions]')}.some(code => code.scrollLeft > 100) && ${query('code[data-additions]')}.some(code => code.scrollLeft > 100)`, 'native horizontal split scroll')
  await click(`document.querySelector('[data-expand-context]')`)
  await wait(`!${query('[data-line]')}.some(node => node.textContent.includes('context-10')) && ${query('[data-line]')}.some(node => node.textContent.includes('after'))`, 'refold captured context in split mode')

  await click(`document.querySelector('.pierre-file-header > button')`)
  await wait(`${query('[data-line]')}.length === 0`, 'collapse captured file')
  must(await read(`document.activeElement?.classList.contains('pierre-code-view')`), 'Collapsing a virtual header lost keyboard focus')
  await click(`document.querySelector('.pierre-file-header > button')`)
  await wait(`${query('[data-line]')}.length > 0`, 'reopen captured file')
  must(await read(`document.activeElement?.classList.contains('pierre-code-view')`), 'Reopening a virtual header lost keyboard focus')

  await mode('identity')
  await wait(`${query('[data-item-path="archive/left/shared.ts"]')}.length === 1 && ${query('[data-item-path="archive/right/shared.ts"]')}.length === 1`, 'same basenames retain distinct historical identities')
  await wait(`${query('[data-line]')}.some(node => node.textContent.includes('captured-left')) && ${query('[data-line]')}.some(node => node.textContent.includes('captured-right'))`, 'both historical bodies retain their captured bytes')
  await click(`${query('[data-item-path="archive/right/shared.ts"]')}[0]`)
  await wait(`${query('[data-item-path="archive/right/shared.ts"][aria-selected="true"]')}.length === 1`, 'historical selection uses the authoritative full path')

  await mode('stress')
  console.log('Pierre stress mode entered')
  await wait(`${query('[data-line]')}.length > 0`, 'large stacked patch mounted')
  await click(`[...document.querySelectorAll('.diff-code-toolbar button')].find(node => node.textContent === 'Unified')`)
  await click(`document.querySelector('.pierre-file-header > button')`)
  await click(`document.querySelector('.pierre-file-header > button')`)
  const stackedRows = await read(`${query('[data-line]')}.length`)
  must(stackedRows > 0 && stackedRows < 100, 'Unbounded large diff DOM: ' + stackedRows)
  console.log('Pierre stress file reopened')
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'End' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'End' })
  await wait(`[...document.querySelectorAll('.pierre-file-header')].some(header => header.textContent.includes('pressure-0999.txt'))`, 'large stack End reaches last file')
  await wait(`${query('[data-line]')}.some(node => node.textContent.includes('file-999-line-0000')) && ${query('[data-line]')}.some(node => node.textContent.includes('file-998-line-0000'))`, 'multiple captured file bodies coexist in the stack')
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Home' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Home' })
  await wait(`document.querySelector('.pierre-code-view').scrollTop === 0`, 'large stack Home reaches start')
  await click(`${query('[data-item-path="pressure-0000.txt"]')}[0]`)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'End' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'End' })
  await wait(`${query('[data-item-path="pressure-0999.txt"][aria-selected="true"]')}.length === 1`, 'diff tree End selects last file')
  await wait(`[...document.querySelectorAll('.pierre-file-header')].some(header => header.textContent.includes('pressure-0999.txt'))`, 'diff tree selection scrolls code')

  await mark()
  await mode('workspace')
  await wait(`${query('[data-item-path="src/"]')}.length > 0`, 'workspace root')
  await record('workspaceMount')
  must(await read(`JSON.parse(document.querySelector('#reads').textContent).length === 1`), 'Workspace eagerly scanned unopened directories')
  await mark()
  await click(`${query('[data-item-path="src/"]')}[0]`)
  await wait(`JSON.parse(document.querySelector('#reads').textContent).length === 2`, 'directory loads on expansion')
  await wait(`${query('[data-item-path="src/file-0000.ts"]')}.length > 0`, 'expanded directory rows')
  await record('directoryExpand')
  await wait(`document.querySelector('.workspace-load-more')?.textContent.includes('src')`, 'directory pagination')
  await click(`document.querySelector('.workspace-load-more')`)
  await wait(`JSON.parse(document.querySelector('#reads').textContent).length === 3`, 'next page read')
  const requests = await read(`JSON.parse(document.querySelector('#reads').textContent)`)
  must(requests[2].cursor === 'page-2', 'Directory cursor not preserved')
  const nodes = await read(`${query('[role="treeitem"]')}.length`)
  must(nodes > 0 && nodes < 100, `Unbounded tree DOM: ${nodes}`)
  const shadowElements = await read(`(() => {
    const host = document.querySelector('.pierre-workspace-nodes file-tree-container')
    return host?.shadowRoot ? host.shadowRoot.querySelectorAll('*').length : 0
  })()`)
  must(shadowElements > 0, 'Workspace tree shadow DOM is empty')
  await mark()
  await fill(`document.querySelector('.workspace-search input')`, 'absent-file-match')
  await wait(`${query('[data-item-path]')}.length === 0 && document.querySelector('.workspace-empty')?.textContent.includes('没有匹配文件')`, 'no matches hide unrelated tree files')
  await record('searchNoMatch')
  await mark()
  await fill(`document.querySelector('.workspace-search input')`, ' FILE-0999 ')
  await wait(`${query('[data-item-path="src/file-0999.ts"]')}.length === 1 && ${query('[role="treeitem"]')}.length < 5`, 'case-insensitive loaded-file search')
  await record('searchMatch')
  must(await read(`JSON.parse(document.querySelector('#reads').textContent).length === 3`), 'Filtering scanned directories')
  await mark()
  await fill(`document.querySelector('.workspace-search input')`, '')
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Home' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Home' })
  await wait(`${query('[data-item-path="src/"]')}.length > 0`, 'clearing search restores the loaded tree')
  await record('searchClear')
  await click(`${query('[data-item-path="src/"]')}[0]`)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'End' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'End' })
  // Re-open after the collapse; End must reach the final loaded file without scanning again.
  await mark()
  await click(`${query('[data-item-path="src/"]')}[0]`)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'End' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'End' })
  await wait(`${query('[data-item-path="src/file-0999.ts"]')}.length > 0`, 'large tree End navigation')
  await record('keyboardEndAfterReopen')
  must(await read(`JSON.parse(document.querySelector('#reads').textContent).length === 3`), 'Keyboard navigation rescanned the directory')
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await wait(`document.querySelector('.workspace-panel textarea')?.readOnly === true && document.querySelector('.workspace-panel textarea').value === 'const readonly = true\\n'`, 'keyboard opens the loaded file read-only')

  await mode('treeEvents')
  await wait(`${query('[data-item-path="document.ts"]')}.length === 1`, 'mutable tree row')
  await click(`${query('[data-item-path="document.ts"]')}[0]`)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'F2' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'F2' })
  await wait(`JSON.parse(document.getElementById('tree-events').textContent).some(event => event.kind === 'rename')`, 'native F2 rename routing')
  await click(`${query('[data-item-path="document.ts"]')}[0]`, 'right')
  await wait(`JSON.parse(document.getElementById('tree-events').textContent).some(event => event.kind === 'context')`, 'native context-menu routing')
  const treeEvents = await read(`JSON.parse(document.getElementById('tree-events').textContent)`)
  must(JSON.stringify(treeEvents) === JSON.stringify(['open', 'rename', 'context'].map(kind => ({ kind, path: 'document.ts' }))), 'Tree action routing changed: ' + JSON.stringify(treeEvents))
  return { workerUrls, timings, workspaceDom: { mountedRows: nodes, shadowElements }, treeEvents, commentMapping: comments, keyboardComment: true, sameFileRefresh: true, capturedContextExpansion: true, capturedContextSplit: true, horizontalSplitScroll: true, collapseFocus: true, stackedRows, thousandFileKeyboard: true, multipleCapturedBodies: true, historicalFileIdentity: true, truncatedCommentsBlocked: true, rawEvidence: true, binaryEvidence: true,
    lazyDirectoryReads: requests, boundedTreeNodes: nodes, loadedFileFiltering: true, lastLoadedFileReachable: true, keyboardReadOnlyOpen: true }
}
