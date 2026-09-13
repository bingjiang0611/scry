import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Map a relative specifier to a sibling TypeScript source when it exists:
//   - extensionless  './foo'    -> './foo.ts'
//   - NodeNext '.js' './foo.js'  -> './foo.ts' (also .mjs/.cjs -> .mts/.cts/.ts)
// The '.js' remap is what lets NodeNext sources under src/shared and the
// provider chain (which import with explicit '.js') load under the .ts hooks.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL) {
    const tryUrls = []
    if (!/\.[cm]?[jt]s$/.test(specifier)) {
      tryUrls.push(specifier + '.ts')
    } else {
      const m = specifier.match(/\.([cm]?)js$/)
      if (m) { tryUrls.push(specifier.replace(/\.[cm]?js$/, `.${m[1]}ts`), specifier.replace(/\.[cm]?js$/, '.ts')) }
    }
    for (const rel of tryUrls) {
      try {
        const candidate = new URL(rel, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
      } catch { /* fall through */ }
    }
  }
  return next(specifier, context)
}
