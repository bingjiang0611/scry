import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function exerciseCheckFixDraft({ evaluate, click, button, replace, source, wait, capture, fixture }) {
  await click('.workflow-check-fix-draft summary')
  await replace('.workflow-check-fix-draft textarea', '{bad json')
  await button('创建项目检查修复草稿')
  await wait(() => evaluate(`Boolean(document.querySelector('.workflow-check-fix-draft [role="alert"]'))`), 'invalid command rejected')
  assert.equal(await evaluate(`Boolean(document.querySelector('.workflow-template-source'))`), false)
  const argv = [process.execPath, 'check.cjs']
  await replace('.workflow-check-fix-draft textarea', JSON.stringify(argv))
  await button('创建项目检查修复草稿')
  await wait(() => evaluate(`Boolean(document.querySelector('.workflow-template-source') && document.querySelector('.workflow-template-structure')?.textContent.includes('firstCheck'))`), 'validated project check-fix candidate')
  const text = await source(), definition = JSON.parse(text)
  const path = join(fixture.workspace, '.scry-workflows', definition.templateId + '.json')
  assert.deepEqual(definition.body.blocks.map(block => block.blockId), ['copy', 'firstCheck', 'decide', 'finish'])
  assert.deepEqual(definition.body.blocks[1].check.argv, argv)
  assert.equal(definition.body.blocks[1].authorization, undefined)
  assert.equal(definition.body.blocks[2].when.right.value, 'failed')
  assert.equal(definition.body.blocks[2].then.blocks[0].replica.name, 'copy')
  await assert.rejects(readFile(path), error => error.code === 'ENOENT')
  await button('预览保存差异')
  assert.equal(await evaluate(`document.querySelector('.workflow-template-review button:last-child').disabled`), true)
  await click('.workflow-template-review input[type="checkbox"]')
  assert.equal(await evaluate(`document.querySelector('.workflow-template-review button:last-child').disabled`), true, 'project disclosure is independently required')
  await click('.workflow-template-review label:last-of-type input[type="checkbox"]')
  await button('确认写入此修订')
  await wait(async () => { try { return (await readFile(path, 'utf8')) === text } catch (error) { if (error.code === 'ENOENT') return false; throw error } }, 'reviewed project source published')
  await capture('workflow-check-fix-project-draft')
  await button('模板库')
  return { projectTemplateId: definition.templateId, invalidCommandRejected: true, noRepairBeforeFirstCheck: true, projectReviewRequired: true, exactPublishedSource: true }
}
