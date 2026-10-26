// Windows: node tests/test_prompt_browser.mjs .agent_tmp/20261025_access_tests
// Mount actual Vue components against in-memory API fixtures; no Redis or upstream requests.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.resolve(process.argv[2])
assert.ok(directory.startsWith(path.join(root, '.agent_tmp') + path.sep))
const load = createRequire(path.join(root, 'web/admin-spa/package.json'))
const { createServer } = await import(pathToFileURL(load.resolve('vite')))
const { default: vue } = await import(pathToFileURL(load.resolve('@vitejs/plugin-vue')))
const { default: uno } = await import(pathToFileURL(load.resolve('unocss/vite')))
const { chromium } = load('playwright')
let stored = JSON.parse(await readFile(path.join(root, 'config/test_prompt_defaults.json'), 'utf8'))
const submissions = []
const errors = []
let failPublicPrompt = false
const entry = `
import {createApp,h,ref} from 'vue'
import {createPinia} from 'pinia'
import 'virtual:uno.css'
import '/src/assets/styles/main.css'
import Editor from '/src/components/settings/test_prompt_settings_section.vue'
import Modal from '/src/components/common/unified_test_modal.vue'
const show=ref(false),mode=ref('account')
createApp({setup(){return()=>h('main',{style:'padding:16px'},[
  h(Editor),
  h('button',{id:'open-account',onClick:()=>{mode.value='account';show.value=true}},'Open account test'),
  h('button',{id:'open-key',onClick:()=>{mode.value='apikey';show.value=true}},'Open API Key test'),
  h(Modal,{show:show.value,mode:mode.value,account:{id:'fixture-account',platform:'claude',name:'Fixture account'},apiKeyValue:'fixture-key',apiKeyName:'Fixture key',serviceType:'claude',onClose:()=>show.value=false})
])}}).use(createPinia()).mount('#app')
`
const fixture = {
  name: 'access-test-fixture',
  resolveId(id) { if (id === '/fixture_entry.js') return '\0fixture_entry' },
  load(id) { if (id === '\0fixture_entry') return entry },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/fixture') return next()
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/fixture_entry.js"></script></body></html>')
    })
  }
}
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'README.md'), '# Access test verification\n\nDate: 2026-10-25.\nPurpose: offline desktop/mobile validation of the actual prompt editor and access-test modal.\nReuse: node tests/test_prompt_browser.mjs .agent_tmp/20261025_access_tests\nAll API calls use in-memory fixtures; no Redis, upstream or production calls.\nResults: see result.json. Screenshots show fixture data only.\n')
const server = await createServer({
  root: path.join(root, 'web/admin-spa'), configFile: false,
  plugins: [fixture, vue(), uno({ configFile: path.join(root, 'web/admin-spa/uno.config.js') })],
  resolve: { alias: { '@': path.join(root, 'web/admin-spa/src') } },
  server: { host: '127.0.0.1', port: 0, open: false },
  optimizeDeps: { noDiscovery: true, include: ['vue', 'pinia', 'dayjs'] }
})
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/webapi/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname.endsWith('/test-prompt-config')) {
      if (failPublicPrompt && url.pathname.includes('/apiStats/')) {
        return route.fulfill({ status: 404, headers: { 'X-Request-ID': 'fixture-prompt-404' },
          json: { code: 404, msg: 'Route /apiStats/test-prompt-config not found' } })
      }
      if (req.method() === 'PUT') stored = req.postDataJSON()
      return route.fulfill({ json: { code: 200, msg: 'OK', data: { config: stored } } })
    }
    if (url.pathname.endsWith('/supported-models')) {
      return route.fulfill({ json: { code: 200, data: { models: [{ id: 'fixture-model', source: 'confirmed', availability: 'supported' }] } } })
    }
    if (url.pathname.endsWith('/models')) {
      return route.fulfill({ json: { code: 200, msg: 'OK', data: { claude: [{ value: 'fixture-model', label: 'Fixture model' }], platforms: { claude: [{ value: 'fixture-model', label: 'Fixture model' }] }, defaultModels: { account: { claude: 'fixture-model' }, apikey: { claude: 'fixture-model' } } } } })
    }
    if (url.pathname.endsWith('/test')) {
      submissions.push({ path: url.pathname, body: req.postDataJSON() })
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"content","text":"Fixture answer"}\n\ndata: {"type":"test_complete","success":true}\n\n' })
    }
    return route.abort()
  })
  await page.goto(`${origin}/fixture`)
  const name = page.getByLabel('题目名称')
  await name.waitFor()
  assert.equal(await page.locator('section input[type=checkbox]').count(), 40)
  await page.getByLabel('问题正文').fill('Edited through the real browser')
  await page.getByLabel('启用', { exact: true }).first().uncheck()
  await page.getByRole('button', { name: '新增题目', exact: true }).click()
  await name.fill('Browser question')
  await page.getByLabel('问题正文').fill('Explain browser caching briefly.')
  await page.getByRole('button', { name: '设为默认', exact: true }).click()
  await page.getByRole('button', { name: '保存题库', exact: true }).click()
  await page.getByRole('button', { name: '保存题库', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('section button.btn-primary')?.disabled)
  const edited = stored.templates.find((item) => item.prompt === 'Edited through the real browser')
  assert.equal(edited.enabled, false)
  assert.equal(stored.templates.length, 41)
  await page.screenshot({ path: path.join(directory, 'editor_desktop.png'), fullPage: true })
  failPublicPrompt = true
  await page.locator('#open-account').click()
  const message = page.getByPlaceholder('输入测试提示词...')
  await message.waitFor()
  await page.getByText(/题库接口不存在（404）/).waitFor()
  await page.getByText('fixture-prompt-404', { exact: true }).waitFor()
  await page.getByRole('button', { name: '复制请求 ID', exact: true }).waitFor()
  const retry = page.getByRole('button', { name: '重新加载题库', exact: true })
  await retry.waitFor()
  await page.screenshot({ path: path.join(directory, 'prompt_error_desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(directory, 'prompt_error_mobile.png'), fullPage: true })
  failPublicPrompt = false
  await retry.click()
  await retry.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.waitForFunction(() => document.querySelector('textarea[placeholder="输入测试提示词..."]')?.value === 'Explain browser caching briefly.')
  await page.getByRole('button', { name: '开始测试', exact: true }).click()
  await page.getByText('Fixture answer', { exact: true }).waitFor()
  assert.equal(submissions[0].body.prompt, 'Explain browser caching briefly.')
  assert.ok(submissions[0].path.includes('/claude-accounts/'))
  await message.fill('My handwritten question')
  await page.getByRole('button', { name: '关闭', exact: true }).filter({ hasText: '关闭' }).click()
  await page.locator('#open-key').click()
  await message.waitFor()
  assert.equal(await message.inputValue(), 'My handwritten question')
  const before = await message.inputValue()
  await page.getByRole('button', { name: '换一题', exact: true }).click()
  assert.notEqual(await message.inputValue(), before)
  const shown = await message.inputValue()
  await page.getByRole('button', { name: '开始测试', exact: true }).click()
  await page.getByText('Fixture answer', { exact: true }).waitFor()
  assert.equal(submissions[1].body.prompt, shown)
  assert.ok(submissions[1].path.includes('/api-key/'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(directory, 'modal_mobile.png'), fullPage: true })
  assert.equal(await page.getByRole('button', { name: '关闭', exact: true }).filter({ hasText: '关闭' }).isVisible(), true)
  assert.deepEqual(errors, [])
  const result = { passed: true, templates: stored.templates.length, submissions, errors, desktop: [1280, 960], mobile: [390, 844] }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: true, templates: stored.templates.length, submissions: submissions.length, errors }))
} catch (error) {
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: false, error: error.stack, errors }, null, 2))
  throw error
} finally {
  await browser?.close()
  await server.close()
}
