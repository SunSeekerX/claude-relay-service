import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = createRequire(path.join(root, 'web/admin-spa/package.json'))
const Vue = load('vue')
const compiler = load('vue/compiler-sfc')
const sourceRoot = path.join(root, 'web/admin-spa/src')
const envelope = {
  isOk: (value) => value?.code >= 200 && value.code < 300,
  msgOf: (value, fallback) => value?.msg ?? fallback
}
const imports = (source) =>
  source.replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/gm, (_, binding, specifier) => {
    const target = specifier === 'vue' ? 'Vue' : `deps[${JSON.stringify(specifier)}] ?? deps`
    if (binding.startsWith('* as ')) return `const ${binding.slice(5)} = ${target};`
    return `const ${binding.replace(/\s+as\s+/g, ':')} = ${binding.startsWith('{') ? '(' + target + ')' : `deps[${JSON.stringify(specifier)}] ?? deps.Stub`};`
  })
const helperSource = await readFile(path.join(sourceRoot, 'libs/use_test_prompts.js'), 'utf8')
const helpers = new Function(
  'Vue',
  'deps',
  imports(helperSource).replaceAll('export const ', 'const ') +
    '\nreturn { parseTestPromptConfig, useTestPrompts }'
)(Vue, envelope)
const defaults = JSON.parse(
  await readFile(path.join(root, 'config/test_prompt_defaults.json'), 'utf8')
)
const settle = async () => {
  await Vue.nextTick()
  await new Promise((resolve) => setImmediate(resolve))
  await Vue.nextTick()
}

test('missing prompt endpoint reports HTTP cause and retry preserves a manual question', async () => {
  let result = { code: 404, httpStatus: 404, requestId: 'prompt-request' }
  const scope = Vue.effectScope()
  const visible = Vue.ref(true)
  const message = Vue.ref('')
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args)
  try {
    const prompts = scope.run(() => helpers.useTestPrompts(async () => result, visible, message))
    await settle()
    assert.equal(prompts.failed.value, true)
    assert.match(prompts.errorMessage.value, /404.*后端/)
    assert.equal(errors[0][1].cause.requestId, 'prompt-request')
    assert.equal(errors[0][1].cause.endpoint, '/apiStats/test-prompt-config')
    assert.equal(prompts.errorRequestId.value, 'prompt-request')
    message.value = 'Keep my manually entered question'
    result = { code: 200, data: { config: defaults } }
    await prompts.reload()
    assert.equal(prompts.failed.value, false)
    assert.equal(prompts.errorMessage.value, '')
    assert.equal(prompts.errorRequestId.value, '')
    assert.equal(message.value, 'Keep my manually entered question')
    assert.ok(prompts.options.value.length)
  } finally {
    scope.stop()
    console.error = originalError
  }
})
const renderer = Vue.createRenderer({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert: () => {},
  remove: () => {},
  setText: () => {},
  setElementText: () => {},
  patchProp: () => {},
  parentNode: () => null,
  nextSibling: () => null
})
const mount = async (file, props, deps) => {
  const source = await readFile(path.join(sourceRoot, file), 'utf8')
  const { descriptor, errors } = compiler.parse(source, { filename: file })
  assert.deepEqual(errors, [])
  const script = compiler.compileScript(descriptor, { id: file })
  const compiled = compiler.compileTemplate({
    source: descriptor.template.content,
    filename: file,
    id: file,
    compilerOptions: { bindingMetadata: script.bindings }
  })
  assert.deepEqual(compiled.errors, [])
  const component = new Function(
    'Vue',
    'deps',
    imports(script.content).replace('export default', 'return')
  )(Vue, { ...envelope, ...helpers, Stub: { render: () => null }, ...deps })
  component.render = () => Vue.h('div')
  const app = renderer.createApp({ render: () => Vue.h(component, props) })
  app.mount({})
  await settle()
  return { state: app._instance.subTree.component.setupState, close: () => app.unmount() }
}

test('prompt loading preserves edits, closing prevents late changes, and reopening randomizes automatic questions', async () => {
  const pending = Promise.withResolvers()
  const scope = Vue.effectScope()
  const visible = Vue.ref(false)
  const message = Vue.ref('')
  const prompts = scope.run(() => helpers.useTestPrompts(() => pending.promise, visible, message))
  try {
    visible.value = true
    await settle()
    assert.equal(prompts.loading.value, true)
    assert.equal(prompts.canRandomize.value, false)
    message.value = 'Typed while loading'
    pending.resolve({ code: 200, data: { config: defaults } })
    await settle()
    assert.equal(message.value, 'Typed while loading')
    prompts.randomize()
    const first = message.value
    assert.ok(defaults.templates.some((item) => item.prompt === first))
    visible.value = false
    await settle()
    visible.value = true
    await settle()
    assert.notEqual(message.value, first)
    prompts.select(defaults.templates[0].id)
    visible.value = false
    await settle()
    visible.value = true
    await settle()
    assert.equal(message.value, defaults.templates[0].prompt)
  } finally {
    scope.stop()
  }
})

test('management edits, disable, add, delete and save control account and API Key test bodies', async () => {
  const originalStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => null }
  let stored = structuredClone(defaults)
  const getConfig = async () => ({ code: 200, data: { config: structuredClone(stored) } })
  const api = {
    getTestPromptConfigApi: getConfig,
    updateTestPromptConfigApi: async (value) => {
      stored = structuredClone(value)
      return getConfig()
    },
    showToast: () => {}
  }
  const editor = await mount('components/settings/test_prompt_settings_section.vue', {}, api)
  try {
    assert.equal(editor.state.form.templates.length, 40)
    editor.state.selected.prompt = 'Edited daily question'
    editor.state.setEnabled(editor.state.selected, false)
    editor.state.add()
    const id = editor.state.selectedId
    editor.state.selected.name = 'My question'
    editor.state.selected.prompt = 'Explain browser caching briefly.'
    for (const item of editor.state.form.templates) editor.state.setEnabled(item, item.id === id)
    editor.state.move(-1)
    await editor.state.save()
    await editor.state.load()
    assert.equal(
      stored.templates.find((item) => item.id === id).prompt,
      'Explain browser caching briefly.'
    )
    for (const mode of ['account', 'apikey']) {
      const calls = []
      const props = Vue.reactive({
        show: true,
        mode,
        account: { id: 'account', platform: 'claude' },
        apiKeyValue: 'fixture-key',
        serviceType: 'claude'
      })
      const modal = await mount('components/common/unified_test_modal.vue', props, {
        getAccountSupportedModelsApi: async () => ({
          code: 200,
          data: { models: [{ id: 'chosen-model', source: 'confirmed', availability: 'supported' }] }
        }),
        getTestModelDefaultsApi: async () => ({ code: 200, data: { account: { claude: 'chosen-model' }, apikey: { claude: 'chosen-model' } } }),
        getModelsApi: async () => ({
          code: 200,
          data: {
            claude: [{ value: 'chosen-model', label: 'Chosen' }],
            platforms: { claude: [{ value: 'chosen-model', label: 'Chosen' }] },
            defaultModels: {
              account: { claude: 'chosen-model' },
              apikey: { claude: 'chosen-model' }
            }
          }
        }),
        getPublicTestPromptConfigApi: getConfig,
        APP_CONFIG: { apiPrefix: '/fixture' },
        PLATFORM_ICONS: {},
        useTestState: () => ({
          testStatus: Vue.ref('idle'),
          resetState: () => {},
          cleanup: () => {},
          sendTestRequest: (...args) => calls.push(args)
        })
      })
      try {
        assert.equal(modal.state.testPrompt, 'Explain browser caching briefly.')
        assert.equal(modal.state.disableTest, false)
        modal.state.startTest()
        assert.equal(calls.length, 1)
        assert.equal(calls[0][1].prompt, modal.state.testPrompt)
        assert.equal(calls[0][1].model, 'chosen-model')
        modal.state.testPrompt = 'My manual question'
        props.show = false
        await settle()
        props.show = true
        await settle()
        assert.equal(modal.state.testPrompt, 'My manual question')
      } finally {
        modal.close()
      }
    }
    editor.state.remove()
    await editor.state.save()
    assert.ok(!stored.templates.some((item) => item.id === id))
    editor.state.form.templates = []
    await editor.state.save()
    await editor.state.load()
    assert.deepEqual(editor.state.form.templates, [])
  } finally {
    editor.close()
    globalThis.localStorage = originalStorage
  }
})

test('all changed settings and modal templates compile, and invalid banks are rejected', async () => {
  for (const file of [
    'components/settings/test_models_settings_section.vue',
    'components/settings/test_prompt_settings_section.vue',
    'components/common/unified_test_modal.vue'
  ]) {
    const { descriptor, errors } = compiler.parse(
      await readFile(path.join(sourceRoot, file), 'utf8'),
      { filename: file }
    )
    assert.deepEqual(errors, [])
    compiler.compileScript(descriptor, { id: file, inlineTemplate: true })
  }
  assert.throws(() =>
    helpers.parseTestPromptConfig({
      ...defaults,
      templates: [defaults.templates[0], defaults.templates[0]]
    })
  )
  assert.deepEqual(
    helpers.parseTestPromptConfig({ selectionMode: 'random_simple', defaultId: '', templates: [] })
      .templates,
    []
  )
})

test('scoped model tests honor admin defaults only within scope and retain the explicitly selected model', async () => {
  for (const preferredModel of ['', 'first', 'outside']) {
    const props = Vue.reactive({ show: true, mode: 'apikey', serviceType: 'openai', routeModels: ['first', 'configured'], preferredModel })
    const modal = await mount('components/common/unified_test_modal.vue', props, {
      getTestModelDefaultsApi: async () => ({ code: 200, data: { apikey: { openai: 'configured' } } }),
      getModelsApi: () => { throw new Error('Scoped selection must not load global candidates') },
      getPublicTestPromptConfigApi: async () => ({ code: 200, data: { config: defaults } }),
      APP_CONFIG: { apiPrefix: '/fixture' }, PLATFORM_ICONS: {},
      useTestState: () => ({ testStatus: Vue.ref('idle'), resetState: () => {}, cleanup: () => {} })
    })
    try {
      assert.equal(modal.state.selectedModel, preferredModel === 'first' ? 'first' : 'configured')
      assert.deepEqual(modal.state.availableModels.map((model) => model.value), ['first', 'configured'])
      modal.state.selectedModel = 'first'
      props.routeModels = ['first']
      await settle()
      assert.equal(modal.state.selectedModel, 'first')
    } finally { modal.close() }
  }
})
