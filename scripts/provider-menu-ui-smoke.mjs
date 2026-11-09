import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { runUiCampaign } from './ui-campaign.mjs'

// 真实 Chromium 里的 Provider 菜单检查：挂载真实 CliPicker / ProviderFilterMenu 与
// 真实样式表，只喂合成 Provider 列表。覆盖品牌图标（形状、品牌色、20px）、单选语义、
// 键盘关闭与焦点回收——这些在 jsdom 里没有布局和真实计算样式。
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-provider-menu-ui-'))

async function exerciseProviderMenus() {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  let stage = 'start'
  const must = (node, label) => {
    if (!node) throw new Error('missing ' + label + ' at ' + stage)
    return node
  }
  const go = async (next, body) => {
    stage = next
    try { return await body() } catch (error) { throw new Error(stage + ': ' + error.message) }
  }
  // 菜单的 Esc / 外部点击监听在 effect 里挂载，先等一帧再交互。
  await frame()
  const picker = must(document.querySelector('#picker-fixture'), 'picker fixture')
  const filter = must(document.querySelector('#filter-fixture'), 'filter fixture')
  const rows = await go('rows', () => picker.querySelectorAll('[role="menuitemradio"]'))
  const checked = [...rows].filter((row) => row.getAttribute('aria-checked') === 'true')
  if (rows.length !== 6) throw new Error('expected 6 provider rows, got ' + rows.length)
  if (checked.length !== 1 || checked[0].dataset.agentId !== 'pi:rotom') {
    throw new Error('single checked row expected on pi:rotom, got ' + checked.map((row) => row.dataset.agentId))
  }
  if (picker.textContent.includes('当前')) throw new Error('trailing 当前 chip still rendered')

  const glyphs = [...picker.querySelectorAll('[role="menuitemradio"] .agicon .provider-glyph')]
  if (glyphs.length !== rows.length) throw new Error('every row needs a brand glyph, got ' + glyphs.length + '/' + rows.length)
  const brands = glyphs.map((glyph) => {
    const box = glyph.getBoundingClientRect()
    const svg = glyph.querySelector('svg')
    const path = svg?.querySelector('path')
    return {
      provider: glyph.dataset.provider,
      width: Math.round(box.width),
      height: Math.round(box.height),
      color: getComputedStyle(glyph).color,
      viewBox: svg?.getAttribute('viewBox'),
      paths: svg?.querySelectorAll('path').length ?? 0,
      pathLength: [...(svg?.querySelectorAll('path') ?? [])].reduce((total, node) => total + (node.getAttribute('d')?.length ?? 0), 0)
    }
  })
  const expected = ['claude', 'codex', 'qoder', 'opencode', 'pi', 'pi']
  brands.forEach((brand, index) => {
    if (brand.provider !== expected[index]) throw new Error('row ' + index + ' glyph provider ' + brand.provider + ', expected ' + expected[index])
    // 真实品牌图形：有 viewBox 与真实路径，尺寸来自样式表而不是默认 300x150。
    if (brand.width !== 20 || brand.height !== 20) throw new Error(brand.provider + ' glyph box ' + brand.width + 'x' + brand.height)
    // 品牌标是内联路径；空图标或占位方块都会在这里露馅（opencode 的方框本身就短）。
    if (!brand.viewBox || brand.paths < 1 || brand.pathLength < 20) throw new Error(brand.provider + ' glyph is not a real brand path')
  })
  const claude = brands[0]
  if (claude.color !== 'rgb(217, 119, 87)') throw new Error('claude brand color ' + claude.color)
  for (const brand of brands.slice(1)) {
    if (brand.color !== 'rgb(244, 246, 250)') throw new Error(brand.provider + ' brand color ' + brand.color)
  }

  const firstRow = rows[0]
  const rowStyle = getComputedStyle(firstRow)
  const metrics = {
    rowHeight: Math.round(firstRow.getBoundingClientRect().height),
    rowGapBelow: Math.round(rows[1].getBoundingClientRect().top - firstRow.getBoundingClientRect().bottom),
    padding: rowStyle.padding,
    lineHeight: rowStyle.lineHeight,
    fontSize: rowStyle.fontSize,
    menuGap: getComputedStyle(firstRow.parentElement).gap
  }

  // 菜单行的规格：40px 行高、行间无额外间距，图标 20px 由上面的断言锁住。
  if (metrics.rowHeight !== 40) throw new Error('menu row height ' + metrics.rowHeight + 'px, expected 40px')
  if (metrics.rowGapBelow !== 0) throw new Error('menu rows must not add spacing between them, got ' + metrics.rowGapBelow)

  // 对勾列在最左，且只有当前项显示。
  const checkColumn = [...rows].map((row) => row.firstElementChild?.className ?? '')
  if (checkColumn.some((name) => !name.includes('menu-check'))) throw new Error('menu rows must start with the check column: ' + checkColumn.join(' | '))
  const drawnChecks = [...picker.querySelectorAll('.menu-check')].filter((node) => node.querySelector('svg'))
  if (drawnChecks.length !== 1) throw new Error('expected exactly one drawn check, got ' + drawnChecks.length)
  if (!checked[0].firstElementChild.contains(drawnChecks[0])) throw new Error('the check is not in the selected row')

  // Esc 关闭菜单并把焦点还给触发按钮。
  stage = 'escape'
  const trigger = must(picker.querySelector('button[aria-haspopup]'), 'picker trigger')
  const menu = must(picker.querySelector('[role="menu"]'), 'picker menu')
  menu.focus()
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await frame()
  if (picker.querySelector('[role="menu"]')) throw new Error('Escape did not close the picker menu')
  if (document.activeElement !== trigger) {
    const active = document.activeElement
    throw new Error('focus was not restored to the picker trigger; active=' + (active ? active.tagName + '.' + active.className : 'none') + ' trigger=' + trigger.tagName + '.' + trigger.className)
  }

  // 选中另一个 Provider：选择交给拥有者，菜单自行关闭。
  trigger.click()
  await frame()
  const reopened = must(picker.querySelector('[role="menu"]'), 'reopened picker menu')
  must(reopened.querySelector('[data-agent-id="codex"]'), 'codex row').click()
  await frame()
  if (picker.querySelector('[role="menu"]')) throw new Error('selecting a provider did not close the menu')
  if (picker.querySelector('button[aria-label], button').textContent.includes('Rotom')) throw new Error('trigger still shows the previous provider')

  // 归档筛选：同一套单选语义，触发按钮显示当前值。
  stage = 'filter'
  const filterTrigger = must(filter.querySelector('.arch-provider-trigger'), 'filter trigger')
  if (filter.querySelector('[role="menu"]')) throw new Error('the filter menu must start closed')
  filterTrigger.click()
  await frame()
  const filterRows = filter.querySelectorAll('[role="menuitemradio"]')
  const filterChecked = [...filterRows].filter((row) => row.getAttribute('aria-checked') === 'true')
  if (filterRows.length !== 4) throw new Error('expected 4 filter rows (all + 3 providers), got ' + filterRows.length)
  if (filterChecked.length !== 1 || filterChecked[0].dataset.providerOption !== 'claude') {
    throw new Error('filter must check exactly claude, got ' + filterChecked.map((row) => row.dataset.providerOption))
  }
  // 触发按钮显示 PROVIDER_LABELS 里的正式名称，不是 provider id。
  if (filterTrigger.textContent.trim() !== 'Claude Code') throw new Error('filter trigger label ' + filterTrigger.textContent.trim())
  const filterBrands = [...filter.querySelectorAll('.arch-provider-menu .provider-glyph')].map((glyph) => glyph.dataset.provider)
  if (filterBrands.join(',') !== 'claude,codex,pi') throw new Error('filter brand glyphs ' + filterBrands.join(','))
  // “全部 Provider”不是某个品牌，不能冒充成 Provider 图标。
  if (filter.querySelector('.arch-provider-menu [role="menuitemradio"]').querySelector('.provider-glyph')) {
    throw new Error('the all-providers row must not show a brand glyph')
  }
  must(filter.querySelector('[data-provider-option="codex"]'), 'filter codex row').click()
  await frame()
  if (filter.querySelector('[role="menu"]')) throw new Error('filter menu stayed open after picking a provider')
  if (filterTrigger.textContent.trim() !== 'Codex') throw new Error('filter trigger label after picking: ' + filterTrigger.textContent.trim())

  return {
    metrics,
    rows: rows.length,
    brands: brands.map((brand) => brand.provider + ':' + brand.width + 'x' + brand.height + ':' + brand.color),
    filterRows: filterRows.length,
    filterTrigger: filterTrigger.textContent.trim()
  }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error',
    worker: { format: 'es' },
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: {
        entry: join(root, 'scripts/fixtures/provider-menu-smoke.tsx'),
        formats: ['iife'],
        name: 'ScryProviderMenu',
        fileName: () => 'fixture.js',
        cssFileName: 'fixture'
      }
    }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, width: 900, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('Renderer:', event.message) })
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        // 截图在交互前：菜单还开着，用于人工核对品牌标与对勾列。
        const shot = ${JSON.stringify(process.env.SCRY_PROVIDER_MENU_SCREENSHOT ?? '')}
        if (shot) {
          await new Promise((resolve) => setTimeout(resolve, 300))
          await win.webContents.capturePage().then((image) => require('node:fs').writeFileSync(shot, image.toPNG()))
        }
        const result = await win.webContents.executeJavaScript(${JSON.stringify(`(${exerciseProviderMenus.toString()})().catch(error => ({ error: String(error && error.message), stack: String(error && error.stack) }))`)})
        if (result && result.error) { console.error(result.stack); app.exit(1); return }
        process.stdout.write('SCRY_UI_SMOKE_RESULT=' + JSON.stringify(result) + '\\n', () => app.exit(0))
      } catch (error) { console.error(error); app.exit(1) }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  const result = await runUiCampaign({
    electron,
    script: join(temp, 'main.cjs'),
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }
  })
  console.log(JSON.stringify(result))
} finally {
  await rm(temp, { recursive: true, force: true })
}
