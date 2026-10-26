import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'dialog_save_actions.spec.js',
  fullyParallel: true,
  workers: 3,
  use: {
    baseURL: 'http://127.0.0.1:4179/admin/',
    channel: 'chrome',
    headless: true
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4179 --strictPort',
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    url: 'http://127.0.0.1:4179/admin/tests/fixtures/dialog_save_actions.html',
    reuseExistingServer: false
  }
})
