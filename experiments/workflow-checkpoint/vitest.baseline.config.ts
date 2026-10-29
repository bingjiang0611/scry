import { fileURLToPath } from 'node:url'
import base from '../../vitest.config'

export default {
  ...base,
  test: {
    ...base.test,
    exclude: base.test!.exclude!.filter(pattern => pattern !== '**/experiments/**'),
    setupFiles: ['io-meter-setup.ts', 'measure-setup.ts'].map(name => fileURLToPath(new URL(name, import.meta.url))),
    reporters: ['default', 'json'],
    outputFile: process.env.SCRY_CHECKPOINT_RESULT
  }
}
