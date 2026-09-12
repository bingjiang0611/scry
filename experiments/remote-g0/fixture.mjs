import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Test-only, preissued identities. This is not onboarding or a production CA.
// Keys are scoped to an OS temporary directory and removed by the caller.
export async function certificates() {
  const directory = await mkdtemp(join(tmpdir(), 'scry-g0-'))
  await chmod(directory, 0o700)
  const path = name => join(directory, name)
  async function openssl(args) {
    await exec('openssl', args, { cwd: directory, timeout: 15_000, maxBuffer: 1024 * 1024 })
  }
  try {
    for (const name of ['outer-ca', 'inner-ca', 'wrong-ca']) {
      await openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-noenc', '-days', '1',
        '-subj', '/CN=Scry G0 ' + name, '-keyout', name + '.key', '-out', name + '.pem',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
      await chmod(path(name + '.key'), 0o600)
    }
    for (const [name, ca, usage, hostname] of [
      ['outer', 'outer-ca', 'serverAuth', 'localhost'],
      ['host', 'inner-ca', 'serverAuth', 'scry-host.test'],
      ['device', 'inner-ca', 'clientAuth', 'scry-device.test'],
      ['impostor', 'wrong-ca', 'clientAuth', 'scry-device.test']
    ]) {
      await openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-noenc',
        '-subj', '/CN=' + hostname, '-keyout', name + '.key', '-out', name + '.csr'])
      await chmod(path(name + '.key'), 0o600)
      await writeFile(path(name + '.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${usage}\nsubjectAltName=DNS:${hostname}\n`)
      await openssl(['x509', '-req', '-in', name + '.csr', '-CA', ca + '.pem', '-CAkey', ca + '.key',
        '-CAcreateserial', '-days', '1', '-extfile', name + '.ext', '-out', name + '.pem'])
    }
    return { path, read: name => readFile(path(name)), cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}
