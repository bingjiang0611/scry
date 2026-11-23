import { constants } from 'node:fs'
import { access } from 'node:fs/promises'

export const hookTreeTimeBinary = '/usr/bin/time'

export async function requireHookTreeTimer(path = hookTreeTimeBinary) {
  try {
    await access(path, constants.X_OK)
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error
    throw new Error(`Whole Hook-tree timing requires an executable time binary at ${path}. Install /usr/bin/time before running this benchmark.`, { cause: error })
  }
}
