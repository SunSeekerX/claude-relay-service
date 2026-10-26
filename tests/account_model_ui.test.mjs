import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { getAccountModelConfiguration } from '../web/admin-spa/src/libs/account_model_config.js'
const load = createRequire(path.resolve('web/admin-spa/package.json'))
const Vue = load('vue')
const compiler = load('vue/compiler-sfc')
const renderer = Vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
const settle = async () => { await Vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }
const mountCatalog = async (props, deps) => {
  const source = await readFile('web/admin-spa/src/components/accounts/account_model_catalog.vue', 'utf8')
  const { descriptor } = compiler.parse(source)
  let script = compiler.compileScript(descriptor, { id: 'model-editor-test' }).content
  script = script.replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/gm, (_, binding, specifier) => {
    if (!binding.startsWith('{')) return `const ${binding} = {render:()=>null};`
    return `const ${binding.replace(/\s+as\s+/g, ':')} = ${specifier === 'vue' ? 'Vue' : 'deps'};`
  }).replace('export default', 'return')
  const component = new Function('Vue', 'deps', script)(Vue, { isOk: result => result?.code === 200, msgOf: (_value, fallback) => fallback, modelSourceLabel: source => source, formatDateTime: value => value, ...deps })
  component.render = () => Vue.h('div')
  const app = renderer.createApp({ render: () => Vue.h(component, props) })
  app.mount({})
  await settle()
  return { state: app._instance.subTree.component.setupState, close: () => app.unmount() }
}
test('new accounts are unrestricted and legacy mappings retain their range separately from real renames', () => {
  assert.deepEqual(getAccountModelConfiguration(null), { models: [], mappings: [], ready: true })
  assert.deepEqual(getAccountModelConfiguration({ platform: 'claude-console', supportedModels: { unchanged: 'unchanged', alias: 'target' } }), { models: ['unchanged', 'alias'], mappings: [{ from: 'alias', to: 'target' }], ready: true })
  assert.deepEqual(getAccountModelConfiguration({ platform: 'ccr', allowedModels: [], supportedModels: { alias: 'target' } }), { models: [], mappings: [{ from: 'alias', to: 'target' }], ready: true })
  assert.equal(getAccountModelConfiguration({ platform: 'claude' }).ready, false)
})
test('refreshing or syncing the catalog does not emit selection or mapping changes', async () => {
  const events = []
  const props = Vue.reactive({ accountId: 'a', platform: 'openai-responses', modelValue: ['draft'], restricted: true, modelMappings: [{ from: 'alias', to: 'target' }], 'onUpdate:modelValue': value => events.push(value), 'onUpdate:modelMappings': value => events.push(value), 'onUpdate:restricted': value => events.push(value) })
  const modal = await mountCatalog(props, {
    getAccountModelCatalogApi: async () => ({ code: 200, data: { models: ['upstream'], configuredModels: ['saved'] } }),
    getAccountSupportedModelsApi: async () => ({ code: 200, data: { models: [{ id: 'saved', source: 'configured' }] } }),
    syncAccountModelCatalogApi: async () => ({ code: 200, data: { models: ['new-upstream'], configuredModels: ['saved'] } })
  })
  try {
    await modal.state.sync()
    await modal.state.load()
    assert.deepEqual(events, [])
    assert.deepEqual(props.modelValue, ['draft'])
    assert.equal(props.restricted, true)
    assert.deepEqual(props.modelMappings, [{ from: 'alias', to: 'target' }])
  } finally { modal.close() }
})
test('a late catalog response from the previous account cannot replace the current account', async () => {
  const first = Promise.withResolvers()
  const loaded = []
  const props = Vue.reactive({ accountId: 'a', platform: 'claude-console', onLoaded: models => loaded.push(models) })
  const modal = await mountCatalog(props, {
    getAccountModelCatalogApi: async (_type, id) => id === 'a' ? first.promise : { code: 200, data: { models: ['b'], configuredModels: ['b'] } },
    getAccountSupportedModelsApi: async (_type, id) => ({ code: 200, data: { models: [{ id, source: 'configured' }] } })
  })
  try {
    props.accountId = 'b'
    await settle()
    first.resolve({ code: 200, data: { models: ['a'], configuredModels: ['a'] } })
    await settle()
    assert.deepEqual(modal.state.catalog.models, ['b'])
    assert.deepEqual(loaded, [['b']])
  } finally { modal.close() }
})
