
declare const __SCRY_BUILD_ID__: string | undefined
declare const __SCRY_APP_VERSION__: string | undefined

export interface BuildIdentity {
  version: string
  build?: string
}

const BUILD_ID = /^[0-9a-f]{7,64}$/

export function buildIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && BUILD_ID.test(value) ? value : undefined
}

export function scryBuildId(): string | undefined {
  return buildIdOf(typeof __SCRY_BUILD_ID__ === 'string' ? __SCRY_BUILD_ID__ : undefined)
}

export function scryBundleVersion(): string | undefined {
  const value = typeof __SCRY_APP_VERSION__ === 'string' ? __SCRY_APP_VERSION__ : undefined
  return value?.trim() ? value : undefined
}

export function buildIdentity(version: string, build: string | undefined = scryBuildId()): BuildIdentity {
  return build === undefined ? { version } : { version, build }
}

export function sameBuild(expected: BuildIdentity, running: BuildIdentity): boolean {
  return expected.version === running.version && expected.build === running.build
}

const shortBuild = (build: string | undefined): string => build === undefined ? '构建号未知' : build.slice(0, 7)

export function mismatchLabels(running: { version: string | null; build?: string }, expected: BuildIdentity): { running: string | null; expected: string } {
  if (running.version === null || running.version !== expected.version) return { running: running.version, expected: expected.version }
  return {
    running: `${running.version} (${shortBuild(running.build)})`,
    expected: `${expected.version} (${shortBuild(expected.build)})`
  }
}
