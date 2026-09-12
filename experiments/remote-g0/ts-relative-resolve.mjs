import { register } from 'node:module'

// Test-harness aid only. The app is built with moduleResolution:"bundler", so
// its TypeScript uses extensionless relative imports (e.g. './session-ledger').
// Node's native type-stripping loader does not resolve those to a .ts file, so
// this registers a resolve hook that appends '.ts' for an extensionless relative
// specifier when that file exists. It is used solely to run the Node smokes
// against the real src/main/remote modules; it changes no production behavior.
register('./ts-relative-resolve-hooks.mjs', import.meta.url)
