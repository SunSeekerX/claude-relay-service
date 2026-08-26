import fs from 'node:fs'
import path from 'node:path'
import { GPT56_SERIES_FALLBACK_PRICING } from './pricing_gpt56_series_pricing.js'
import https from 'node:https'
import http from 'node:http'
import dns from 'node:dns'
import crypto from 'node:crypto'
import { pricingSource } from '../../../config/pricingSource.js'
import { pricingOverrides } from '../../../config/pricingOverrides.js'
import { logger } from '../../common/logger.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { createEncryptor } from '../../common/common_helper.js'
import { internalToLiteLLM, modelNameBasename } from './pricing_model_pricing_convert.js'
import { modelService } from './pricing_model_service.js'
import { GROK_MEDIA_FALLBACK_PRICING, resolveGrokMediaUnitPrices } from './pricing_grok_media_pricing.js'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let _redis = null
const getRedis = () => {
  if (!_redis) {
    _redis = require('../../infra/redis.js').redis
  }
  return _redis
}

// 定价源 URL 的 query 可能带私有 token（私有仓库 raw 链接、带签名的 CDN 地址），
// 按项目约定敏感值必须 AES 加密存储：落 Redis 时只加密 query，origin+path 保持明文以便运维排查。
const encryptor = createEncryptor('pricing-source-salt')

// 远端响应体上限:定价源可由管理端改成任意地址,无上限时超大/无限响应会累积到内存后才解析,
// 直接把进程打满。上游 litellm 全量定价约 1.5MB,16MB 留足余量。
const MAX_PRICING_BYTES = 16 * 1024 * 1024
// 哈希文件只有一行 sha256,给 1KB 足够
const MAX_HASH_BYTES = 1024
// 重定向跟随上限:GitHub/CDN 通常 1-2 跳,5 跳足够且能挡住跳转环
const MAX_REDIRECTS = 5

// 落库用:origin 明文(便于运维核对"数据从哪个站来"),pathname + query 一起加密。
//
// 为什么连 pathname 也加密:凭据不只出现在 query。签名式地址会把 token 放进路径,
// 例如 /token/SECRET/prices.json、/s/AbCdEf123/pricing.json —— 只加密 query 的话
// 这类凭据仍会明文进 Redis、进日志、并由状态接口回显。既然无法穷举凭据的位置,
// 就把除 origin 以外的整段都当敏感数据处理。
const splitUrlForStorage = (url) => {
  const parsed = new URL(url)
  // pathname 恒以 '/' 开头,解密后据此判断是否解出了有效内容(见 joinUrlFromStorage)
  const secret = `${parsed.pathname}${parsed.search}`
  return {
    base: parsed.origin,
    pathEncrypted: encryptor.encrypt(secret),
  }
}

// 读库用:还原完整 URL。解密失败返回空串(视为"没有配置自定义源")并告警——
// 换过 ENCRYPTION_KEY 的实例解不出旧值,此时路径都拿不到、拼不出可用地址,
// 只能回落默认源(由 resolveSource 处理),但绝不能抛错中断定价服务。
//
// 关键:commonHelper 的 decrypt() 解密失败【不抛错,而是原样返回入参密文】(见其 catch),
// 所以不能靠 try/catch 判失败,必须按返回值形态判断:成功解出的内容必以 '/' 开头(pathname),
// 而密文是 "ivHex:cipherHex"。少了这一判,会把 iv:ciphertext 当路径拼进 URL。
const joinUrlFromStorage = (base, pathEncrypted, label) => {
  if (!base || !pathEncrypted) {
    return ''
  }
  const decrypted = encryptor.decrypt(pathEncrypted)
  if (!decrypted.startsWith('/')) {
    logger.warn(`⚠️  ${label} 解密失败(可能换过 ENCRYPTION_KEY)，将回落默认源`)
    return ''
  }
  return `${base}${decrypted}`
}

// 判定一个 IP 字面量是否属于禁止访问的网段。纯函数,字面量校验与 DNS 解析后校验共用,
// 保证"填 IP"和"填域名解析出 IP"两条路的口径完全一致(不一致就等于留后门)。
// 返回被命中的原因字符串,未命中返回 null。
const privateIpReason = (ip) => {
  const addr = String(ip || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')

  const ipv4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b, c] = ipv4.slice(1).map(Number)
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
    // 非公网可路由的 IANA 特殊用途段(RFC 6890)。定价源不可能合法落在这些段里,
    // 而 DNS 劫持/内网解析常把域名指到这里(本机 WSL 的 DNS 就把 example.com 指到 198.18.2.42)
    if (a === 192 && b === 0 && (c === 0 || c === 2)) {
      return 'IETF 协议保留段'
    }
    if (a === 192 && b === 88 && c === 99) {
      return '6to4 中继任播段'
    }
    if (a === 198 && (b === 18 || b === 19)) {
      return '网络设备基准测试段'
    }
    if (a === 198 && b === 51 && c === 100) {
      return '文档示例段'
    }
    if (a === 203 && b === 0 && c === 113) {
      return '文档示例段'
    }
    if (a === 0 || a >= 224) {
      return '保留网段'
    }
    return null
  }

  if (addr.includes(':')) {
    if (addr === '::' || addr === '::1') {
      return '回环/未指定地址'
    }
    // new URL() 会把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1,故按 "::" 前缀整段拒绝;
    // dns.lookup 返回的 IPv4-mapped 仍是点分形态,上面的 ipv4 分支已覆盖
    if (addr.startsWith('::')) {
      return 'IPv4-mapped/compatible 地址'
    }
    if (/^(fc|fd)/.test(addr)) {
      return '唯一本地地址'
    }
    if (/^fe[89ab]/.test(addr)) {
      return '链路本地地址'
    }
    return null
  }

  return null
}

// 定价源地址进日志/回显前只保留 origin,丢掉 pathname、query 与 userinfo。
// 与 splitUrlForStorage 同口径:凭据可能在 query(?token=)也可能在路径(/token/SECRET/…),
// 无法穷举,所以除 origin 以外一律隐去。比 upstreamErrorHelper.sanitizeUrl(按已知参数名脱敏)更硬。
// 管理端要核对"数据从哪个站来"看 origin 足够;要看完整地址应查自己填写时的记录。
const maskUrl = (url) => {
  if (!url) {
    return url
  }
  try {
    const parsed = new URL(url)
    // 有路径或参数时标注省略号,让管理端知道"这里还有内容,只是没显示"
    const suffix = parsed.pathname !== '/' || parsed.search ? '/…' : ''
    return `${parsed.origin}${suffix}`
  } catch {
    return '[invalid-url]'
  }
}

class PricingService {
  constructor() {
    this.dataDir = path.join(process.cwd(), 'data')
    this.pricingFile = path.join(this.dataDir, 'model_pricing.json')
    // 生效源由 resolveSource() 运行时解析:Redis(管理端可改) > config/pricingSource.js(env > 默认)
    // 这两个字段只是"当前生效值"的缓存快照,供 getStatus 回显;下载/校验一律先 resolveSource()
    this.pricingUrl = pricingSource.pricingUrl
    this.hashUrl = pricingSource.hashUrl
    this.sourceFromRedis = false
    this.fallbackFile = path.join(process.cwd(), 'resources', 'model-pricing', 'model_prices_and_context_window.json')
    this.localHashFile = path.join(this.dataDir, 'model_pricing.sha256')
    this.pricingData = null
    this.lastUpdated = null
    this.updateInterval = 24 * 60 * 60 * 1000 // 24小时
    this.hashCheckInterval = 10 * 60 * 1000 // 10分钟哈希校验
    this.fileWatcher = null // 文件监听器
    this.reloadDebounceTimer = null // 防抖定时器
    this.hashCheckTimer = null // 哈希轮询定时器
    this.updateTimer = null // 定时更新任务句柄
    this.hashSyncInProgress = false // 哈希同步状态

    // Claude Prompt Caching 官方倍率（基于输入价格）— 仅作为 model_pricing.json 缺失字段时的兜底
    this.claudeCacheMultipliers = {
      write5m: 1.25,
      write1h: 2,
      read: 0.1,
    }

    // Claude 扩展计费特性
    this.claudeFeatureFlags = {
      context1mBeta: 'context-1m-2025-08-07',
      fastModeBeta: 'fast-mode-2026-02-01',
      fastModeSpeed: 'fast',
    }

    // [人工决策-2026-08-24 11:33:43] 覆盖层配置校验必须在构造期（= 模块加载期）做，
    // 抛出的错误直接冒泡到 require，进程起不来。
    //
    // 不能放在 initialize()/loadPricingData() 里：那条链上每一层都有 catch —— 校验抛错会被
    // loadPricingData 捕获后转 useFallbackPricing，fallback 再抛再被捕获，最终 pricingData={}，
    // 而 initialize() 又吞掉异常照常返回。结果是「服务正常启动但定价表为空」，
    // 所有请求落到静态/unknown 回退价，比它要防的静默改价更糟，且 fail-fast 形同虚设。
    //
    // 这是纯静态配置检查（不读网络/磁盘/Redis），没有"降级运行"的语义：配错就该起不来。
    this._assertPricingOverridesSafe()
  }

  // 判断一个定价字段是否参与计费。覆盖层禁止改这类字段（见 _assertPricingOverridesSafe）。
  //
  // 用「模式匹配 + 默认拒绝」而不是列举允许项：定价源字段有 100+ 个且随上游增长，
  // 白名单式列举漏一个就等于放开一个改价入口。反过来只要命中任一计费语义就拒绝：
  // ① cost/price —— 全部 49 个单价字段；② provider_specific_entry —— Claude fast 倍率在此；
  // ③ multiplier —— 区域加价等倍率；④ tier —— supports_service_tier 影响档位选择。
  _isBillingRelevantPricingField(field) {
    const name = String(field).toLowerCase()
    return (
      name.includes('cost') ||
      name.includes('price') ||
      name.includes('multiplier') ||
      name.includes('tier') ||
      name === 'provider_specific_entry'
    )
  }

  // 校验覆盖层配置，命中计费字段直接抛错。
  //
  // 只在构造期调用（见构造函数末尾）——那是这条链上唯一没有 catch 包裹的位置，
  // 抛错能冒泡到 require 真正阻止启动。放到加载路径里会被吞成「定价表为空」，见构造函数注释。
  //
  // [人工决策-2026-08-24 11:33:43] 「只允许非计费字段」必须是代码强制而非注释约定。
  // 覆盖层跑在全部 4 条定价加载路径上，若容许改价字段，一次误填就会静默改写实收金额，
  // 且因为定价表读的是同一份数据、展示与实收会一起错、无从对账发现。故：fail-fast 优于告警。
  _assertPricingOverridesSafe() {
    const violations = []
    for (const [modelName, patch] of Object.entries(pricingOverrides)) {
      if (!patch || typeof patch !== 'object') {
        violations.push(`${modelName}: 覆盖内容必须是对象`)
        continue
      }
      for (const field of Object.keys(patch)) {
        if (this._isBillingRelevantPricingField(field)) {
          violations.push(`${modelName}.${field}`)
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `config/pricingOverrides.js 禁止覆盖计费相关字段（定价源是价格的唯一权威源）：${violations.join(', ')}`,
      )
    }
  }

  // 应用 config/pricingOverrides.js 的本地字段修正（原地改 jsonData）。
  // 收口成单点：pricingData 有 4 个数据入口（远程下载/本地加载/fallback/文件监听重载），
  // 逐个 merge 必然漏掉一处、导致「刷新后覆盖消失」这类偶发不一致。
  // 只覆盖源里已存在的模型：源里没有的模型说明该条目已过期或写错了 key，补一个孤立条目
  // 只会凭空造出定价表里不存在的行，不如报出来让人删。
  _applyPricingOverrides(jsonData) {
    if (!jsonData || typeof jsonData !== 'object') {
      return jsonData
    }

    // 不在此处校验：本函数的 4 个调用点全都被 try/catch 包着，在这里抛错只会被吞成
    // 「定价表为空」而非 fail-fast。校验已前移到构造期（见构造函数末尾），
    // 那里抛错能真正阻止进程启动。配置是静态的，进程存续期内不会变，校验一次即足够。

    const applied = []
    const stale = []
    for (const [modelName, patch] of Object.entries(pricingOverrides)) {
      const target = jsonData[modelName]
      if (!target || typeof target !== 'object') {
        stale.push(modelName)
        continue
      }
      const changedFields = []
      for (const [field, value] of Object.entries(patch)) {
        if (target[field] !== value) {
          target[field] = value
          changedFields.push(field)
        }
      }
      // 源值已与覆盖值一致 = 覆盖变冗余，按下线条件提示可删
      if (changedFields.length > 0) {
        applied.push(`${modelName}(${changedFields.join(',')})`)
      } else {
        stale.push(`${modelName}(源值已一致)`)
      }
    }

    if (applied.length > 0) {
      logger.info(`💰 已应用本地定价修正: ${applied.join(' ')}`)
    }
    if (stale.length > 0) {
      logger.warn(
        `💰 本地定价修正有冗余条目(源中缺失或源值已一致)，可从 config/pricingOverrides.js 移除: ${stale.join(' ')}`,
      )
    }
    return jsonData
  }

  // OpenAI service_tier → 价格档后缀链（按优先级，命中即用；全缺则基础价）。
  // 白名单判定（禁黑名单）：未知 tier 一律按基础价，避免上游新增档位被误当溢价档。
  //
  // priority/fast 是同一溢价档的两个名字（官方 Priority 已更名 Fast mode，Codex 客户端写 fast，
  // 回包统一归一为 priority），只认 priority 会漏 fast 按基础价少收。
  //
  // [人工决策-2026-08-24 11:33:43] scale 不是溢价档，一律按基础价：不得映射到 _priority，
  // 也不得记为 0（两个方向都错过一次，这里把结论钉死，勿再改动）。
  //
  // 为什么不是 _priority：官方 Fast Mode 指南逐句排除了这种等价——
  // 「Scale Tier and Fast mode are separate.」「Fast mode requests have separate billing and
  // don't count against purchased Scale Tier TPM bundles.」「Scale Tier spillover traffic
  // doesn't automatically move to Fast mode.」且能 opt-in Fast 的只有 fast / priority 两个值。
  // 曾把 scale 当「同一档的旧代次名」并入 _priority，导致 Scale 请求系统性多收一倍。
  //
  // 为什么也不是 0（记 0 = 白送通道，是资损）：本服务的 service_tier 取值链是
  // 「上游回包优先、请求体兜底」，而请求体的 service_tier 完全由客户端控制且无白名单校验；
  // 官方响应的 service_tier 只会是 priority/default/fast/ultrafast/flex，从不回传 scale。
  // 所以一旦 scale 记 0，任何客户端只要在请求体写 service_tier:"scale" 就能免费——
  // realCost 直通 incrementDailyCost → usage:cost:total，而预付费余额正是由它派生
  // （见 payment/balanceLedger.js），等于余额不扣、白用。
  //
  // 「额度内 Scale 流量不该按 token 计价」这个反驳在 OpenAI 账单口径上成立，但不适用本服务：
  // usage:cost:total 记的是【中转服务对下游 API Key 的计价】（还要叠服务倍率与 Key 倍率），
  // 不是 OpenAI 对账户主体的账单；本项目也不销售、不追踪 Scale Tier 容量包（无任何相关建模）。
  // 推不出单请求真实成本时，按基础价与 default/未知 tier 同口径处理，是这里唯一安全的选择。
  // 定价源也从来没有 *_scale 字段可依。
  //
  // [人工决策-2026-08-24 11:33:43] ultrafast 暂按 Fast(_priority) 同价计费。
  // 官方已把 ultrafast 作为受控档（当前限 gpt-5.6-sol）、回包会带该值，但未公开任何价格，
  // 定价源也还没有 *_ultrafast 字段。不进白名单会整单按基础价漏收，故先并入溢价档；
  // 返回链把 _ultrafast 放在 _priority 之前——定价源日后补上该字段即自动生效，无需改码。
  // 若官方实际 ultrafast 高于 Fast，此期间仍偏少收（已知取舍，优于按基础价漏收）。
  _resolveServiceTierSuffix(serviceTier) {
    const tier = typeof serviceTier === 'string' ? serviceTier.trim().toLowerCase() : ''
    if (tier === 'ultrafast') {
      return ['_ultrafast', '_priority']
    }
    if (tier === 'priority' || tier === 'fast') {
      return ['_priority']
    }
    if (tier === 'flex') {
      return ['_flex']
    }
    return []
  }

  // usage 是否带 Claude 扩展计费信号（fast mode / 1M 上下文 beta）。
  // 这类信号只有 calculateCost 的详细分支认，legacy 分支会整单漏掉倍率，
  // 故 costCalculator 需据此判断走哪条分支——判定逻辑收口在此，避免两处各写一份
  hasClaudeBillingSignal(usage) {
    if (!usage || typeof usage !== 'object') {
      return false
    }
    const betaFeatures = this.extractBetaFeatures(usage)
    if (
      betaFeatures.has(this.claudeFeatureFlags.fastModeBeta) ||
      betaFeatures.has(this.claudeFeatureFlags.context1mBeta)
    ) {
      return true
    }
    const { responseSpeed, requestSpeed } = this.extractSpeedSignal(usage)
    return (
      responseSpeed === this.claudeFeatureFlags.fastModeSpeed || requestSpeed === this.claudeFeatureFlags.fastModeSpeed
    )
  }

  // 定价源中最小的长上下文档阈值（当前 200k）。低于它的请求不可能命中任何档，
  // 供 costCalculator 判断"是否需要走详细定价分支"，避免在那边写死具体阈值
  get minContextTierThreshold() {
    return 200000
  }

  // 从定价字段名里解析该模型有哪些长上下文档阈值（input_cost_per_token_above_272k_tokens → 272000）。
  // 不写死 272000：阈值随模型变，从数据推导才不会漏掉上游新增的档位
  _extractContextThresholds(pricing) {
    const thresholds = new Set()
    for (const field of Object.keys(pricing)) {
      const matched = field.match(/_above_(\d+)k_tokens/)
      if (matched) {
        thresholds.add(Number(matched[1]) * 1000)
      }
    }
    return Array.from(thresholds).sort((a, b) => b - a)
  }

  // 按「长上下文档 × service_tier 档」取价，逐级回退。litellm 的字段命名是
  // <base>[_above_{N}k_tokens][_priority|_flex]，但组合并不齐全（272k 只有 _flex 变体、
  // 200k 只有 _priority 变体），所以：
  // ① 有完整组合字段直接用；② 两档都命中但无组合字段时，用「长上下文档 ÷ 基础价」的官方比率
  //    去放大 tier 档价（两档是独立维度，对齐 sub2api 的 tier 价 × 长上下文倍率）；
  // ③ 只命中一档取该档字段；④ 都没有回退基础价
  //
  // tierSuffixes 是按优先级排的后缀链（如 ultrafast → ['_ultrafast','_priority']），
  // 取第一个在该模型定价里真实存在的后缀，故新档位只需登记链、无需等定价源补齐字段
  _resolveTieredPrice(pricing, baseField, contextSuffix, tierSuffixes) {
    const readField = (field) => {
      const value = pricing[field]
      return value === null || value === undefined ? null : value
    }
    const suffixes = Array.isArray(tierSuffixes) ? tierSuffixes : tierSuffixes ? [tierSuffixes] : []

    const basePrice = readField(baseField)
    if (!contextSuffix && suffixes.length === 0) {
      return basePrice
    }

    // 组合字段优先：按后缀链顺序找「长上下文档 + tier 档」的完整组合
    if (contextSuffix) {
      for (const suffix of suffixes) {
        const combined = readField(`${baseField}${contextSuffix}${suffix}`)
        if (combined !== null) {
          return combined
        }
      }
    }

    const contextPrice = contextSuffix ? readField(`${baseField}${contextSuffix}`) : null
    let tierPrice = null
    for (const suffix of suffixes) {
      const candidate = readField(`${baseField}${suffix}`)
      if (candidate !== null) {
        tierPrice = candidate
        break
      }
    }

    if (contextPrice !== null && tierPrice !== null) {
      // 比率法：基础价为 0 时比率无意义，退回两者较高者，避免长上下文请求被按低档少收
      if (basePrice) {
        return tierPrice * (contextPrice / basePrice)
      }
      return Math.max(contextPrice, tierPrice)
    }

    if (contextPrice !== null) {
      return contextPrice
    }
    if (tierPrice !== null) {
      return tierPrice
    }
    return basePrice
  }

  // 是否为 OpenAI 侧定价。长上下文档（272k）与 service_tier 档目前只对 OpenAI 生效：
  // Claude 200k 档由本文件既有分支处理（且 Claude 官方为平价），gemini 走各自链路不传 service_tier
  _isOpenAIPricing(modelName, pricing) {
    if (pricing?.litellm_provider === 'openai') {
      return true
    }
    const lowerName = typeof modelName === 'string' ? modelName.toLowerCase() : ''
    return /(^|[^a-z])(gpt|codex|o1|o3|o4)/.test(lowerName)
  }

  // 按 URL 协议选 http/https 模块。校验层放行 http:// 就必须能真的发出 http 请求
  _clientFor(url) {
    return url.startsWith('http://') ? http : https
  }

  // 第二道防线:DNS 解析后校验。传给 http.get 的 lookup 选项,把连接前的解析结果拦下来,
  // 解析出的任一 IP 命中禁止网段就直接失败。
  //
  // 这是闭合"内部域名 / 解析到私网的公网域名 / DNS rebinding"的关键——字面量黑名单做不到,
  // 因为要判的是解析结果而不是字面串。all:true 拿到全部记录逐个判(只判第一个会被多 A 记录绕过),
  // 校验通过后【只把已校验的地址交给连接】,不让底层再解析一次,消除"校验用一个结果、连接用另一个"
  // 的 TOCTOU 窗口(DNS rebinding 正是打这个窗口)。
  _guardedLookup(label) {
    return (hostname, options, callback) => {
      dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) {
          callback(error)
          return
        }
        const list = Array.isArray(addresses) ? addresses : [addresses]
        for (const entry of list) {
          const ip = entry?.address || entry
          const reason = privateIpReason(ip)
          if (reason) {
            logger.warn(`⚠️  ${label} 的域名 ${hostname} 解析到${reason}(${ip})，已阻止请求`)
            callback(new Error(`${label}的域名解析到${reason}，已阻止访问内网`))
            return
          }
        }
        // 回传已校验过的地址,不让底层重新解析(否则校验结果与实际连接目标可能不同)
        if (options?.all) {
          callback(null, list)
          return
        }
        const first = list[0]
        callback(null, first?.address || first, first?.family)
      })
    }
  }

  // 校验管理端提交的定价源地址(第一道:字面量)。定价源会被服务端主动请求(定时轮询 + 手动拉取),
  // 所以必须挡住"让服务端代为访问内网"和"把凭据存进 Redis/日志"两类问题。
  //
  // 两道防线共用 privateIpReason 判定,口径一致:
  //   本函数     = 字面量校验(填的是 IP 就直接判;域名只查黑名单)
  //   _guardedLookup = DNS 解析后校验(域名解析出的每个 IP 都判,挡内部域名/解析到私网/rebinding)
  // 错误消息不回显原始 URL:畸形 URL 的 query 可能带 token,而错误会进日志(见 maskUrl 的理由)。
  _assertSafeSourceUrl(rawUrl, label) {
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      // 只说"不是合法 URL",不带 rawUrl——非法 URL 无法用 URL 解析来剥 query,
      // 拼进消息就会把 ?token=xxx 原样带进 logger/console.error
      throw new Error(`${label}不是合法 URL（已隐去内容，请检查是否漏写协议或含非法字符）`)
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${label}必须以 http:// 或 https:// 开头`)
    }

    // 凭据不能出现在定价源地址里:该地址会存 Redis、写日志、并由状态接口回显给管理端,
    // 与项目"敏感凭据加密存储 + 日志脱敏"的约束冲突。需要鉴权的源请走网关或反代注入。
    if (parsed.username || parsed.password) {
      throw new Error(`${label}不能包含用户名/密码，请改用无凭据的公开地址`)
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')

    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '0.0.0.0') {
      throw new Error(`${label}不允许指向本机地址：${hostname}`)
    }

    // 容器/编排环境里指向宿主或集群内部的常见域名。快速失败用,
    // 真正兜底的是 _guardedLookup(解析后按 IP 判),故这里不必穷举
    const internalHosts = [
      'host.docker.internal',
      'gateway.docker.internal',
      'kubernetes.default',
      'metadata.google.internal',
      'instance-data',
    ]
    if (internalHosts.includes(hostname) || hostname.endsWith('.svc.cluster.local')) {
      throw new Error(`${label}不允许指向容器/集群内部地址：${hostname}`)
    }

    const reason = privateIpReason(hostname)
    if (reason) {
      throw new Error(`${label}不允许指向${reason}：${hostname}`)
    }

    return parsed.toString()
  }

  // 解析当前生效的定价源:Redis(管理端可改) > config/pricingSource.js(env > 默认)
  // Redis 不可用/无记录一律回落默认值,不抛错——定价源是配置读取,拿不到就用默认继续跑
  async resolveSource() {
    let stored = null
    try {
      // getClient() 未连接时返回 null(不抛),显式判空:定价源解析发生在启动早期,不该因此中断
      const client = getRedis().getClient()
      const raw = client ? await client.get(RedisKeys.pricingSource) : null
      if (raw) {
        stored = JSON.parse(raw)
      }
    } catch (error) {
      logger.warn(`⚠️  读取定价源配置失败,回落默认源：${error.message}`)
      console.error(error)
    }

    // 落库时 pathname+query 是加密的,这里拼回完整地址供实际请求使用。
    // 解密失败(换过 ENCRYPTION_KEY)时 joinUrlFromStorage 返回空串 —— 此时按"无自定义源"处理、
    // 回落默认源,而不是拿一个拼不全的地址去请求。
    const storedPricingUrl = stored?.pricingOrigin
      ? joinUrlFromStorage(stored.pricingOrigin, stored.pricingPathEncrypted, '定价 JSON 地址')
      : ''
    const overridden = Boolean(storedPricingUrl)

    // 自定义源生效时 hashUrl 原样生效(含空串=该源不提供 sha256,不回落默认源的哈希地址,
    // 否则会拿默认源的哈希与自定义源的文件比对、每轮都判定"有更新"从而反复下载)
    const pricingUrl = overridden ? storedPricingUrl : pricingSource.pricingUrl
    const hashUrl = overridden
      ? joinUrlFromStorage(stored.hashOrigin || '', stored.hashPathEncrypted, 'sha256 校验地址')
      : pricingSource.hashUrl
    this.sourceFromRedis = overridden
    this.pricingUrl = pricingUrl
    this.hashUrl = hashUrl
    return { pricingUrl, hashUrl }
  }

  // 管理端保存定价源。pricingUrl 为空视为「恢复默认」(删除 Redis 记录)
  // hashUrl 可空:留空表示该源不提供 sha256 校验文件,此时跳过哈希轮询、仅靠 24h 定时与手动刷新
  async setSource({ pricingUrl, hashUrl }) {
    const client = getRedis().getClientSafe()
    const trimmedPricingUrl = (pricingUrl || '').trim()
    const trimmedHashUrl = (hashUrl || '').trim()

    if (!trimmedPricingUrl) {
      await client.del(RedisKeys.pricingSource)
      logger.info('💰 定价源已恢复默认(删除 Redis 覆盖记录)')
    } else {
      // 校验通过后用 URL 归一化后的字符串落库(剥掉多余空白、统一编码)
      const safePricingUrl = this._assertSafeSourceUrl(trimmedPricingUrl, '定价 JSON 地址')
      const safeHashUrl = trimmedHashUrl ? this._assertSafeSourceUrl(trimmedHashUrl, 'sha256 校验地址') : ''

      // 落库:只有 origin 明文,pathname+query 加密(凭据可能在两者任一处,见 splitUrlForStorage)
      const pricingParts = splitUrlForStorage(safePricingUrl)
      const hashParts = safeHashUrl ? splitUrlForStorage(safeHashUrl) : { base: '', pathEncrypted: '' }

      await client.set(
        RedisKeys.pricingSource,
        JSON.stringify({
          pricingOrigin: pricingParts.base,
          pricingPathEncrypted: pricingParts.pathEncrypted,
          hashOrigin: hashParts.base,
          hashPathEncrypted: hashParts.pathEncrypted,
        }),
      )
      // 日志只记 origin+path,不记 query(校验已挡掉 userinfo,query 里仍可能带 token 形态的参数)
      logger.info(`💰 定价源已更新 pricingUrl=${maskUrl(safePricingUrl)} hashUrl=${maskUrl(safeHashUrl) || '-'}`)
    }

    await this.resolveSource()
    // 与 getStatus 同口径:返回脱敏值,调用方(管理端)只用于展示
    return { pricingUrl: maskUrl(this.pricingUrl), hashUrl: maskUrl(this.hashUrl) }
  }

  // 初始化价格服务
  async initialize() {
    try {
      // 确保data目录存在
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true })
        logger.info('📁 Created data directory')
      }

      // 先解析生效源(Redis 覆盖 > 默认),后续下载/校验都用它
      await this.resolveSource()

      // 检查是否需要下载或更新价格数据
      await this.checkAndUpdatePricing()

      // 初次启动时执行一次哈希校验，确保与远端保持一致
      await this.syncWithRemoteHash()

      // 设置定时更新
      if (this.updateTimer) {
        clearInterval(this.updateTimer)
      }
      this.updateTimer = setInterval(() => {
        this.checkAndUpdatePricing()
      }, this.updateInterval)

      // 设置哈希轮询
      this.setupHashCheck()

      // 设置文件监听器
      this.setupFileWatcher()

      logger.success('Pricing service initialized successfully')
    } catch (error) {
      logger.error('❌ Failed to initialize pricing service:', error)
    }
  }

  // 检查并更新价格数据
  async checkAndUpdatePricing() {
    try {
      const needsUpdate = this.needsUpdate()

      if (needsUpdate) {
        logger.info('🔄 Updating model pricing data...')
        await this.downloadPricingData()
      } else {
        // 如果不需要更新，加载现有数据
        await this.loadPricingData()
      }
    } catch (error) {
      logger.error('❌ Failed to check/update pricing:', error)
      // 如果更新失败，尝试使用fallback
      await this.useFallbackPricing()
    }
  }

  // 检查是否需要更新
  needsUpdate() {
    if (!fs.existsSync(this.pricingFile)) {
      logger.info('📋 Pricing file not found, will download')
      return true
    }

    const stats = fs.statSync(this.pricingFile)
    const fileAge = Date.now() - stats.mtime.getTime()

    if (fileAge > this.updateInterval) {
      logger.info(`📋 Pricing file is ${Math.round(fileAge / (60 * 60 * 1000))} hours old, will update`)
      return true
    }

    return false
  }

  // 下载价格数据
  async downloadPricingData() {
    try {
      await this._downloadFromRemote()
    } catch (downloadError) {
      logger.warn(`⚠️  Failed to download pricing data: ${downloadError.message}`)
      logger.info('📋 Using local fallback pricing data...')
      await this.useFallbackPricing()
    }
  }

  // 哈希轮询设置
  setupHashCheck() {
    if (this.hashCheckTimer) {
      clearInterval(this.hashCheckTimer)
    }

    this.hashCheckTimer = setInterval(() => {
      this.syncWithRemoteHash()
    }, this.hashCheckInterval)

    logger.info('🕒 已启用价格文件哈希轮询（每10分钟校验一次）')
  }

  // 与远端哈希对比
  async syncWithRemoteHash() {
    if (this.hashSyncInProgress) {
      return
    }

    this.hashSyncInProgress = true
    try {
      // 每轮重新解析:管理端改源后无需重启即生效
      const { hashUrl } = await this.resolveSource()
      if (!hashUrl) {
        logger.debug('💰 当前定价源未配置哈希文件地址,跳过哈希校验')
        return
      }

      const remoteHash = await this.fetchRemoteHash(hashUrl)

      if (!remoteHash) {
        return
      }

      const localHash = this.computeLocalHash()

      if (!localHash) {
        logger.info('📄 本地价格文件缺失，尝试下载最新版本')
        await this.downloadPricingData()
        return
      }

      if (remoteHash !== localHash) {
        logger.info('🔁 检测到远端价格文件更新，开始下载最新数据')
        await this.downloadPricingData()
      }
    } catch (error) {
      logger.warn(`⚠️  哈希校验失败：${error.message}`)
    } finally {
      this.hashSyncInProgress = false
    }
  }

  // 解析 3xx 的跳转目标。GitHub 文件链接、CDN 都会 302,不跟随会保存成功但拉取必失败。
  // 关键:跳转目标必须重跑 SSRF 校验——否则一个公网 URL 可以 302 到内网,把前置校验绕干净。
  // 返回 null 表示不是重定向。
  _resolveRedirect(response, currentUrl, remaining, label) {
    const status = response.statusCode
    if (![301, 302, 303, 307, 308].includes(status)) {
      return null
    }
    if (remaining <= 0) {
      throw new Error(`${label}重定向次数过多`)
    }
    const { location } = response.headers
    if (!location) {
      throw new Error(`${label}返回 ${status} 但缺少 Location 头`)
    }
    // 相对跳转按当前 URL 解析
    const target = new URL(location, currentUrl).toString()
    this._assertSafeSourceUrl(target, `${label}的重定向目标`)
    logger.debug(`[pricing] redirect status=${status} to=${maskUrl(target)}`)
    return target
  }

  // 获取远端哈希值
  fetchRemoteHash(hashUrl = this.hashUrl, redirectsLeft = MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
      const options = { lookup: this._guardedLookup('哈希文件') }
      const request = this._clientFor(hashUrl).get(hashUrl, options, (response) => {
        let redirectTarget
        try {
          redirectTarget = this._resolveRedirect(response, hashUrl, redirectsLeft, '哈希文件')
        } catch (error) {
          response.resume()
          reject(error)
          return
        }
        if (redirectTarget) {
          response.resume()
          this.fetchRemoteHash(redirectTarget, redirectsLeft - 1).then(resolve, reject)
          return
        }

        if (response.statusCode !== 200) {
          reject(new Error(`哈希文件获取失败：HTTP ${response.statusCode}`))
          return
        }

        let data = ''
        response.on('data', (chunk) => {
          data += chunk
          if (data.length > MAX_HASH_BYTES) {
            request.destroy()
            reject(new Error(`哈希文件超过大小上限 ${MAX_HASH_BYTES} 字节`))
          }
        })

        response.on('end', () => {
          const hash = data.trim().split(/\s+/)[0]

          if (!hash) {
            reject(new Error('哈希文件内容为空'))
            return
          }

          resolve(hash)
        })
      })

      request.on('error', (error) => {
        reject(new Error(`网络错误：${error.message}`))
      })

      request.setTimeout(30000, () => {
        request.destroy()
        reject(new Error('获取哈希超时（30秒）'))
      })
    })
  }

  // 计算本地文件哈希
  computeLocalHash() {
    if (!fs.existsSync(this.pricingFile)) {
      return null
    }

    if (fs.existsSync(this.localHashFile)) {
      const cached = fs.readFileSync(this.localHashFile, 'utf8').trim()
      if (cached) {
        return cached
      }
    }

    const fileBuffer = fs.readFileSync(this.pricingFile)
    return this.persistLocalHash(fileBuffer)
  }

  // 写入本地哈希文件
  persistLocalHash(content) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')
    fs.writeFileSync(this.localHashFile, `${hash}\n`)
    return hash
  }

  // 实际的下载逻辑。调用前先解析生效源,保证管理端改源后立即用新地址
  async _downloadFromRemote() {
    const { pricingUrl } = await this.resolveSource()
    return this._downloadFromUrl(pricingUrl)
  }

  _downloadFromUrl(pricingUrl, redirectsLeft = MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
      const options = { lookup: this._guardedLookup('定价文件') }
      const request = this._clientFor(pricingUrl).get(pricingUrl, options, (response) => {
        let redirectTarget
        try {
          redirectTarget = this._resolveRedirect(response, pricingUrl, redirectsLeft, '定价文件')
        } catch (error) {
          response.resume()
          reject(error)
          return
        }
        if (redirectTarget) {
          response.resume()
          this._downloadFromUrl(redirectTarget, redirectsLeft - 1).then(resolve, reject)
          return
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`))
          return
        }

        const chunks = []
        let received = 0
        response.on('data', (chunk) => {
          const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          received += bufferChunk.length
          // 超限立即断流:不能等 'end' 才判断,否则内存已经被吃掉了
          if (received > MAX_PRICING_BYTES) {
            request.destroy()
            reject(new Error(`定价文件超过大小上限 ${Math.round(MAX_PRICING_BYTES / 1024 / 1024)}MB`))
            return
          }
          chunks.push(bufferChunk)
        })

        response.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks)
            const rawContent = buffer.toString('utf8')
            const jsonData = JSON.parse(rawContent)

            // 保存到文件并更新哈希
            fs.writeFileSync(this.pricingFile, rawContent)
            this.persistLocalHash(buffer)

            // 更新内存中的数据
            this.pricingData = this._applyPricingOverrides(jsonData)
            this.lastUpdated = new Date()

            logger.success(`Downloaded pricing data for ${Object.keys(jsonData).length} models`)

            // 设置或重新设置文件监听器
            this.setupFileWatcher()

            resolve()
          } catch (error) {
            reject(new Error(`Failed to parse pricing data: ${error.message}`))
          }
        })
      })

      request.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`))
      })

      request.setTimeout(30000, () => {
        request.destroy()
        reject(new Error('Download timeout after 30 seconds'))
      })
    })
  }

  // 加载本地价格数据
  async loadPricingData() {
    try {
      if (fs.existsSync(this.pricingFile)) {
        const data = fs.readFileSync(this.pricingFile, 'utf8')
        this.pricingData = this._applyPricingOverrides(JSON.parse(data))

        const stats = fs.statSync(this.pricingFile)
        this.lastUpdated = stats.mtime

        logger.info(`💰 Loaded pricing data for ${Object.keys(this.pricingData).length} models from cache`)
      } else {
        logger.warn('💰 No pricing data file found, will use fallback')
        await this.useFallbackPricing()
      }
    } catch (error) {
      logger.error('❌ Failed to load pricing data:', error)
      await this.useFallbackPricing()
    }
  }

  // 使用fallback价格数据
  async useFallbackPricing() {
    try {
      if (fs.existsSync(this.fallbackFile)) {
        logger.info('📋 Copying fallback pricing data to data directory...')

        // 读取fallback文件
        const fallbackData = fs.readFileSync(this.fallbackFile, 'utf8')
        const jsonData = JSON.parse(fallbackData)

        const formattedJson = JSON.stringify(jsonData, null, 2)

        // 保存到data目录
        fs.writeFileSync(this.pricingFile, formattedJson)
        this.persistLocalHash(formattedJson)

        // 更新内存中的数据
        this.pricingData = this._applyPricingOverrides(jsonData)
        this.lastUpdated = new Date()

        // 设置或重新设置文件监听器
        this.setupFileWatcher()

        logger.warn(`⚠️  Using fallback pricing data for ${Object.keys(jsonData).length} models`)
        logger.info(
          '💡 Note: This fallback data may be outdated. The system will try to update from the remote source on next check.',
        )
      } else {
        logger.error('❌ Fallback pricing file not found at:', this.fallbackFile)
        logger.error('❌ Please ensure the resources/model-pricing directory exists with the pricing file')
        this.pricingData = {}
      }
    } catch (error) {
      logger.error('❌ Failed to use fallback pricing data:', error)
      this.pricingData = {}
    }
  }

  // 解析内部完整计费模型（延迟 require 避免启动环依赖）
  _getInternalBillingLiteLLM(modelName) {
    if (!modelName) {
      return null
    }
    try {
      const internal = modelService.getInternalBillingModel(modelName)
      if (!internal) {
        return null
      }
      const converted = internalToLiteLLM(internal)
      if (!converted) {
        return null
      }
      logger.debug(`💰 Using internal billing model for ${modelName}`)
      return this.ensureCachePricing(converted)
    } catch (error) {
      logger.warn(`⚠️ Failed to resolve internal billing model for ${modelName}`)
      console.error(error)
      return null
    }
  }

  // [人工决策-2026-08-24 20:52:04] 计费查价：内部完整模型整模优先，否则回落外部种子；禁止字段级 merge
  getModelPricing(modelName) {
    if (!modelName) {
      return null
    }

    const internalPricing = this._getInternalBillingLiteLLM(modelName)
    if (internalPricing) {
      return internalPricing
    }

    // 区域前缀模型：先试去前缀的内部名
    if (modelName.includes('.anthropic.') || modelName.includes('.claude')) {
      const withoutRegion = modelName.replace(/^(us|eu|apac)\./, '')
      const internalWithoutRegion = this._getInternalBillingLiteLLM(withoutRegion)
      if (internalWithoutRegion) {
        return internalWithoutRegion
      }
    }

    if (!this.pricingData) {
      return null
    }

    // 尝试直接匹配
    if (this.pricingData[modelName]) {
      logger.debug(`💰 Found exact pricing match for ${modelName}`)
      return this.pricingData[modelName]
    }

    // basename 双查（vendor/foo → foo）
    const baseName = modelNameBasename(modelName)
    if (baseName && baseName !== modelName && this.pricingData[baseName]) {
      logger.debug(`💰 Found pricing for ${modelName} via basename: ${baseName}`)
      return this.pricingData[baseName]
    }
    if (baseName && baseName !== modelName && GROK_MEDIA_FALLBACK_PRICING[baseName]) {
      logger.debug(`💰 Using bundled Grok media fallback pricing for basename ${baseName}`)
      return this.ensureCachePricing({ ...GROK_MEDIA_FALLBACK_PRICING[baseName] })
    }

    // Grok Imagine 媒体：LiteLLM 种子未收录时的官方价兜底（内部模型优先已在上方处理）
    if (GROK_MEDIA_FALLBACK_PRICING[modelName]) {
      logger.debug(`💰 Using bundled Grok media fallback pricing for ${modelName}`)
      return this.ensureCachePricing({ ...GROK_MEDIA_FALLBACK_PRICING[modelName] })
    }

    // 特殊处理：gpt-5.5 回退到 gpt-5
    if (modelName === 'gpt-5.5' && !this.pricingData['gpt-5.5']) {
      const fallbackPricing = this.pricingData['gpt-5']
      if (fallbackPricing) {
        logger.info(`💰 Using gpt-5 pricing as fallback for ${modelName}`)
        return fallbackPricing
      }
    }

    // gpt-5.6 系列（含 sol/terra/luna）：禁止回退 gpt-5（价差 4 倍会少计费）
    // 优先内存表 → 内置官方价兜底
    if (modelName.startsWith('gpt-5.6')) {
      if (this.pricingData[modelName]) {
        return this.pricingData[modelName]
      }
      if (GPT56_SERIES_FALLBACK_PRICING[modelName]) {
        logger.warn(`💰 Using bundled gpt-5.6 series fallback pricing for ${modelName} (not in pricing table)`)
        return this.ensureCachePricing({ ...GPT56_SERIES_FALLBACK_PRICING[modelName] })
      }
      // 未知 5.6 变体：回退到 gpt-5.6 base 官方价，绝不回 gpt-5
      if (GPT56_SERIES_FALLBACK_PRICING['gpt-5.6']) {
        logger.warn(`💰 Unknown ${modelName}; using bundled gpt-5.6 base pricing (not gpt-5)`)
        return this.ensureCachePricing({ ...GPT56_SERIES_FALLBACK_PRICING['gpt-5.6'] })
      }
    }

    // 对于Bedrock区域前缀模型（如 us.anthropic.claude-sonnet-4-20250514-v1:0），
    // 尝试去掉区域前缀进行匹配
    if (modelName.includes('.anthropic.') || modelName.includes('.claude')) {
      // 提取不带区域前缀的模型名
      const withoutRegion = modelName.replace(/^(us|eu|apac)\./, '')
      if (this.pricingData[withoutRegion]) {
        logger.debug(`💰 Found pricing for ${modelName} by removing region prefix: ${withoutRegion}`)
        return this.pricingData[withoutRegion]
      }
    }

    // 尝试模糊匹配（处理版本号等变化）
    const normalizedModel = modelName.toLowerCase().replace(/[_-]/g, '')

    for (const [key, value] of Object.entries(this.pricingData)) {
      const normalizedKey = key.toLowerCase().replace(/[_-]/g, '')
      if (normalizedKey.includes(normalizedModel) || normalizedModel.includes(normalizedKey)) {
        logger.debug(`💰 Found pricing for ${modelName} using fuzzy match: ${key}`)
        return value
      }
    }

    // 对于Bedrock模型，尝试更智能的匹配
    if (modelName.includes('anthropic.claude')) {
      // 提取核心模型名部分（去掉区域和前缀）
      const coreModel = modelName.replace(/^(us|eu|apac)\./, '').replace('anthropic.', '')

      for (const [key, value] of Object.entries(this.pricingData)) {
        if (key.includes(coreModel) || key.replace('anthropic.', '').includes(coreModel)) {
          logger.debug(`💰 Found pricing for ${modelName} using Bedrock core model match: ${key}`)
          return value
        }
      }
    }

    logger.debug(`💰 No pricing found for model: ${modelName}`)
    return null
  }

  // 确保价格对象包含缓存价格
  ensureCachePricing(pricing) {
    if (!pricing) {
      return pricing
    }

    // 如果缺少缓存价格，根据输入价格计算（缓存创建价格通常是输入价格的1.25倍，缓存读取是0.1倍）
    if (!pricing.cache_creation_input_token_cost && pricing.input_cost_per_token) {
      pricing.cache_creation_input_token_cost = pricing.input_cost_per_token * 1.25
    }
    if (!pricing.cache_read_input_token_cost && pricing.input_cost_per_token) {
      pricing.cache_read_input_token_cost = pricing.input_cost_per_token * 0.1
    }
    return pricing
  }

  // 从 usage 对象中提取 beta 特性列表（小写）
  extractBetaFeatures(usage) {
    const features = new Set()
    if (!usage || typeof usage !== 'object') {
      return features
    }

    const requestHeaders = usage.request_headers || usage.requestHeaders || null
    const headerBeta =
      requestHeaders && typeof requestHeaders === 'object'
        ? requestHeaders['anthropic-beta'] || requestHeaders['Anthropic-Beta'] || requestHeaders['ANTHROPIC-BETA']
        : null

    const candidates = [
      usage.anthropic_beta,
      usage.anthropicBeta,
      usage.request_anthropic_beta,
      usage.requestAnthropicBeta,
      usage.beta_header,
      usage.betaHeader,
      usage.beta_features,
      headerBeta,
    ]

    const addFeature = (value) => {
      if (!value || typeof value !== 'string') {
        return
      }
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .forEach((item) => features.add(item))
    }

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        candidate.forEach(addFeature)
      } else {
        addFeature(candidate)
      }
    }

    return features
  }

  // 提取请求/响应中的 speed 字段（小写）
  extractSpeedSignal(usage) {
    if (!usage || typeof usage !== 'object') {
      return { responseSpeed: '', requestSpeed: '' }
    }

    const normalize = (value) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '')

    return {
      responseSpeed: normalize(usage.speed),
      requestSpeed: normalize(usage.request_speed || usage.requestSpeed),
    }
  }

  // 去掉模型名中的 [1m] 后缀，便于价格查找
  stripLongContextSuffix(modelName) {
    if (typeof modelName !== 'string') {
      return modelName
    }
    return modelName.replace(/\[1m\]/gi, '').trim()
  }

  // LiteLLM / Grok 分档 非 token 单价（$/张、$/次、$/秒）
  // usage 可带 image_size/image_quality/video_resolution，用于 xAI 分档选价
  _unitPricesFromPricing(pricing, usage = null) {
    if (!pricing || typeof pricing !== 'object') {
      return {
        imageOutputPrice: 0,
        imageInputPrice: 0,
        requestPrice: 0,
        queryPrice: 0,
        audioInputPerSecond: 0,
        audioOutputPerSecond: 0,
        videoInputPerSecond: 0,
        videoOutputPerSecond: 0,
      }
    }
    // Grok Imagine：仅当定价对象自身带分档表时按分辨率/质量选价
    // （内部模型反转不会带回 metadata 里的 xai_*_tiers，避免盖掉管理员扁平改价）
    if (pricing.xai_image_output_tiers || pricing.xai_video_output_tiers) {
      return resolveGrokMediaUnitPrices(pricing, usage || {})
    }
    const num = (v) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : 0
    }
    return {
      imageOutputPrice: num(pricing.output_cost_per_image),
      imageInputPrice: num(pricing.input_cost_per_image),
      requestPrice: num(pricing.input_cost_per_request),
      queryPrice: num(pricing.input_cost_per_query),
      audioInputPerSecond: num(pricing.input_cost_per_audio_per_second ?? pricing.input_cost_per_second),
      audioOutputPerSecond: num(pricing.output_cost_per_audio_per_second ?? pricing.output_cost_per_second),
      videoInputPerSecond: num(pricing.input_cost_per_video_per_second),
      videoOutputPerSecond: num(pricing.output_cost_per_video_per_second),
    }
  }

  // 计算使用费用。serviceTier 为客户端请求/上游回包中的 OpenAI service_tier（priority/fast/flex 等）
  calculateCost(usage, modelName, serviceTier = null) {
    const normalizedModelName = this.stripLongContextSuffix(modelName)

    // 检查是否为 1M 上下文模型（用户通过 [1m] 后缀主动选择长上下文模式）
    const isLongContextModel = typeof modelName === 'string' && modelName.includes('[1m]')
    let isLongContextRequest = false
    let useLongContextPricing = false

    // 计算总输入 tokens（用于判断是否超过 200K 阈值）
    const inputTokens = usage.input_tokens || 0
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0
    const cacheReadTokens = usage.cache_read_input_tokens || 0
    const totalInputTokens = inputTokens + cacheCreationTokens + cacheReadTokens

    // 识别 Claude 特性标识
    const betaFeatures = this.extractBetaFeatures(usage)
    const hasContext1mBeta = betaFeatures.has(this.claudeFeatureFlags.context1mBeta)
    const hasFastModeBeta = betaFeatures.has(this.claudeFeatureFlags.fastModeBeta)
    const { responseSpeed, requestSpeed } = this.extractSpeedSignal(usage)
    const hasFastSpeedSignal =
      responseSpeed === this.claudeFeatureFlags.fastModeSpeed || requestSpeed === this.claudeFeatureFlags.fastModeSpeed
    const isFastModeRequest = hasFastModeBeta && hasFastSpeedSignal
    const standardPricing = this.getModelPricing(modelName)
    const pricing = standardPricing
    const isLongContextModeEnabled = isLongContextModel || hasContext1mBeta
    // Per official Anthropic pricing: all Claude models have flat pricing with no 200K+ premium
    // https://platform.claude.com/docs/en/about-claude/pricing
    const ignores200kLongContextPricing =
      (typeof normalizedModelName === 'string' && normalizedModelName.toLowerCase().includes('claude')) ||
      (typeof standardPricing?.litellm_provider === 'string' &&
        standardPricing.litellm_provider.toLowerCase().includes('anthropic'))

    // Fast Mode 倍率：优先从 provider_specific_entry.fast 读取，默认 6 倍
    const fastMultiplier = isFastModeRequest ? pricing?.provider_specific_entry?.fast || 6 : 1

    // 当 [1m] 模型总输入超过 200K 时，进入 200K+ 计费逻辑
    // 根据 Anthropic 官方文档：当总输入超过 200K 时，整个请求所有 token 类型都使用高档价格
    if (isLongContextModeEnabled && totalInputTokens > 200000) {
      if (ignores200kLongContextPricing) {
        logger.info(
          `💰 Skipping 200K+ pricing for ${modelName}: Claude models use flat pricing regardless of context length`,
        )
      } else {
        isLongContextRequest = true
        useLongContextPricing = true
        logger.info(
          `💰 Using 200K+ pricing for ${modelName}: total input tokens = ${totalInputTokens.toLocaleString()}`,
        )
      }
    }

    if (!pricing) {
      return {
        inputCost: 0,
        outputCost: 0,
        cacheCreateCost: 0,
        cacheReadCost: 0,
        ephemeral5mCost: 0,
        ephemeral1hCost: 0,
        totalCost: 0,
        hasPricing: false,
        isLongContextRequest: false,
      }
    }

    // OpenAI 侧档位：service_tier 溢价档 + 长上下文档（如 gpt-5.4/5.5/5.6 的 272k）。
    // 两者是独立维度，可同时命中；阈值从定价字段推导，不写死
    const isOpenAIPricing = this._isOpenAIPricing(normalizedModelName, pricing)
    // 后缀链（数组）：空数组 = 未命中溢价档，判空必须看 length，不能靠真值
    const tierSuffixes = isOpenAIPricing ? this._resolveServiceTierSuffix(serviceTier) : []
    let contextSuffix = ''
    let openaiContextThreshold = 0
    if (isOpenAIPricing) {
      for (const threshold of this._extractContextThresholds(pricing)) {
        if (totalInputTokens > threshold) {
          openaiContextThreshold = threshold
          contextSuffix = `_above_${threshold / 1000}k_tokens`
          break
        }
      }
    }
    const useOpenAITieredPricing = tierSuffixes.length > 0 || !!contextSuffix
    if (openaiContextThreshold > 0) {
      isLongContextRequest = true
      logger.info(
        `💰 OpenAI long-context pricing for ${modelName}: total input ${totalInputTokens.toLocaleString()} > ${openaiContextThreshold.toLocaleString()}`,
      )
    }
    if (tierSuffixes.length > 0) {
      logger.info(
        `💰 service_tier=${serviceTier} pricing tier ${tierSuffixes.join('>')} applied for ${normalizedModelName}`,
      )
    }

    const isClaudeModel =
      (modelName && modelName.toLowerCase().includes('claude')) ||
      (typeof pricing?.litellm_provider === 'string' && pricing.litellm_provider.toLowerCase().includes('anthropic'))

    if (isFastModeRequest && fastMultiplier > 1) {
      logger.info(
        `🚀 Fast mode ${fastMultiplier}x multiplier applied for ${normalizedModelName} (from provider_specific_entry)`,
      )
    } else if (isFastModeRequest) {
      logger.warn(
        `⚠️ Fast mode request detected but no fast pricing found for ${normalizedModelName}; fallback to standard profile`,
      )
    }

    // OpenAI 档位命中时整单改走档位价，跳过下方 Claude 200k 分支（两套阈值语义不同，互不叠加）
    if (useOpenAITieredPricing) {
      const tieredPrice = (baseField) => this._resolveTieredPrice(pricing, baseField, contextSuffix, tierSuffixes) || 0
      const tieredInputPrice = tieredPrice('input_cost_per_token')
      // OpenAI 多数模型不单列 cache-write 价，出现 cache creation token 时按输入价兜底（与 costCalculator 同口径）
      const tieredCacheCreatePrice = tieredPrice('cache_creation_input_token_cost') || tieredInputPrice
      const tieredOutputPrice = tieredPrice('output_cost_per_token') || tieredPrice('output_cost_per_image_token') || 0
      return this._buildCostResult(usage, {
        inputPrice: tieredInputPrice || tieredPrice('input_cost_per_image_token') || 0,
        outputPrice: tieredOutputPrice,
        cacheCreatePrice: tieredCacheCreatePrice,
        cacheReadPrice:
          tieredPrice('cache_read_input_token_cost') || tieredPrice('cache_read_input_image_token_cost') || 0,
        ephemeral1hPrice: tieredPrice('cache_creation_input_token_cost_above_1hr') || tieredCacheCreatePrice,
        isLongContextRequest,
        ...this._unitPricesFromPricing(pricing, usage),
      })
    }

    const baseInputPrice = pricing.input_cost_per_token || pricing.input_cost_per_image_token || 0
    const hasInput200kPrice =
      pricing.input_cost_per_token_above_200k_tokens !== null &&
      pricing.input_cost_per_token_above_200k_tokens !== undefined

    // 确定实际使用的输入价格（普通或 200K+ 高档价格）
    // Claude 模型在 200K+ 场景下如果缺少官方字段，按 2 倍输入价兜底
    let actualInputPrice = useLongContextPricing
      ? hasInput200kPrice
        ? pricing.input_cost_per_token_above_200k_tokens
        : isClaudeModel
          ? baseInputPrice * 2
          : baseInputPrice
      : baseInputPrice

    // 图片模型常只有 output_cost_per_image_token，无 output_cost_per_token
    const baseOutputPrice = pricing.output_cost_per_token || pricing.output_cost_per_image_token || 0
    const hasOutput200kPrice =
      pricing.output_cost_per_token_above_200k_tokens !== null &&
      pricing.output_cost_per_token_above_200k_tokens !== undefined
    let actualOutputPrice = useLongContextPricing
      ? hasOutput200kPrice
        ? pricing.output_cost_per_token_above_200k_tokens
        : baseOutputPrice
      : baseOutputPrice

    // 缓存价格：优先从 model_pricing.json 取，Claude 缺失时用倍率兜底
    let actualCacheCreatePrice
    let actualCacheReadPrice
    let actualEphemeral1hPrice

    if (useLongContextPricing) {
      // 200K+：Claude 仅用 above_200k 专用字段，缺失留 0 让下方兜底从 actualInputPrice 推导
      actualCacheCreatePrice = isClaudeModel
        ? pricing.cache_creation_input_token_cost_above_200k_tokens || 0
        : pricing.cache_creation_input_token_cost_above_200k_tokens || pricing.cache_creation_input_token_cost || 0
      actualCacheReadPrice = isClaudeModel
        ? pricing.cache_read_input_token_cost_above_200k_tokens || 0
        : pricing.cache_read_input_token_cost_above_200k_tokens || pricing.cache_read_input_token_cost || 0
      const has1h200k =
        pricing.cache_creation_input_token_cost_above_1hr_above_200k_tokens !== null &&
        pricing.cache_creation_input_token_cost_above_1hr_above_200k_tokens !== undefined
      actualEphemeral1hPrice = has1h200k
        ? pricing.cache_creation_input_token_cost_above_1hr_above_200k_tokens
        : isClaudeModel
          ? 0
          : pricing.cache_creation_input_token_cost_above_1hr || 0
    } else {
      actualCacheCreatePrice = pricing.cache_creation_input_token_cost || 0
      actualCacheReadPrice = pricing.cache_read_input_token_cost || 0
      actualEphemeral1hPrice = pricing.cache_creation_input_token_cost_above_1hr || 0
    }

    // Claude 兜底：pricing 字段缺失时用倍率从 actualInputPrice 推导
    // 此时 actualInputPrice 尚未含 fastMultiplier，下方统一应用
    if (isClaudeModel) {
      if (!actualCacheCreatePrice) {
        actualCacheCreatePrice = actualInputPrice * this.claudeCacheMultipliers.write5m
      }
      if (!actualCacheReadPrice) {
        actualCacheReadPrice = actualInputPrice * this.claudeCacheMultipliers.read
      }
      if (!actualEphemeral1hPrice) {
        actualEphemeral1hPrice = actualInputPrice * this.claudeCacheMultipliers.write1h
      }
    }

    // Fast Mode 倍率：统一一次性应用于所有价格
    if (fastMultiplier > 1) {
      actualInputPrice *= fastMultiplier
      actualOutputPrice *= fastMultiplier
      actualCacheCreatePrice *= fastMultiplier
      actualCacheReadPrice *= fastMultiplier
      actualEphemeral1hPrice *= fastMultiplier
    }

    return this._buildCostResult(usage, {
      inputPrice: actualInputPrice,
      outputPrice: actualOutputPrice,
      cacheCreatePrice: actualCacheCreatePrice,
      cacheReadPrice: actualCacheReadPrice,
      ephemeral1hPrice: actualEphemeral1hPrice,
      isLongContextRequest,
      ...this._unitPricesFromPricing(pricing, usage),
    })
  }

  // token 用量 × 单价 → 费用（纯函数）。单价由上游各档位分支算好后传入，
  // 缓存分桶口径收口在此，杜绝各分支各写一份
  // 从 usage 取非负有限数量（张数/秒/次数）
  _usageCount(usage, keys) {
    if (!usage || typeof usage !== 'object') {
      return 0
    }
    for (const key of keys) {
      const num = Number(usage[key])
      if (Number.isFinite(num) && num > 0) {
        return num
      }
    }
    return 0
  }

  _buildCostResult(usage, prices) {
    const { inputPrice, outputPrice, cacheCreatePrice, cacheReadPrice, ephemeral1hPrice } = prices
    const inputCost = (usage.input_tokens || 0) * inputPrice
    const outputCost = (usage.output_tokens || 0) * outputPrice

    let ephemeral5mCost = 0
    let ephemeral1hCost = 0
    let cacheCreateCost = 0

    if (usage.cache_creation && typeof usage.cache_creation === 'object') {
      // 有详细的缓存创建数据：5m 走 cache_creation 价，1h 走 ephemeral_1h 价
      ephemeral5mCost = (usage.cache_creation.ephemeral_5m_input_tokens || 0) * cacheCreatePrice
      ephemeral1hCost = (usage.cache_creation.ephemeral_1h_input_tokens || 0) * ephemeral1hPrice
      cacheCreateCost = ephemeral5mCost + ephemeral1hCost
    } else if (usage.cache_creation_input_tokens) {
      // 旧格式，所有缓存创建 tokens 都按 5 分钟价格计算（向后兼容）
      cacheCreateCost = usage.cache_creation_input_tokens * cacheCreatePrice
      ephemeral5mCost = cacheCreateCost
    }

    const cacheReadCost = (usage.cache_read_input_tokens || 0) * cacheReadPrice

    // 非 token 单价：按图/请求/查询/音视频秒（usage 有量才计；路由需传入 image_count 等）
    const imageOutCount = this._usageCount(usage, ['image_count', 'num_images', 'output_images'])
    const imageInCount = this._usageCount(usage, ['input_image_count', 'input_images'])
    const requestCount = this._usageCount(usage, ['request_count', 'num_requests'])
    const queryCount = this._usageCount(usage, ['query_count', 'num_queries'])
    const audioInSec = this._usageCount(usage, ['audio_input_seconds', 'input_audio_seconds'])
    const audioOutSec = this._usageCount(usage, ['audio_output_seconds', 'output_audio_seconds'])
    const videoInSec = this._usageCount(usage, ['video_input_seconds', 'input_video_seconds'])
    const videoOutSec = this._usageCount(usage, ['video_output_seconds', 'output_video_seconds'])

    const imageOutputCost = imageOutCount * (prices.imageOutputPrice || 0)
    const imageInputCost = imageInCount * (prices.imageInputPrice || 0)
    const requestCost = requestCount * (prices.requestPrice || 0)
    const queryCost = queryCount * (prices.queryPrice || 0)
    const audioInputCost = audioInSec * (prices.audioInputPerSecond || 0)
    const audioOutputCost = audioOutSec * (prices.audioOutputPerSecond || 0)
    const videoInputCost = videoInSec * (prices.videoInputPerSecond || 0)
    const videoOutputCost = videoOutSec * (prices.videoOutputPerSecond || 0)
    const unitCost =
      imageOutputCost +
      imageInputCost +
      requestCost +
      queryCost +
      audioInputCost +
      audioOutputCost +
      videoInputCost +
      videoOutputCost

    return {
      inputCost,
      outputCost,
      cacheCreateCost,
      cacheReadCost,
      ephemeral5mCost,
      ephemeral1hCost,
      imageOutputCost,
      imageInputCost,
      requestCost,
      queryCost,
      audioInputCost,
      audioOutputCost,
      videoInputCost,
      videoOutputCost,
      unitCost,
      totalCost: inputCost + outputCost + cacheCreateCost + cacheReadCost + unitCost,
      hasPricing: true,
      isLongContextRequest: prices.isLongContextRequest === true,
      pricing: {
        input: inputPrice,
        output: outputPrice,
        cacheCreate: cacheCreatePrice,
        cacheRead: cacheReadPrice,
        ephemeral1h: ephemeral1hPrice,
        imageOutput: prices.imageOutputPrice || 0,
        imageInput: prices.imageInputPrice || 0,
        request: prices.requestPrice || 0,
        query: prices.queryPrice || 0,
      },
    }
  }

  // 格式化价格显示
  formatCost(cost) {
    if (cost === 0) {
      return '$0.000000'
    }
    if (cost < 0.000001) {
      return `$${cost.toExponential(2)}`
    }
    if (cost < 0.01) {
      return `$${cost.toFixed(6)}`
    }
    if (cost < 1) {
      return `$${cost.toFixed(4)}`
    }
    return `$${cost.toFixed(2)}`
  }

  // 获取服务状态。source 段回显当前生效源,供管理端展示"数据从哪来"
  // 生效价表：外部种子为底，内部完整计费模型整模覆盖（不是字段 merge）
  getEffectivePricingData() {
    const seed = this.pricingData && typeof this.pricingData === 'object' ? this.pricingData : {}
    const effective = { ...seed }
    // 种子未收录的 Grok 媒体默认模型：补进生效价表，管理端可见、可导入内部
    for (const [name, pricing] of Object.entries(GROK_MEDIA_FALLBACK_PRICING)) {
      if (!effective[name]) {
        effective[name] = { ...pricing }
      }
    }
    // gpt-5.6 系列内置官方价：种子缺失时补进生效表（管理端详情/计费一致）
    for (const [name, pricing] of Object.entries(GPT56_SERIES_FALLBACK_PRICING)) {
      if (!effective[name]) {
        effective[name] = { ...pricing }
      }
    }
    try {
      for (const item of modelService.listInternalModels()) {
        if (!item.hasBilling) {
          continue
        }
        const record = modelService.getInternalBillingModel(item.id)
        const converted = internalToLiteLLM(record)
        if (converted) {
          effective[item.id] = converted
        }
      }
    } catch (error) {
      logger.warn('⚠️ Failed to merge internal billing models into effective pricing')
      console.error(error)
    }
    return effective
  }

  getStatus() {
    let internalBillingModels
    try {
      internalBillingModels = modelService.getStatus().internalBillingModels || 0
    } catch (_error) {
      internalBillingModels = 0
    }
    const effective = this.getEffectivePricingData()
    return {
      initialized: this.pricingData !== null,
      lastUpdated: this.lastUpdated,
      modelCount: Object.keys(effective).length,
      seedModelCount: this.pricingData ? Object.keys(this.pricingData).length : 0,
      internalBillingModels,
      nextUpdate: this.lastUpdated ? new Date(this.lastUpdated.getTime() + this.updateInterval) : null,
      // 回显一律走 maskUrl:状态接口是管理端可读的,而 env 配的源(PRICE_MIRROR_JSON_URL)
      // 也可能带私有 token,不能原样返回
      source: {
        pricingUrl: maskUrl(this.pricingUrl),
        hashUrl: maskUrl(this.hashUrl),
        custom: this.sourceFromRedis,
        defaultPricingUrl: maskUrl(pricingSource.pricingUrl),
        defaultHashUrl: maskUrl(pricingSource.hashUrl),
      },
    }
  }

  // 强制更新价格数据
  async forceUpdate() {
    try {
      await this._downloadFromRemote()
      return { success: true, message: 'Pricing data updated successfully' }
    } catch (error) {
      logger.error('❌ Force update failed:', error)
      logger.info('📋 Force update failed, using fallback pricing data...')
      await this.useFallbackPricing()
      return {
        success: false,
        message: `Download failed: ${error.message}. Using fallback pricing data instead.`,
      }
    }
  }

  // 设置文件监听器
  setupFileWatcher() {
    try {
      // 如果已有监听器，先关闭
      if (this.fileWatcher) {
        this.fileWatcher.close()
        this.fileWatcher = null
      }

      // 只有文件存在时才设置监听器
      if (!fs.existsSync(this.pricingFile)) {
        logger.debug('💰 Pricing file does not exist yet, skipping file watcher setup')
        return
      }

      // 使用 fs.watchFile 作为更可靠的文件监听方式
      // 它使用轮询，虽然性能稍差，但更可靠
      const watchOptions = {
        persistent: true,
        interval: 60000, // 每60秒检查一次
      }

      // 记录初始的修改时间
      let lastMtime = fs.statSync(this.pricingFile).mtimeMs

      fs.watchFile(this.pricingFile, watchOptions, (curr, _prev) => {
        // 检查文件是否真的被修改了（不仅仅是访问）
        if (curr.mtimeMs !== lastMtime) {
          lastMtime = curr.mtimeMs
          logger.debug(`💰 Detected change in pricing file (mtime: ${new Date(curr.mtime).toISOString()})`)
          this.handleFileChange()
        }
      })

      // 保存引用以便清理
      this.fileWatcher = {
        close: () => fs.unwatchFile(this.pricingFile),
      }

      logger.info('👁️  File watcher set up for model_pricing.json (polling every 60s)')
    } catch (error) {
      logger.error('❌ Failed to setup file watcher:', error)
    }
  }

  // 处理文件变化（带防抖）
  handleFileChange() {
    // 清除之前的定时器
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer)
    }

    // 设置新的定时器（防抖500ms）
    this.reloadDebounceTimer = setTimeout(async () => {
      logger.info('🔄 Reloading pricing data due to file change...')
      await this.reloadPricingData()
    }, 500)
  }

  // 重新加载价格数据
  async reloadPricingData() {
    try {
      // 验证文件是否存在
      if (!fs.existsSync(this.pricingFile)) {
        logger.warn('💰 Pricing file was deleted, using fallback')
        await this.useFallbackPricing()
        // 重新设置文件监听器（fallback会创建新文件）
        this.setupFileWatcher()
        return
      }

      // 读取文件内容
      const data = fs.readFileSync(this.pricingFile, 'utf8')

      // 尝试解析JSON
      const jsonData = JSON.parse(data)

      // 验证数据结构
      if (typeof jsonData !== 'object' || Object.keys(jsonData).length === 0) {
        throw new Error('Invalid pricing data structure')
      }

      // 更新内存中的数据
      this.pricingData = this._applyPricingOverrides(jsonData)
      this.lastUpdated = new Date()

      const modelCount = Object.keys(jsonData).length
      logger.success(`Reloaded pricing data for ${modelCount} models from file`)

      // 显示一些统计信息
      const claudeModels = Object.keys(jsonData).filter((k) => k.includes('claude')).length
      const gptModels = Object.keys(jsonData).filter((k) => k.includes('gpt')).length
      const geminiModels = Object.keys(jsonData).filter((k) => k.includes('gemini')).length

      logger.debug(`💰 Model breakdown: Claude=${claudeModels}, GPT=${gptModels}, Gemini=${geminiModels}`)
    } catch (error) {
      logger.error('❌ Failed to reload pricing data:', error)
      logger.warn('💰 Keeping existing pricing data in memory')
    }
  }

  // 清理资源
  cleanup() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer)
      this.updateTimer = null
      logger.debug('💰 Pricing update timer cleared')
    }
    if (this.fileWatcher) {
      this.fileWatcher.close()
      this.fileWatcher = null
      logger.debug('💰 File watcher closed')
    }
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    if (this.hashCheckTimer) {
      clearInterval(this.hashCheckTimer)
      this.hashCheckTimer = null
      logger.debug('💰 Hash check timer cleared')
    }
  }
}

export const pricingService = new PricingService()
