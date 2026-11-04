/**
 * @license
 * BudouX Copyright 2021 Google LLC
 * Licensed under the Apache License, Version 2.0.
 * Source: https://github.com/google/budoux (JavaScript package 0.10.1)
 */
import { model as bigramLeft } from './zh-hans-bigram-left'
import { model as bigramRight } from './zh-hans-bigram-right'
import { model as unigramLeft } from './zh-hans-unigram-left'
import { model as unigramCenter } from './zh-hans-unigram-center'
import { model as unigramRight } from './zh-hans-unigram-right'

export const model = {
  ...bigramLeft,
  ...bigramRight,
  ...unigramLeft,
  ...unigramCenter,
  ...unigramRight
}
