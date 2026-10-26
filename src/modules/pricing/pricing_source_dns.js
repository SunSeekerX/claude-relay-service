import dns from 'node:dns'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { pricingDnsResolvers } from '../../../config/pricingSource.js'

export const queryDnsHttps = ({ resolver, hostname, family, httpsClient = https }) =>
  new Promise((resolve, reject) => {
    const url = new URL(resolver.url)
    url.searchParams.set('name', hostname)
    url.searchParams.set('type', family === 4 ? 'A' : 'AAAA')
    let settled = false
    const finish = (error, addresses) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error) {
        reject(error)
      } else {
        resolve(addresses)
      }
    }
    const timer = setTimeout(() => {
      const error = new Error('独立 HTTPS DNS 查询超时（3秒）')
      request.destroy(error)
      finish(error)
    }, 3000)
    const request = httpsClient.get(
      url,
      {
        agent: false,
        rejectUnauthorized: true,
        headers: { accept: 'application/dns-json' },
        // URL/Host/SNI 仍是解析服务域名，只有 TCP 目标固定为可信公网 IP。
        lookup: (_host, options, callback) => {
          if (options?.all) {
            callback(null, [{ address: resolver.address, family: 4 }])
          } else {
            callback(null, resolver.address, 4)
          }
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          finish(new Error(`独立 HTTPS DNS 返回 HTTP ${response.statusCode}`))
          return
        }
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += Buffer.byteLength(chunk)
          if (size > 65536) {
            const error = new Error('独立 HTTPS DNS 响应超过 64 KiB')
            request.destroy(error)
            finish(error)
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        response.on('error', finish)
        response.on('aborted', () => finish(new Error('独立 HTTPS DNS 响应中断')))
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (body.Status !== 0 || (body.Answer !== undefined && !Array.isArray(body.Answer))) {
              throw new Error(`独立 HTTPS DNS 返回无效或失败结果（Status=${body.Status}）`)
            }
            finish(
              null,
              (body.Answer ?? [])
                .filter((answer) => answer.type === (family === 4 ? 1 : 28))
                .map((answer) => ({ address: answer.data, family })),
            )
          } catch (error) {
            finish(error)
          }
        })
      },
    )
    request.on('error', finish)
  })

export const resolvePricingDnsHttps = async (hostname, options) => {
  const family = typeof options === 'number' ? options : options?.family
  let cause
  for (const resolver of pricingDnsResolvers) {
    const queries = []
    if (family !== 6) {
      queries.push(queryDnsHttps({ resolver, hostname, family: 4 }))
    }
    if (family !== 4) {
      queries.push(queryDnsHttps({ resolver, hostname, family: 6 }))
    }
    const results = await Promise.allSettled(queries)
    const addresses = results.filter((result) => result.status === 'fulfilled').flatMap((result) => result.value)
    if (addresses.length) {
      return { addresses, resolver: new URL(resolver.url).origin }
    }
    cause = results.find((result) => result.status === 'rejected')?.reason
  }
  throw new Error('独立 HTTPS DNS 解析失败，请检查 HTTPS DNS 网络连通性', { cause })
}

const reservedV6 = new BlockList()
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3ffe::', 16],
  ['3fff::', 20],
]) {
  reservedV6.addSubnet(address, prefix, 'ipv6')
}

export const isFakeIp = (ip) => /^198\.(18|19)\./.test(ip)

// URL 字面量、系统 DNS、独立 DNS 和每跳重定向共用同一地址边界。
export const privateIpReason = (ip) => {
  const address = String(ip)
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    if (a === 127) {
      return '回环地址'
    }
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return '私有网段'
    }
    if (a === 169 && b === 254) {
      return '链路本地/云元数据地址'
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return 'CGNAT 网段'
    }
    if (a === 192 && b === 0 && (c === 0 || c === 2)) {
      return 'IETF 协议保留段'
    }
    if (a === 192 && b === 88 && c === 99) {
      return '6to4 中继任播段'
    }
    if (isFakeIp(address)) {
      return '网络设备基准测试段'
    }
    if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) {
      return '文档示例段'
    }
    if (a === 0 || a >= 224) {
      return '保留网段'
    }
  }
  if (isIP(address) === 6) {
    const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1)
    if (!/^[23]/.test(canonical) || reservedV6.check(canonical, 'ipv6')) {
      return '非公网 IPv6 地址'
    }
  }
  return null
}

export const createPricingDnsLookup = ({ label, log, dnsClient = dns, resolvePublic = resolvePricingDnsHttps }) => {
  const validate = (entries) => {
    if (!entries.length) {
      throw new Error(`${label}域名没有可连接的地址`)
    }
    for (const entry of entries) {
      if (!isIP(entry.address) || isIP(entry.address) !== entry.family) {
        throw new Error(`${label}DNS 返回无效地址`)
      }
      const reason = privateIpReason(entry.address)
      if (reason) {
        throw new Error(`${label}域名解析到${reason}，已阻止访问内网`)
      }
    }
    return entries
  }
  const fallback = async (hostname, options, reason) => {
    const { addresses, resolver } = await resolvePublic(hostname, options)
    validate(addresses)
    log('定价源已切换到独立 DNS，连接固定为已校验的公网 IP', {
      event: 'pricing_dns_fallback',
      hostname,
      reason,
      addresses: addresses.map((entry) => entry.address),
      resolver,
    })
    return addresses
  }
  return (hostname, options, callback) => {
    const finish = (entries) => {
      if (options?.all) {
        callback(null, entries)
      } else {
        callback(null, entries[0].address, entries[0].family)
      }
    }
    dnsClient.lookup(
      hostname,
      { ...(typeof options === 'number' ? { family: options } : options), all: true },
      (error, entries) => {
        const list = Array.isArray(entries) ? entries : entries ? [entries] : []
        const fallbackError =
          error && ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'EAI_FAIL'].includes(error.code)
        const hasFakeIp = list.some((entry) => isFakeIp(entry.address))
        const hasPrivateIp = list.some((entry) => privateIpReason(entry.address) && !isFakeIp(entry.address))
        if (hasPrivateIp) {
          try {
            validate(list)
          } catch (failure) {
            callback(failure)
          }
          return
        }
        if (fallbackError || (!error && hasFakeIp)) {
          fallback(hostname, options, error?.code ?? 'Fake-IP').then(finish, callback)
          return
        }
        if (error) {
          callback(error)
          return
        }
        try {
          finish(validate(list))
        } catch (failure) {
          callback(failure)
        }
      },
    )
  }
}
