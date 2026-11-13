import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { exercisePiCommands } from './session-pi-commands-ui-check.mjs'

describe('Pi native restart readiness', () => {
  const loop = exercisePiCommands.toString().split('for (const cancelInput of [false, true])')[1]
  const condition = loop.match(/await wait\(`([^`]+)`\)/)?.[1]

  it.each([
    { name: 'preceding confirmation with two options', menu: false, answers: [{}], ready: false },
    { name: 'menu before its previous answers reset', menu: true, answers: [{}], ready: false },
    { name: 'committed reset menu', menu: true, answers: [], ready: true }
  ])('recognizes $name', ({ menu, answers, ready }) => {
    expect(condition).toBeDefined()
    const controls = new Map([
      ['#pi-command .question-other', menu ? {} : null],
      ['#pi-command-answers', { textContent: JSON.stringify(answers) }]
    ])
    const document = {
      querySelectorAll: () => [{}, {}],
      querySelector: (selector: string) => controls.get(selector)
    }
    expect(runInNewContext(condition!, { document })).toBe(ready)
  })
})
