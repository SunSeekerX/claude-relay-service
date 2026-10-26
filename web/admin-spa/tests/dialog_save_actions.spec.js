import { test, expect } from '@playwright/test'

const ok = (data) => ({ code: 200, msg: 'ok', data })
const openFixture = async (page, scenario, respond = () => undefined) => {
  const writes = []
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/webapi/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/webapi', '')
    const method = request.method()
    const data = method === 'GET' ? undefined : request.postDataJSON()
    if (method !== 'GET') writes.push({ path, method, data })
    let response = respond({ path, method, data })
    if (response === undefined) {
      if (path.includes('proxy-pool/overview')) response = ok({})
      else if (path.includes('proxy-pool/settings')) response = ok({})
      else if (path.endsWith('/users')) response = ok({ users: [] })
      else if (path.includes('supported-clients')) response = ok([])
      else if (path === '/admin/relay-routes')
        response = ok({ routes: [], formats: [], providers: {} })
      else if (path.includes('/test-config'))
        response = ok({
          config: { enabled: false, cronExpression: '0 * * * *', model: 'claude-sonnet-4-5' },
          history: []
        })
      else response = ok([])
    }
    await route.fulfill({ json: response })
  })
  await page.goto(`tests/fixtures/dialog_save_actions.html?case=${scenario}`)
  await expect(page.locator('#app')).toHaveAttribute('data-v-app', '')
  return { writes, errors }
}

test('native validation, Enter, pending buttons, and both close choices', async ({ page }) => {
  await openFixture(page, 'form')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('output')).toHaveText('0')
  await page.getByRole('textbox', { name: '名称' }).fill('draft')
  await page.getByRole('textbox', { name: '名称' }).press('Enter')
  await expect(page.getByRole('button', { name: '保存并关闭' })).toBeDisabled()
  await expect(page.locator('output')).toHaveText('1')
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.locator('output')).toHaveText('已关闭')
})

test('proxy create becomes update; failed save-and-close retains the draft', async ({ page }) => {
  let fail = false
  const { writes, errors } = await openFixture(page, 'proxy', ({ method, path, data }) => {
    if (method === 'POST' && path.endsWith('/proxies')) return ok({ ...data, id: 'proxy-1' })
    if (method === 'PUT' && path.endsWith('/proxies/proxy-1'))
      return fail ? { code: 400, msg: '保存失败' } : ok({ ...data, id: 'proxy-1' })
  })
  await page.getByRole('button', { name: '添加代理', exact: true }).click()
  const modal = page.locator('.modal-content').filter({ hasText: '添加代理' })
  await modal.getByPlaceholder('socks5://user:pass@host:1080').fill('http://127.0.0.1:8080')
  await modal.locator('input').nth(1).fill('proxy-test')
  await modal.getByRole('button', { name: '保存', exact: true }).click()
  const editor = page.locator('.modal-content').filter({ hasText: '编辑代理' })
  await expect(editor).toBeVisible()
  fail = true
  await editor.getByRole('button', { name: '保存并关闭' }).click()
  await expect(editor.getByRole('button', { name: '保存并关闭' })).toBeEnabled()
  await expect(editor).toBeVisible()
  fail = false
  await editor.getByRole('button', { name: '保存并关闭' }).click()
  await expect(editor).toHaveCount(0)
  expect(writes.map(({ method }) => method)).toEqual(['POST', 'PUT', 'PUT'])
  expect(errors).toEqual([])
})

test('new API key subsequent saves update the returned ID', async ({ page }) => {
  const { writes, errors } = await openFixture(page, 'create-key', ({ method, path, data }) => {
    if (method === 'POST' && path.endsWith('/api-keys'))
      return ok({ ...data, id: 'key-1', apiKey: 'test-key' })
    if (method === 'PUT') return ok()
  })
  await page.getByPlaceholder('为您的 API Key 取一个名称').fill('key-test')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存并关闭' })).toBeEnabled()
  await page.getByPlaceholder('为您的 API Key 取一个名称').fill('key-updated')
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible()
  expect(writes.map(({ method, path }) => [method, path])).toEqual([
    ['POST', '/admin/api-keys'],
    ['PUT', '/admin/api-keys/key-1']
  ])
  expect(writes[1].data.tags).toEqual([])
  expect(writes[1].data.claudeAccountId).toBe('')
  expect(writes[1].data.claudeConsoleAccountId).toBe('')
  expect(errors).toEqual([])
})

test('continued saves preserve activation-mode keys without forcing a new expiry', async ({
  page
}) => {
  const { writes, errors } = await openFixture(page, 'create-key', ({ method, data }) => {
    if (method === 'POST') return ok({ ...data, id: 'key-1', apiKey: 'test-key' })
    if (method === 'PUT') return ok()
  })
  await page.getByPlaceholder('为您的 API Key 取一个名称').fill('activation-key')
  await page.getByRole('button', { name: /首次使用后激活/ }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByPlaceholder('输入天数')).toBeDisabled()
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible()
  expect(writes).toHaveLength(2)
  expect(writes[0].data.expirationMode).toBe('activation')
  expect(writes[1].data).not.toHaveProperty('expiresAt')
  expect(writes[1].data).not.toHaveProperty('expirationMode')
  expect(errors).toEqual([])
})

test('internal model create switches to save and retains failed edits', async ({ page }) => {
  let fail = false
  const { writes, errors } = await openFixture(page, 'model', ({ method, data }) => {
    if (method !== 'GET') return fail ? { code: 400, msg: '价格不正确' } : ok(data)
  })
  await page.getByPlaceholder('claude-sonnet-4-5').fill('test-model')
  await page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '基础定价（$/M tokens）' }) })
    .locator('input')
    .first()
    .fill('1')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByPlaceholder('claude-sonnet-4-5')).toBeDisabled()
  fail = true
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByRole('button', { name: '保存并关闭' })).toBeEnabled()
  await expect(page.getByPlaceholder('claude-sonnet-4-5')).toBeVisible()
  fail = false
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible()
  expect(writes.map(({ method }) => method)).toEqual(['POST', 'PUT', 'PUT'])
  expect(errors).toEqual([])
})

test('role changes retain the editor and can save-and-close without another change', async ({
  page
}) => {
  const { errors } = await openFixture(page, 'role', ({ method }) =>
    method === 'PUT' ? ok() : undefined
  )
  await page.getByRole('button', { name: /管理员 可以管理用户/ }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('group create keeps the dialog open and the next save updates its ID', async ({ page }) => {
  const { writes, errors } = await openFixture(page, 'groups', ({ method, data }) =>
    method !== 'GET' ? ok({ ...data, id: 'group-1' }) : undefined
  )
  await page.getByRole('button', { name: '创建新分组' }).click()
  await page.getByPlaceholder('输入分组名称').fill('group-test')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存并关闭' })).toBeEnabled()
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByPlaceholder('输入分组名称')).toHaveCount(0)
  expect(writes.map(({ method, path }) => [method, path])).toEqual([
    ['POST', '/admin/account-groups'],
    ['PUT', '/admin/account-groups/group-1']
  ])
  expect(errors).toEqual([])
})

test('CCR account create switches to edit; failed save-and-close stays open', async ({ page }) => {
  let fail = false
  const { writes, errors } = await openFixture(page, 'ccr', ({ method, data }) =>
    method !== 'GET'
      ? fail
        ? { code: 400, msg: '保存失败' }
        : ok({ ...data, id: 'ccr-1' })
      : undefined
  )
  await page.getByPlaceholder('为账户设置一个易识别的名称').fill('account-test')
  await page
    .getByPlaceholder('例如：https://api.example.com/v1/messages')
    .fill('https://example.test/v1/messages')
  await page.getByPlaceholder('必填', { exact: true }).fill('test-key')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('heading', { name: '编辑 CCR 账户' })).toBeVisible()
  fail = true
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByRole('button', { name: '保存并关闭' })).toBeEnabled()
  fail = false
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible()
  expect(writes.map(({ method }) => method)).toEqual(['POST', 'PUT', 'PUT'])
  expect(errors).toEqual([])
})

test('batch save-and-close stays open on partial failure', async ({ page }) => {
  let partial = true
  const { writes, errors } = await openFixture(page, 'batch', ({ method }) =>
    method === 'PUT'
      ? ok({
          successCount: partial ? 1 : 2,
          failedCount: partial ? 1 : 0,
          errors: partial ? [{ keyId: 'key-2', error: 'failed' }] : []
        })
      : undefined
  )
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByRole('button', { name: '保存并关闭' })).toBeEnabled()
  partial = false
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible()
  expect(writes).toHaveLength(2)
  expect(writes[1].data.keyIds).toEqual(['key-1', 'key-2'])
  expect(errors).toEqual([])
})

test('quick adjustment retains the successful baseline when another field fails', async ({
  page
}) => {
  let fail = true
  const { writes, errors } = await openFixture(page, 'quick', ({ method, data }) => {
    if (method !== 'GET') {
      if (data.addCostLimit) return ok({ newTotalCostLimit: 20 })
      return fail
        ? { code: 400, msg: '有效期保存失败' }
        : ok({ newExpiresAt: '2030-01-01T00:00:00.000Z' })
    }
  })
  await page.getByPlaceholder('留空表示不调整额度').fill('10')
  await page.getByRole('button', { name: '7 天', exact: true }).click()
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByRole('button', { name: '保存并关闭' })).toBeEnabled()
  await expect(page.getByPlaceholder('留空表示不调整额度')).toHaveValue('')
  fail = false
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible()
  expect(writes.filter(({ data }) => data.addCostLimit)).toHaveLength(1)
  expect(writes).toHaveLength(3)
  expect(errors).toEqual([])
})

test('user key save displays the secret and does not create another key', async ({ page }) => {
  const { writes, errors } = await openFixture(page, 'user-key', ({ method }) =>
    method === 'POST' ? ok({ apiKey: { id: 'key-1', key: 'test-secret' } }) : undefined
  )
  await page.getByPlaceholder('Enter API key name').fill('user-key')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('test-secret', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByText('已关闭', { exact: true })).toBeVisible()
  expect(writes).toHaveLength(1)
  expect(errors).toEqual([])
})

test('payment global configuration honors both save choices', async ({ page }) => {
  const { writes, errors } = await openFixture(page, 'payment', ({ path, method }) => {
    if (path.endsWith('/config')) return ok({ enabledPaymentTypes: [] })
    if (method === 'GET' && path.includes('dashboard')) return ok({})
  })
  await page.getByRole('button', { name: '全局配置' }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存并关闭' })).toBeEnabled()
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByRole('button', { name: '保存并关闭' })).toHaveCount(0)
  expect(writes).toHaveLength(2)
  expect(errors).toEqual([])
})

test('password save stays open for confirmation and does not resubmit invalidated credentials', async ({
  page
}) => {
  const { writes, errors } = await openFixture(page, 'header', ({ method, path }) => {
    if (method === 'POST' && path.includes('change-password')) return ok({ newUsername: 'Admin' })
    if (path.includes('version')) return ok({ current: '1.0.0' })
  })
  await page.locator('.user-menu-button').click()
  await page.getByRole('button', { name: '修改账户信息' }).click()
  await page.getByPlaceholder('请输入当前密码').fill('old-password')
  await page.getByPlaceholder('请输入新密码（至少 8 位）').fill('new-password')
  await page.getByPlaceholder('请再次输入新密码').fill('new-password')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('账户信息已保存，关闭后请重新登录。')).toBeVisible()
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(writes.filter(({ path }) => path.includes('change-password'))).toHaveLength(1)
  expect(errors).toEqual([])
})

for (const scenario of ['theme', 'layout']) {
  test(`${scenario} footer wraps at 320px and preserves the save choice`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    const { errors } = await openFixture(page, scenario)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    for (const button of await page.locator('.app-dialog__footer button').all()) {
      const box = await button.boundingBox()
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(320)
    }
    await page.getByRole('button', { name: '保存并关闭' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

for (const width of [320, 390, 1280]) {
  test(`save actions stay inside the dialog at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const { errors } = await openFixture(page, 'scheduled')
    await expect(page.getByRole('button', { name: '保存并关闭' })).toBeVisible()
    const buttons = page.getByRole('button', { name: /^(取消|保存|保存并关闭)$/ })
    for (const button of await buttons.all()) {
      const box = await button.boundingBox()
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
    }
    expect(errors).toEqual([])
  })
}
