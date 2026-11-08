import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('restores the tested child after keyboard tab activation before composition and injection checks', () => {
  const layout = readFileSync(new URL('./side-chat-layout-checks.mjs', import.meta.url), 'utf8')
  const input = readFileSync(new URL('./side-chat-input-checks.mjs', import.meta.url), 'utf8')
  const composition = input.slice(input.indexOf('// 6. Real IME'), input.indexOf('const beforeComposition'))
  expect(composition).toMatch(/await showChild\(\)[\s\S]*?await click\(CHILD_COMPOSER\)/)
  expect(layout).toMatch(/check\(tabKeys.every[\s\S]*?await exerciseSideChatInput\(/)
  expect(layout).toContain("?.dataset.sideChatId === ${json(childId)}")
})
