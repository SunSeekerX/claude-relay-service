import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { createPricingDnsLookup, privateIpReason, queryDnsHttps } from '../src/modules/pricing/pricing_source_dns.js'

const fixture = ({ system, error, ipv4 = ['140.82.112.3'], ipv6 = [], fail = false }) => {
  const state = { lookups: 0, resolvers: 0, records: [], logs: [] }
  const dnsClient = {
    lookup(_hostname, options, callback) {
      state.lookups++
      assert.equal(options.all, true)
      callback(error, system)
    },
  }
  const lookup = createPricingDnsLookup({
    label: 'fixture',
    dnsClient,
    resolvePublic: async (hostname, options) => {
      state.resolvers++
      if (fail) throw new Error('独立 HTTPS DNS 解析失败')
      const addresses = []
      if (options.family !== 6) {
        state.records.push([hostname, 4])
        addresses.push(...ipv4.map((address) => ({ address, family: 4 })))
      }
      if (options.family !== 4) {
        state.records.push([hostname, 6])
        addresses.push(...ipv6.map((address) => ({ address, family: 6 })))
      }
      if (!addresses.length) throw new Error('独立 HTTPS DNS 解析失败')
      return { addresses, resolver: 'https://cloudflare-dns.com' }
    },
    log: (...args) => state.logs.push(args),
  })
  const run = (options = { all: true }) =>
    new Promise((resolve, reject) =>
      lookup('raw.githubusercontent.com', options, (failure, address, family) =>
        failure ? reject(failure) : resolve({ address, family }),
      ),
    )
  return { state, run }
}

test('ordinary public DNS results are pinned without independent resolution', async () => {
  const entries = [{ address: '140.82.112.3', family: 4 }]
  const { state, run } = fixture({ system: entries })
  assert.deepEqual((await run()).address, entries)
  assert.equal(state.lookups, 1)
  assert.equal(state.resolvers, 0)
})

test('Fake-IP and lookup failures use independent DNS and honor requested family', async () => {
  for (const input of [
    { system: [{ address: '198.18.0.61', family: 4 }] },
    { error: Object.assign(new Error('missing'), { code: 'ENOTFOUND' }) },
    { error: Object.assign(new Error('temporary'), { code: 'EAI_AGAIN' }) },
  ]) {
    const { state, run } = fixture(input)
    const result = await run({ family: 4 })
    assert.deepEqual(result, { address: '140.82.112.3', family: 4 })
    assert.equal(state.lookups, 1)
    assert.equal(state.resolvers, 1)
    assert.deepEqual(state.records, [['raw.githubusercontent.com', 4]])
    assert.equal(state.logs[0][1].event, 'pricing_dns_fallback')
  }
})

test('mixed/private answers are denied without using fallback to bypass the decision', async () => {
  const { state, run } = fixture({
    system: [
      { address: '140.82.112.3', family: 4 },
      { address: '127.0.0.1', family: 4 },
      { address: '198.18.0.61', family: 4 },
    ],
  })
  await assert.rejects(run(), /阻止访问内网/)
  assert.equal(state.resolvers, 0)
})

test('independent DNS must also reject private, Fake-IP, empty and malformed results', async () => {
  for (const ipv4 of [['127.0.0.1'], ['198.18.0.2'], ['140.82.112.3', '10.0.0.1'], [], ['invalid']]) {
    const { run } = fixture({ system: [{ address: '198.18.0.61', family: 4 }], ipv4 })
    await assert.rejects(run(), /阻止访问内网|解析失败|无效地址/)
  }
  const { run } = fixture({
    system: [],
    error: Object.assign(new Error('missing'), { code: 'ENOTFOUND' }),
    fail: true,
  })
  await assert.rejects(run(), /HTTPS DNS/)
})

test('IPv6 safety covers expanded loopback, mapped, multicast, local and documentation addresses', () => {
  for (const address of [
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '3fff::1',
    '169.254.169.254',
    '203.0.113.5',
  ]) {
    assert.ok(privateIpReason(address), address)
  }
  assert.equal(privateIpReason('2606:4700:4700::1111'), null)
  assert.equal(privateIpReason('140.82.112.3'), null)
})

test('each redirected host performs a fresh validated lookup rather than reusing prior targets', async () => {
  let calls = 0
  const dnsClient = {
    lookup(hostname, _options, callback) {
      calls++
      callback(null, [{ address: hostname === 'first.example' ? '140.82.112.3' : '10.0.0.1', family: 4 }])
    },
  }
  const lookup = createPricingDnsLookup({ label: 'redirect', dnsClient, log: () => {} })
  const run = (host) =>
    new Promise((resolve, reject) =>
      lookup(host, { all: true }, (error, result) => (error ? reject(error) : resolve(result))),
    )
  assert.equal((await run('first.example'))[0].address, '140.82.112.3')
  await assert.rejects(run('second.example'), /阻止访问内网/)
  assert.equal(calls, 2)
})

const httpsFixture = ({ statusCode = 200, body, oversized = false, pending = false }) => {
  const request = new EventEmitter()
  let destroyed = false
  request.destroy = (error) => {
    destroyed = true
    request.emit('error', error)
  }
  const httpsClient = {
    get(url, options, callback) {
      assert.equal(url.hostname, 'cloudflare-dns.com')
      assert.equal(options.rejectUnauthorized, true)
      assert.equal(options.agent, false)
      assert.equal(options.headers.accept, 'application/dns-json')
      options.lookup(url.hostname, { all: true }, (error, addresses) => {
        assert.equal(error, null)
        assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }])
      })
      if (!pending)
        queueMicrotask(() => {
          const response = new EventEmitter()
          response.statusCode = statusCode
          response.resume = () => {}
          callback(response)
          if (statusCode !== 200) return
          response.emit('data', oversized ? Buffer.alloc(65537) : Buffer.from(JSON.stringify(body)))
          response.emit('end')
        })
      return request
    },
  }
  return { httpsClient, destroyed: () => destroyed }
}
const query = (httpsClient) =>
  queryDnsHttps({
    resolver: { url: 'https://cloudflare-dns.com/dns-query', address: '1.1.1.1' },
    hostname: 'raw.githubusercontent.com',
    family: 4,
    httpsClient,
  })

test('HTTPS DNS pins its own connection, validates TLS, and extracts only the requested record family', async () => {
  const fixture = httpsFixture({
    body: {
      Status: 0,
      Answer: [
        { type: 5, data: 'alias.example' },
        { type: 1, data: '140.82.112.3' },
        { type: 28, data: '2606:4700::1111' },
      ],
    },
  })
  assert.deepEqual(await query(fixture.httpsClient), [{ address: '140.82.112.3', family: 4 }])
})

test('HTTPS DNS rejects HTTP/DNS failure and oversized bodies without following redirects', async () => {
  await assert.rejects(query(httpsFixture({ statusCode: 302 }).httpsClient), /HTTP 302/)
  await assert.rejects(query(httpsFixture({ body: { Status: 3 } }).httpsClient), /Status=3/)
  const fixture = httpsFixture({ oversized: true })
  await assert.rejects(query(fixture.httpsClient), /64 KiB/)
  assert.equal(fixture.destroyed(), true)
})

test('HTTPS DNS has a total deadline even if no response arrives', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = httpsFixture({ pending: true })
  const result = query(fixture.httpsClient)
  context.mock.timers.tick(3000)
  await assert.rejects(result, /超时/)
  assert.equal(fixture.destroyed(), true)
})
