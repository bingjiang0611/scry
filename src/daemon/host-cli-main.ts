import { createInterface } from 'node:readline/promises'
import { ensureShellEnv } from '../main/shell'
import { runHostCli } from './host-cli'

// Bundled entry (`out/main/host-cli.js`) launched by `<resources>/bin/scry-host`
// with `ELECTRON_RUN_AS_NODE=1`. No Electron imports.

ensureShellEnv()

const exitCode = await runHostCli(process.argv.slice(2), {
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  stdout: (text) => { process.stdout.write(text) },
  stderr: (text) => { process.stderr.write(text) },
  prompt: async (question: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  }
})

process.exit(exitCode)
