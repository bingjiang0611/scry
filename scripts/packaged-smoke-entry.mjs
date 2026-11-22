import { constants, cpSync, createReadStream, lstatSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import asar from '@electron/asar'
import { packagedAppLayout } from './packaged-app-layout.mjs'

const ENTRY = 'scry-smoke-entry.mjs'

export async function addPackagedSmokeEntry(source, target, entry, extracted) {
  asar.extractAll(source, extracted)
  const manifest = join(extracted, 'package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  writeFileSync(manifest, JSON.stringify({ ...pkg, main: ENTRY }))
  cpSync(entry, join(extracted, ENTRY), { errorOnExist: true, force: false })
  const entries = asar.listPackage(source).map(path => {
    const name = path.slice(1)
    const entry = asar.statFile(source, name, false)
    return makeStream(extracted, name, entry.unpacked === true)
  })
  entries.push(makeStream(extracted, ENTRY, false))
  await asar.createPackageFromStreams(target, entries)
}

function makeStream(extracted, path, unpacked) {
  const file = join(extracted, path)
  const stat = lstatSync(file)
  if (stat.isDirectory()) return { path, type: 'directory', unpacked }
  const stream = { path, stat, unpacked, streamGenerator: () => createReadStream(file) }
  return stat.isSymbolicLink()
    ? { ...stream, type: 'link', symlink: readlinkSync(file) }
    : { ...stream, type: 'file' }
}

// The instrumented fixture is a private copy. The shipped package remains available
// for its own unmodified package checks and smokes.
export async function preparePackagedSmokeEntry(appPath, fixtureAppPath, entry, temp) {
  const original = packagedAppLayout(appPath)
  const fixture = packagedAppLayout(fixtureAppPath)
  cpSync(appPath, fixtureAppPath, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true })
  const archive = join(temp, 'fixture.asar')
  await addPackagedSmokeEntry(join(original.resources, 'app.asar'), archive, entry, join(temp, 'app-extracted'))
  // Reuse the copied .asar.unpacked files. Only the packed entry and manifest change.
  renameSync(archive, join(fixture.resources, 'app.asar'))
  return fixture.executable
}
