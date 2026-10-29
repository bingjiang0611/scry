import sqlite from './vitest.sqlite.config'
import { fileURLToPath } from 'node:url'

// IO-fault suites must register their own filesystem mocks before FileStore
// loads. The optional method meter imports FileStore eagerly, so omit it here.
export default { ...sqlite, test: { ...sqlite.test,
  setupFiles: [fileURLToPath(new URL('./sqlite-setup.ts', import.meta.url))]
} }
