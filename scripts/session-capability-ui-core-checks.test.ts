import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

it('times out without re-evaluating a predicate whose target disappeared', async () => {
  const source = ts.createSourceFile('core.mjs', readFileSync(new URL('./session-capability-ui-core-checks.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const entry = source.statements.find(ts.isFunctionDeclaration)
  const initializer = entry?.body?.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => declaration.name.getText(source) === 'waitFor')?.initializer
  if (!initializer) throw new Error('Missing production waitFor helper')

  let deadline: (() => void) | undefined
  const disconnect = vi.fn()
  const document = { body: {}, activeElement: null, hasFocus: () => false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  const waitFor = runInNewContext(`(${initializer.getText(source)})`, {
    document, Error, Promise,
    MutationObserver: class { observe() {} disconnect = disconnect },
    setTimeout: (callback: () => void) => { deadline = callback; return 1 },
    clearTimeout: vi.fn()
  }) as (predicate: () => boolean) => Promise<void>
  const predicate = vi.fn<() => boolean>().mockReturnValueOnce(false).mockImplementation(() => { throw new Error('target disappeared') })
  const result = waitFor(predicate).then(() => ({ status: 'resolved' }), (error: unknown) => ({ status: 'rejected', error }))
  expect(deadline).toBeTypeOf('function')
  deadline!()
  expect(await result).toMatchObject({ status: 'rejected', error: { message: expect.stringContaining('DOM condition timed out') } })
  expect(predicate).toHaveBeenCalledOnce()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(document.removeEventListener).toHaveBeenCalledWith('focusin', expect.any(Function), true)
})
