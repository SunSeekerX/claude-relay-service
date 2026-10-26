import { config } from './config.js'
import { tokenizerDefaults } from './tokenizer_defaults.js'

export const tokenizerConfig = { ...tokenizerDefaults, ...config.tokenizers }
