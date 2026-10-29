import { fileURLToPath } from 'node:url'
import base from '../../vitest.config'

export default {
  ...base,
  test: {
    ...base.test,
    setupFiles: [fileURLToPath(new URL('./measure-setup.ts', import.meta.url))],
    reporters: ['default', 'json'],
    outputFile: process.env.SCRY_CHECKPOINT_RESULT
  }
}
