import { describe } from 'vitest'
import { registerSuite1 } from './managed-turn-tests/coordinator-1.test'
import { registerSuite2 } from './managed-turn-tests/coordinator-2.test'
import { registerSuite3 } from './managed-turn-tests/coordinator-3.test'
import { registerSuite4 } from './managed-turn-tests/coordinator-4.test'

// Keep the original single-suite worker, registration order and shared cleanup.
describe('managed trace turn coordinator', () => {
  registerSuite1()
  registerSuite2()
  registerSuite3()
  registerSuite4()
})
