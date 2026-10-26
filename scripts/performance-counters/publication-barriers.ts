import { strict as assert } from 'node:assert'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'

export type PublicationOperation = {
  kind: 'mkdir' | 'link' | 'rm' | 'file-sync' | 'directory-sync'
  path: string
  from?: string
}

/** Check durability dependencies, not how many times a shared parent was synced. */
export function assertPublicationBarriers(operations: PublicationOperation[], paths: string[]): void {
  assert.deepEqual(operations.filter(op => op.kind === 'link').map(op => op.path), paths)
  for (const path of paths) {
    const published = operations.findIndex(op => op.kind === 'link' && op.path === path)
    const temporary = operations[published].from!
    assert(operations.some((op, index) => index < published && op.kind === 'file-sync' && op.path === temporary), 'file bytes must sync before publication')
    const directory = resolve(dirname(path))
    let parent = parse(directory).root
    for (const part of relative(parent, directory).split(sep).filter(Boolean)) {
      const child = join(parent, part)
      const created = operations.findIndex(op => op.kind === 'mkdir' && op.path === child)
      assert(operations.some((op, index) => index > created && index < published && op.kind === 'directory-sync' && op.path === parent), `parent must sync after creation and before publication: ${child}`)
      parent = child
    }
    const removed = operations.findIndex(op => op.kind === 'rm' && op.path === temporary)
    assert(removed > published, 'temporary link must survive publication')
    assert(operations.some((op, index) => index > published && index < removed && op.kind === 'directory-sync' && op.path === directory), 'published link must sync before temporary removal')
    assert(operations.some((op, index) => index > removed && op.kind === 'directory-sync' && op.path === directory), 'temporary removal must sync before return')
  }
}
