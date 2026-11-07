import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  configureRecorderCliRuntime,
  packagedRecorderCliPath,
  resolveRecorderCliPath,
  resolveTrustRecorderCliPath,
  runtimeCliEnv
} from './claude-locate'

describe('recorder CLI runtime source', () => {
  it('pins scry from the original PATH without prepending a fixed Qoder Node directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-cli-path-'))
    try {
      const scry = join(dir, 'scry')
      writeFileSync(scry, '#!/bin/sh\n')
      chmodSync(scry, 0o755)
      const env = runtimeCliEnv({ PATH: `${dir}:/usr/bin:/bin` })
      expect(env.SCRY_CLI_PATH).toBe(scry)
      expect(env.PATH).toBe(`${dir}:/usr/bin:/bin`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers the App-private recorder CLI over PATH and fallback installations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-bundled-cli-'))
    try {
      const resources = join(dir, 'Scry.app', 'Contents', 'Resources')
      const bundled = join(resources, 'bin', 'scry')
      const external = join(dir, 'external', 'scry')
      mkdirSync(dirname(bundled), { recursive: true })
      mkdirSync(dirname(external), { recursive: true })
      writeFileSync(bundled, '#!/bin/sh\n')
      writeFileSync(external, '#!/bin/sh\n')
      chmodSync(bundled, 0o755)
      chmodSync(external, 0o755)

      expect(packagedRecorderCliPath(resources)).toBe(bundled)
      expect(resolveRecorderCliPath({ PATH: dirname(external) }, dirname(external), '', bundled)).toBe(bundled)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses daemon resources in real resolution when process resources are absent and PATH has a fake scry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-daemon-recorder-'))
    try {
      const resources = join(dir, 'resources')
      const bundled = join(resources, 'bin', 'scry')
      const fake = join(dir, 'fake', 'scry')
      mkdirSync(dirname(bundled), { recursive: true })
      mkdirSync(dirname(fake), { recursive: true })
      writeFileSync(bundled, '#!/bin/sh\n')
      writeFileSync(fake, '#!/bin/sh\n')
      chmodSync(bundled, 0o755)
      chmodSync(fake, 0o755)
      configureRecorderCliRuntime({ resourcesPath: resources, requirePrivateCli: true })

      expect(resolveRecorderCliPath({ PATH: dirname(fake) }, dirname(fake), '', packagedRecorderCliPath())).toBe(bundled)
      expect(runtimeCliEnv({ PATH: dirname(fake) }).SCRY_CLI_PATH).toBe(bundled)
      expect(resolveTrustRecorderCliPath({ PATH: dirname(fake), SCRY_CLI_PATH: fake })).toBe(bundled)
    } finally {
      configureRecorderCliRuntime(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed instead of falling back to PATH when a packaged daemon private CLI is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-daemon-recorder-missing-'))
    try {
      const fake = join(dir, 'fake', 'scry')
      mkdirSync(dirname(fake), { recursive: true })
      writeFileSync(fake, '#!/bin/sh\n')
      chmodSync(fake, 0o755)
      expect(() => configureRecorderCliRuntime({ resourcesPath: join(dir, 'resources'), requirePrivateCli: true }))
        .toThrow('daemon_recorder_cli_unavailable')
    } finally {
      configureRecorderCliRuntime(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
