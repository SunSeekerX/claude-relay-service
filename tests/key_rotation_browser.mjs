import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.join(root, '.agent_tmp/20261120_key_rotation', 'browser_' + Date.now())
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'README.md'), '# Key rotation browser verification\n\n北京时间 2026-11-20。实际 Vue 组件,本地 API 夹具;用 llysc/server_data/dev_tools/browser/run.mjs --cwd 本项目执行。结果 result.json;未访问生产。\n')
const ui = path.join(root, 'web/admin-spa'), load = createRequire(path.join(ui, 'package.json'))
const { build } = await import(pathToFileURL(load.resolve('vite')))
const { default: vue } = await import(pathToFileURL(load.resolve('@vitejs/plugin-vue')))
const { createGenerator } = await import(pathToFileURL(load.resolve('unocss')))
const { default: unoConfig } = await import(pathToFileURL(path.join(ui,'uno.config.js')))
const src = name => path.join(ui, 'src', name).replaceAll('\\', '/')
const modules = new Map([
  ['src/libs/http_apis.js', `const ok=data=>({code:200,data});export const regenerateSelfKeyApi=async(apiKey,requestId)=>{fixture.requests.push({apiKey,requestId});return fixture.fail?{code:0,msg:'响应丢失'}:ok({key:'new-key'})};export const regenerateAdminKeyApi=async(keyId,requestId)=>{fixture.admin.push({keyId,requestId});return ok({key:'admin-new'})};export const regenerateUserKeyApi=async(keyId,requestId)=>{fixture.user.push({keyId,requestId});return ok({key:'user-new'})};export const getKeyCredentialHistoryApi=async params=>{fixture.queries.push(params);return ok({target:{keyId:'key-id',keyName:'测试 Key',ownerName:'客户甲',deleted:fixture.deleted},rows:[{id:'event',keyName:'测试 Key',ownerName:'客户甲',oldHash:'a'.repeat(64),newHash:'b'.repeat(64),action:'rotate',actorKind:'key',ip:'127.0.0.1',eventTime:'2026-11-20T08:00:00Z'}],total:1})};`],
  ['src/libs/tools.js', "export const copyText=async value=>fixture.copied=value;"],
])
modules.set('src/libs/http_apis.js',modules.get('src/libs/http_apis.js')+`const customerHistory=async(identity,params)=>{fixture.customerQueries.push({identity,params});if(fixture.historyPending)return new Promise(resolve=>fixture.resolveHistory=resolve);return {code:200,data:{rows:[{id:'one',action:'rotate',actorKind:'key',oldKeyMasked:'****1234',newKeyMasked:'****5678',eventTime:'2026-11-20T08:00:00Z'}],total:40}}};export const getSelfKeyCredentialHistoryApi=customerHistory;export const getUserKeyCredentialHistoryApi=customerHistory;`)
const statsTemplate=await readFile(src('views/api_stats/stats_tab.vue'),'utf8')
const historyButton=statsTemplate.match(/<button v-if="apiStatsStore.testApiKey"[^>]*>换 Key 记录<\/button>/)[0]
const entry = [
  "import{createApp,ref}from'vue';import Rotate from "+JSON.stringify(src('components/api_keys/rotate_key_modal.vue'))+";import History from "+JSON.stringify(src('components/api_keys/credential_history_modal.vue'))+";",
  "import "+JSON.stringify(src('assets/styles/global.css'))+";import "+JSON.stringify(src('assets/styles/controls.css'))+";",
  "import CustomerHistory from "+JSON.stringify(src('components/api_keys/customer_credential_history_modal.vue'))+";",
  "window.fixture={fail:true,requests:[],admin:[],user:[],queries:[],customerQueries:[],deleted:false,results:[]};const app=createApp({components:{Rotate,History,CustomerHistory},setup(){const history=ref(null),credentialHistory=ref(null),customerUser=ref(null),customerKey=ref('current-key'),user=ref(null),mounted=ref(true);window.harness={history,user,mounted,credentialHistory,customerUser,customerKey};return{history,user,mounted,credentialHistory,customerUser,customerKey,fixture,apiStatsStore:{testApiKey:'current-key'}}},template:"+JSON.stringify('<div>'+historyButton+'<Rotate v-if="mounted" api-key="old-key" @rotated="fixture.results.push($event)"/><History ref="history"/><Rotate ref="user" mode="user"/><CustomerHistory ref="credentialHistory" :api-key="customerKey"/><CustomerHistory ref="customerUser" mode="user"/></div>')+"});app.mount('#app');"
].join('\n')
const output=await build({configFile:false,root:ui,logLevel:'warn',resolve:{alias:{'@':path.join(ui,'src'),vue:load.resolve('vue/dist/vue.esm-bundler.js')}},plugins:[{name:'fixture',enforce:'pre',resolveId(id,importer){if(id==='rotation-fixture')return '\0entry';const resolved=id.startsWith('.')&&importer&&!importer.startsWith('\0')?path.resolve(path.dirname(importer),id):id;for(const[key]of modules)if(resolved===key||resolved.replaceAll('\\','/').endsWith('/'+key)||resolved.replaceAll('\\','/').endsWith('/'+key.slice(0,-3)))return '\0mock:'+key},load(id){if(id==='\0entry')return entry;if(id.startsWith('\0mock:'))return modules.get(id.slice(6))}},vue()],build:{write:false,minify:false,rolldownOptions:{input:'rotation-fixture',output:{format:'es'}}}})
const assets=(Array.isArray(output)?output:[output]).flatMap(item=>item.output),entryFile=assets.find(item=>item.type==='chunk'&&item.isEntry).fileName
const resources=new Map(assets.map(item=>['/'+item.fileName,item.type==='chunk'?item.code:item.source])),css=assets.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>item.source).join('\n')
const uno=await createGenerator(unoConfig)
const utilities=(await uno.generate([entry,...await Promise.all(['components/api_keys/customer_credential_history_modal.vue','components/api_keys/rotate_key_modal.vue','components/api_keys/credential_history_modal.vue'].map(name=>readFile(src(name),'utf8')))].join('\n'))).css
const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');response.end(resources.get(request.url)??'<html><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'\n'+utilities+'</style><body><div id="app"></div><script type="module" src="/'+entryFile+'"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+path.join(directory,'profile')],{stdio:'ignore'})
let socket,send
try{
  let port;for(let attempt=0;attempt<150;attempt++){try{port=(await readFile(path.join(directory,'profile/DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];break}catch{await new Promise(resolve=>setTimeout(resolve,100))}}assert.ok(port)
  const target=await(await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT'})).json();socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}))
  let sequence=0;const pending=new Map(),errors=[];socket.addEventListener('message',({data})=>{const value=JSON.parse(data);if(value.id){const waiter=pending.get(value.id);pending.delete(value.id);value.error?waiter?.reject(value.error):waiter?.resolve(value.result)}else if(value.method==='Runtime.exceptionThrown')errors.push(value.params.exceptionDetails)})
  send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value}
  const wait=async expression=>{for(let attempt=0;attempt<150;attempt++){if(await evaluate('Boolean('+expression+')'))return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error(expression+' / '+await evaluate('document.body.innerText')+JSON.stringify(errors))}
  const click=text=>evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==="+JSON.stringify(text)+"&&button.getClientRects().length).click()")
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port})
  await wait('window.harness');await click('更换 Key');await click('确认更换');await wait('fixture.requests.length===1')
  const requestId=await evaluate('fixture.requests[0].requestId');await evaluate('harness.mounted.value=false');await wait('!document.querySelector(".modal")');await evaluate('harness.mounted.value=true;fixture.fail=false')
  await wait('document.body.innerText.includes("恢复换 Key 结果")');await click('恢复换 Key 结果');await click('恢复结果');await wait('fixture.results.length===1');assert.equal(await evaluate('fixture.requests[1].requestId'),requestId);assert.equal(await evaluate('sessionStorage.getItem("crsKeyRotationPending")'),null)
  await click('关闭');await wait('!document.querySelector(".modal")');await evaluate('harness.history.value.open()');await wait('document.querySelector("input")')
  await evaluate('const input=document.querySelector("input");input.value="old-key";input.dispatchEvent(new Event("input",{bubbles:true}))');await click('查询');await wait('fixture.queries.at(-1).apiKey==="old-key"')
  await click('换发新 Key');await click('确认更换');await wait('fixture.admin.length===1');assert.equal(await evaluate('fixture.admin[0].keyId'),'key-id')
  await evaluate('Array.from(document.querySelectorAll("button")).filter(button=>button.textContent.trim()==="关闭"&&button.getClientRects().length).at(-1).click()');await click('关闭');await wait('!document.querySelector(".modal")')
  await evaluate('harness.user.value.open({id:"owned-key"})');await click('确认更换');await wait('fixture.user.length===1');assert.equal(await evaluate('fixture.user[0].keyId'),'owned-key')
  await click('关闭');await wait('!document.querySelector(".modal")');assert.ok(await evaluate('(()=>{const button=Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="换 Key 记录"),style=getComputedStyle(button);return parseFloat(style.borderTopWidth)>=1&&parseFloat(style.borderRadius)>0})()'));await click('换 Key 记录');await wait('document.querySelector(".modal").innerText.includes("****1234")')
  assert.equal(await evaluate('fixture.customerQueries.at(-1).identity'),'current-key')
  assert.equal(await evaluate('document.querySelector(".modal").innerText.includes("持 Key 操作")'),true)
  assert.equal(await evaluate('document.querySelectorAll(".modal td [title],.modal td button").length'),0)
  await click('时间降序');await wait('fixture.customerQueries.at(-1).params.sortOrder==="asc"');await click('下一页');await wait('fixture.customerQueries.at(-1).params.page===2')
  await new Promise(resolve=>setTimeout(resolve,300));await writeFile(path.join(directory,'customer-history-desktop.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
  await click('关闭');await wait('!document.querySelector(".modal")');await evaluate('harness.customerUser.value.open({id:"owned-key",name:"我的 Key"})');await wait('fixture.customerQueries.at(-1).identity==="owned-key"')
  await send('Emulation.setDeviceMetricsOverride',{width:375,height:760,deviceScaleFactor:1,mobile:true});await new Promise(resolve=>setTimeout(resolve,300))
  assert.ok(await evaluate('Array.from(document.querySelectorAll(".modal button")).find(button=>button.textContent.trim()==="关闭").getBoundingClientRect().bottom<=760'))
  await writeFile(path.join(directory,'customer-history-mobile.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
  await click('关闭');await wait('!document.querySelector(".modal")');await evaluate('fixture.historyPending=true;void harness.credentialHistory.value.open()');await wait('fixture.resolveHistory');await evaluate('harness.customerKey.value="replacement-key"');await wait('!document.querySelector(".modal")')
  await evaluate('fixture.resolveHistory({code:200,data:{rows:[{oldKeyMasked:"****late"}],total:1}})');assert.equal(await evaluate('document.body.innerText.includes("****late")'),false)
  assert.deepEqual(errors,[]);await writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,checks:['customer history button','masked history no reveal controls','independent and account history','sort/pagination/mobile close','identity change drops stale history','self confirmation','lost-response recovery','same request ID','new key handoff','old key admin lookup','admin recovery','owner rotation']},null,2));console.log(JSON.stringify({passed:true,directory}))
}finally{if(send&&socket?.readyState===WebSocket.OPEN)await Promise.race([send('Browser.close').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);socket?.close();await new Promise(resolve=>server.close(resolve));if(chrome.exitCode===null)await Promise.race([new Promise(resolve=>chrome.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,2000))])}
