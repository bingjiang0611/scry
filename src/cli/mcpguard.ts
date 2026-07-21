#!/usr/bin/env node
import { runCli } from './mcpguard-core.js'

try {
  const result = runCli(process.argv.slice(2), { cwd: process.cwd(), env: process.env })
  if (result.text) process.stdout.write(result.text)
  process.exitCode = result.exitCode
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`mcpguard: ${message}\n`)
  process.exitCode = 1
}
