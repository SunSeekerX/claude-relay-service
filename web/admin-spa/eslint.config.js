import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'
import globals from 'globals'
import fs from 'node:fs'
import path from 'node:path'

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore')
const gitignorePatterns = fs
  .readFileSync(gitignorePath, 'utf-8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))

const autoImportPath = path.resolve(import.meta.dirname, '.eslintrc-auto-import.json')
const autoImportGlobals = fs.existsSync(autoImportPath)
  ? JSON.parse(fs.readFileSync(autoImportPath, 'utf-8')).globals
  : {}

export default [
  {
    ignores: [
      ...gitignorePatterns,
      'dist/**',
      'node_modules/**',
      'components.d.ts',
      'auto-imports.d.ts',
      '**/*.woff',
      '**/*.ttf',
      '**/*.md'
    ]
  },
  js.configs.recommended,
  ...pluginVue.configs['flat/strongly-recommended'],
  skipFormatting,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...autoImportGlobals
      }
    }
  },
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off',
      // ESLint 9/10 recommended 新增规则：存量业务代码噪音大，升级不借机全仓清债
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      // catch (error) 未使用在本仓很常见；参数/捕获以 _ 前缀显式忽略
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ],
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'vue/attributes-order': [
        'error',
        {
          order: [
            'DEFINITION',
            'LIST_RENDERING',
            'CONDITIONALS',
            'RENDER_MODIFIERS',
            'GLOBAL',
            'UNIQUE',
            'TWO_WAY_BINDING',
            'OTHER_DIRECTIVES',
            'OTHER_ATTR',
            'EVENTS',
            'CONTENT'
          ],
          alphabetical: true
        }
      ]
    }
  }
]
