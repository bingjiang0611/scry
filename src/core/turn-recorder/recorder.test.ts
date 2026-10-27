import { describe } from 'vitest'
import { registerSuite1 } from './recorder-tests/state-machine-1.test'
import { registerSuite2 } from './recorder-tests/state-machine-2.test'
import { registerSuite3 } from './recorder-tests/state-machine-3.test'
import { registerSuite4 } from './recorder-tests/state-machine-4.test'
import { registerSuite5 } from './recorder-tests/state-machine-5.test'
import { registerSuite6 } from './recorder-tests/state-machine-6.test'
import { registerSuite7 } from './recorder-tests/state-machine-7.test'
import { registerSuite8 } from './recorder-tests/merge.test'
import { registerSuite9 } from './recorder-tests/codex-1.test'
import { registerSuite10 } from './recorder-tests/codex-2.test'
import { registerSuite11 } from './recorder-tests/codex-3.test'
import { registerSuite12 } from './recorder-tests/codex-4.test'
import { registerSuite13 } from './recorder-tests/store-1.test'
import { registerSuite14 } from './recorder-tests/store-2.test'
import { registerSuite15 } from './recorder-tests/store-3.test'
import { registerSuite16 } from './recorder-tests/opencode.test'
import { registerSuite17 } from './recorder-tests/nested-git.test'
import { registerSuite18 } from './recorder-tests/trust.test'
import { registerSuite19 } from './recorder-tests/delivery-budget.test'
import { registerSuite20 } from './recorder-tests/archive.test'
import { registerSuite21 } from './recorder-tests/sequence-reuse.test'

// Keep the original single-suite worker, registration order and shared cleanup.
describe('turn recorder state machine', () => {
  registerSuite1()
  registerSuite2()
  registerSuite3()
  registerSuite4()
  registerSuite5()
  registerSuite6()
  registerSuite7()
})

registerSuite8()

describe('Codex rollout recorder evidence', () => {
  registerSuite9()
  registerSuite10()
  registerSuite11()
  registerSuite12()
})

describe('record store cursor and recovery semantics', () => {
  registerSuite13()
  registerSuite14()
  registerSuite15()
})

registerSuite16()

registerSuite17()

registerSuite18()

registerSuite19()

registerSuite20()
registerSuite21()
