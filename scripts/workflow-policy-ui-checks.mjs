import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

/** Renderer-only contract fixture: policy provenance is injected data, not a
 * claim that this fake bridge executed the production policy or stopped a run. */
export async function checkWorkflowAutomaticStop({ read, wait, click, win }) {
  const selector = '[data-workflow-node-kind=attempt][data-workflow-target=attempt]'
  await read('window.workflowFixture.installAutomaticReceipt(); window.workflowFixture.rehydrate()')
  await wait('document.querySelector("[data-workflow-target=attempt]")?.textContent === "再次停止该节点"')
  await click('[data-workflow-id=ui-workflow] summary')
  assert.equal(await read('document.querySelector("[data-workflow-target=attempt]").closest(".workflow-node-stop").textContent.includes("策略自动请求停止")'), true)
  win.setSize(430, 900)
  await wait('innerWidth === 430')
  await read('document.querySelector("[data-workflow-target=attempt]").scrollIntoView({block:"center"})')
  assert.equal(await read('document.documentElement.scrollWidth <= innerWidth'), true, 'maximum-length trigger identity must not overflow the page')
  assert.equal(await read('document.querySelector(".workflow-progress").scrollLeft'), 0, 'table navigation must not displace root controls or source time')
  assert.equal(await read('document.querySelector("[data-workflow-target=attempt]").closest(".workflow-table-scroll").scrollWidth > document.querySelector("[data-workflow-target=attempt]").closest(".workflow-table-scroll").clientWidth'), true, 'dense evidence owns its horizontal scroll region')
  assert.equal(await read('document.querySelector("[data-workflow-target=attempt]").closest("tr").cells[0].getBoundingClientRect().width >= 50'), true, 'node identity must not collapse into a one-letter column')
  await writeFile('/tmp/scry-workflow-auto-stop.png', (await win.webContents.capturePage()).toPNG())
  await click(selector)
  await wait('window.workflowFixture.counters.nodeStops === 5')
  assert.equal(await read('window.workflowFixture.nodeCommands[4].commandId !== "automatic-policy-receipt"'), true, 'a policy receipt is not a user stop command')
  await read('window.workflowFixture.finishNodeStop(true)')
  await wait('document.querySelector("[data-workflow-target=attempt]").textContent === "重试原停止请求"')
  await click(selector)
  await wait('window.workflowFixture.counters.nodeStops === 6 && document.querySelector("[data-workflow-target=attempt]").textContent === "再次停止该节点"')
  assert.equal(await read('window.workflowFixture.nodeCommands[4].commandId === window.workflowFixture.nodeCommands[5].commandId'), true, 'an unknown user reply retains its new user identity')
  assert.equal(await read('window.workflowFixture.counters.nodeRecorded'), 4)
  assert.equal(await read('window.workflowFixture.counters.stops'), 0)
}
