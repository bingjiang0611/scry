// Which build a process runs (A5). The package version alone cannot tell two builds
// apart: `npm run install:mac:dev` rebuilds and reinstalls without bumping it, and a
// daemon that outlived the App kept answering with the same version while running the
// previous build's code. The App and its daemon therefore compare the version AND the
// build id, and either one differing is a version mismatch.
//
// The build id is the source hash electron.vite.config.ts computes once, at build time
// (performance-build-id.ts), and writes into the main bundle with `define`. Every main
// entry, the daemon and its supervisor included, comes from that one build, so the App
// and a daemon launched from the same `out/` or asar carry the same value. Reading it
// costs nothing at runtime: no hashing, no file access.
//
// Unbundled code (unit tests) has no build id: both sides then compare versions only,
// and a process that has one never matches one that does not (fail closed).

declare const __SCRY_BUILD_ID__: string | undefined

export interface BuildIdentity {
  version: string
  build?: string
}

const BUILD_ID = /^[0-9a-f]{7,64}$/

/** A build id from the wire, or undefined when it is not one. */
export function buildIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && BUILD_ID.test(value) ? value : undefined
}

/** This bundle's build id; undefined when the code was not built by electron-vite. */
export function scryBuildId(): string | undefined {
  return buildIdOf(typeof __SCRY_BUILD_ID__ === 'string' ? __SCRY_BUILD_ID__ : undefined)
}

/** This process as the other side should see it. */
export function buildIdentity(version: string, build: string | undefined = scryBuildId()): BuildIdentity {
  return build === undefined ? { version } : { version, build }
}

export function sameBuild(expected: BuildIdentity, running: BuildIdentity): boolean {
  return expected.version === running.version && expected.build === running.build
}

const shortBuild = (build: string | undefined): string => build === undefined ? '构建号未知' : build.slice(0, 7)

/**
 * The two labels a mismatch is shown with. Different versions are shown as versions;
 * the same version from different builds is shown as `0.2.237 (abcd123)` on both sides,
 * since the version alone would read as "nothing differs". `running` stays null when the
 * daemon refused before saying which version it is.
 */
export function mismatchLabels(running: { version: string | null; build?: string }, expected: BuildIdentity): { running: string | null; expected: string } {
  if (running.version === null || running.version !== expected.version) return { running: running.version, expected: expected.version }
  return {
    running: `${running.version} (${shortBuild(running.build)})`,
    expected: `${expected.version} (${shortBuild(expected.build)})`
  }
}
