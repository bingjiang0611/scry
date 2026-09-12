import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Map an extensionless relative specifier to a sibling '.ts' file when it exists.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
    try {
      const candidate = new URL(specifier + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
    } catch { /* fall through to the default resolver */ }
  }
  return next(specifier, context)
}
