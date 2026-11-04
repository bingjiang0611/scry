import type { Many, none } from 'stream-chain'
import type { ParserOptions, Token } from 'stream-json/parser.js'

// stream-json 3.7 documents/exports its raw tokenizer, but omits it from parser.d.ts.
// Unlike parser(), this entry receives already-decoded text; `none` flushes EOF.
declare module 'stream-json/parser.js' {
  export function jsonParser(options?: ParserOptions): (input: string | typeof none) => Many<Token> | typeof none
}
