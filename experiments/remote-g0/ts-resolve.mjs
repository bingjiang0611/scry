// Resolve hook for smokes that run TypeScript sources with Node's type stripping. App
// sources import sibling modules without an extension (the bundler resolves them, and
// tsconfig does not allow `.ts` specifiers); Node's ESM resolver does not. Only a
// relative specifier that Node could not find and that names no extension is retried
// with `.ts`; everything else resolves exactly as before.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\.\.?\//.test(specifier) || /\.[cm]?[jt]s$/.test(specifier)) throw error
    return await nextResolve(`${specifier}.ts`, context)
  }
}
