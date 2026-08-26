import js from '@eslint/js'
import prettier from 'eslint-plugin-prettier'
import prettierConfig from 'eslint-config-prettier'
import globals from 'globals'

export default [
  {
    ignores: ['node_modules/**', 'web/**', 'logs/**', 'data/**', 'temp/**', 'dist/**']
  },
  js.configs.recommended,
  prettierConfig,
  {
    files: ['src/**/*.js', 'cli/**/*.js', 'scripts/**/*.js', 'config/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest
      }
    },
    plugins: {
      prettier
    },
    rules: {
      'no-console': 'off',
      'consistent-return': 'off',
      'no-debugger': process.env.NODE_ENV === 'production' /* tooling: eslint 配置允许直读 */ ? 'error' : 'warn',
      'prettier/prettier': 'error',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none'
        }
      ],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-shadow': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'template-curly-spacing': ['error', 'never'],
      'no-path-concat': 'error',
      'handle-callback-err': 'error',
      'arrow-body-style': ['error', 'as-needed'],
      'prefer-arrow-callback': 'error',
      'prefer-destructuring': [
        'error',
        {
          array: false,
          object: true
        }
      ],
      semi: 'off',
      quotes: 'off',
      indent: 'off',
      'comma-dangle': 'off'
    }
  },
  {
    files: ['cli/**/*.js', 'scripts/**/*.js'],
    rules: {
      'no-process-exit': 'off'
    }
  },
  {
    files: ['**/*.test.js', '**/*.spec.js', 'tests/**/*.js'],
    rules: {
      'no-unused-expressions': 'off'
    }
  }
]
