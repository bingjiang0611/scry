// Bundle a live-verify host (which pulls in the REAL provider chain, whose
// TypeScript uses decorators / parameter properties that Node's strip-only
// loader rejects) into a single runnable ESM file via esbuild. node_modules stay
// external (required normally at runtime). A tiny plugin maps NodeNext '.js'
// relative specifiers to their '.ts' sources so src/shared + providers resolve.
//   node build-live-host.mjs <entry.mjs> <out.mjs>
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const [entry, out] = process.argv.slice(2)
if (!entry || !out) { console.error('usage: node build-live-host.mjs <entry> <out>'); process.exit(2) }

const tsResolve = {
  name: 'js-to-ts',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (args.kind === 'entry-point') return
      const baseDir = args.resolveDir || dirname(fileURLToPath(import.meta.url))
      const abs = resolvePath(baseDir, args.path)
      // Only remap relative specifiers that target a sibling .ts source.
      const jsMatch = args.path.match(/\.([cm]?)js$/)
      if (jsMatch) {
        for (const cand of [abs.replace(/\.[cm]?js$/, `.${jsMatch[1]}ts`), abs.replace(/\.[cm]?js$/, '.ts')]) {
          if (existsSync(cand)) return { path: cand }
        }
      } else if (!/\.[cm]?[jt]s$/.test(args.path)) {
        for (const cand of [abs + '.ts', abs + '.mts', resolvePath(abs, 'index.ts')]) {
          if (existsSync(cand)) return { path: cand }
        }
      }
      return
    })
  }
}

await build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: 'inline',
  logLevel: 'info',
  plugins: [tsResolve]
})
console.log(`[build] bundled ${entry} -> ${out}`)
