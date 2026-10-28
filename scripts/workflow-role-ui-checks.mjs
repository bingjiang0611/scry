import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

export async function checkWorkflowRoleConfiguration({ read, wait, win, choose }) {
  await read('document.querySelector("[data-workflow-role=orchestrator] select").focus()')
  choose('p')
  await wait('document.querySelector("[data-workflow-role=orchestrator] select").value === "pi:fixture"')
  await wait('document.querySelectorAll("[data-workflow-role=orchestrator] select")[2].options.length === 2')
  assert.equal(await read('document.querySelector("[data-workflow-action=plan]").disabled'), true)
  await read('document.querySelectorAll("[data-workflow-role=orchestrator] select")[2].focus()')
  choose('e')
  await wait('document.querySelectorAll("[data-workflow-role=orchestrator] select")[2].value === "full_access"')
  await read('document.querySelectorAll("[data-workflow-role=orchestrator] select")[1].focus()')
  choose('e')
  await wait('!document.querySelector("[data-workflow-action=plan]").disabled')
  await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  await writeFile('/tmp/scry-workflow-m0-ui-config-wide.png', (await win.webContents.capturePage()).toPNG())
  win.setSize(430, 900)
  await wait('innerWidth === 430')
  await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  assert.equal(await read('Array.from(document.querySelectorAll(".workflow-role")).every(e=>e.getBoundingClientRect().right <= innerWidth)'), true)
  await writeFile('/tmp/scry-workflow-m0-ui-config-narrow.png', (await win.webContents.capturePage()).toPNG())
  win.setSize(1280, 960)
  await wait('innerWidth === 1280')
}
