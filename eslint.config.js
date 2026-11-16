import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import { defineConfig, globalIgnores, includeIgnoreFile } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),
  globalIgnores(['design/']),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  vue.configs['flat/recommended'],
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    // Node globals for tooling, config, and the API. The web app gets browser globals only, and
    // packages/core gets neither, since it must run in both (docs/ARCHITECTURE.md).
    ignores: ['apps/web/src/**', 'packages/core/src/**'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['apps/web/src/**'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
)
