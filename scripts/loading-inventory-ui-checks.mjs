export async function exerciseInventoryLoading({ read, wait, check, click, screenshot, settle }) {
  const failures = []
for (const legacy of [true, false]) for (const kind of ['skills', 'mcp']) {
  const label = `${legacy ? 'legacy' : 'capabilities'}-${kind}`
  const missing = kind === 'skills' ? '没能读取 Skill 清单' : '没能读取 MCP 配置'
  const empty = legacy ? kind === 'skills' ? '未发现项目 Skill' : '未发现 MCP 配置' : kind === 'skills' ? '当前来源没有 Skill' : '当前来源没有 MCP'
  const modal = '.modal-overlay [role="dialog"]'
  const body = `${modal} .inventory-modal__body, ${modal} .capabilities-body`
  const status = `${modal} .inventory-empty[role="status"], ${modal} .capabilities-body .empty-state`
  const invalidEvidence = `(() => { const el = document.querySelector(${JSON.stringify(modal)}); return /(^|[^0-9])0([^0-9]|$)/.test(el.textContent) || !!el.querySelector('.inventory-empty, .capabilities-body .empty-state') })()`
  const before = await read(`window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).length`)
  await read(`window.loadingFixture.configure(400, true); window.loadingFixture.inventory(${JSON.stringify(kind)}, ${legacy})`)
  await wait(`document.querySelector(${JSON.stringify(modal)})`)
  await settle()
  check(!await read(invalidEvidence), `${label} showed failed or empty evidence before a read started`)
  check(await read(`window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).length===${before}`), `${label} started reading before the existing request trigger`)
  await read('window.loadingFixture.startInventory()')
  await wait(`document.querySelector(${JSON.stringify(body)})?.getAttribute('aria-busy')==='true'`)
  check(!await read(invalidEvidence), `${label} showed failed or empty evidence during a read`)
  await wait(`document.querySelector(${JSON.stringify(modal + ' .skeleton-rows')})`)
  await wait(`document.querySelector(${JSON.stringify(status)})?.textContent.includes(${JSON.stringify(missing)})`)
  check(await read(`(() => { const el=document.querySelector(${JSON.stringify(modal)}); return !el.querySelector('.skeleton-rows') && !/(^|[^0-9])0([^0-9]|$)/.test(el.textContent) && document.querySelector(${JSON.stringify(body)}).getAttribute('aria-busy')==='false' })()`), `${label} retained loading rows, busy flag or false zero after rejection`)
  check(await read(`window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).slice(${before}).length===1 && window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).at(-1).failed===true`), `${label} did not reject exactly one real read`)
  await screenshot(`${label}-failed`)
  await read('window.loadingFixture.configure(400, false)')
  await click(legacy ? `${modal} .modal-refresh` : kind === 'skills' ? `${modal} .capabilities-body .empty-state[role=alert] button` : `${modal} .capabilities-head .capabilities-refresh`)
  await wait(`document.querySelector(${JSON.stringify(body)})?.getAttribute('aria-busy')==='true'`)
  check(!await read(`document.querySelector(${JSON.stringify(modal)}).textContent.includes(${JSON.stringify(missing)})`), `${label} kept the failure message during retry`)
  await wait(`document.querySelector(${JSON.stringify(body)})?.getAttribute('aria-busy')==='false' && document.querySelector(${JSON.stringify(status)}) && !document.querySelector(${JSON.stringify(modal)}).textContent.includes(${JSON.stringify(missing)})`)
  check(await read(`document.querySelector(${JSON.stringify(status)}).textContent.includes(${JSON.stringify(empty)}) && !document.querySelector(${JSON.stringify(modal + ' .skeleton-rows')}) && window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).slice(${before}).length===2 && window.loadingFixture.records.filter(r=>r.kind===${JSON.stringify(kind)}).at(-1).failed===false`), `${label} did not show a successful empty result after native refresh`)
  failures.push(label)
  await read('window.loadingFixture.closeInventory()')
  await wait("!document.querySelector('.modal-overlay')")
}
  return failures
}
