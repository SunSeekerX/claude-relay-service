// 模型列表展示排序（对齐 llysc server model_sort.ts）
// 主流商固定在前，组内按版本号/日期戳降序

// 主流提供商优先级（越前越靠上）；未列出的按字母序排在后面
const PROVIDER_ORDER = [
  'anthropic',
  'openai',
  'gemini_generate',
  'google',
  'gemini',
  'vertex',
  'bedrock',
  'azure',
  'deepseek',
  'xai',
  'grok',
  'mistral',
  'cohere',
  'meta',
  'meta_llama',
  'qwen'
]

// 平台聚合前缀：vertex_ai-openai 等须先按平台归组，避免 includes 命中内嵌子厂商
const PROVIDER_UMBRELLA = ['vertex', 'bedrock', 'azure']

const providerRank = (provider) => {
  const p = String(provider || '').toLowerCase()
  const umbrella = PROVIDER_UMBRELLA.find((key) => p.startsWith(key))
  if (umbrella) return PROVIDER_ORDER.indexOf(umbrella)
  const idx = PROVIDER_ORDER.findIndex((key) => p.includes(key))
  return idx >= 0 ? idx : PROVIDER_ORDER.length
}

// 解析名字：版本元组 + 日期戳
export const parseNameVersion = (name) => {
  let s = String(name || '')
  let dateScore = 0
  const bump = (value) => {
    if (value > dateScore) dateScore = value
  }

  s = s.replace(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g, (m) => {
    const [y, mo, d] = m.split('-')
    bump(Number(y) * 10000 + Number(mo) * 100 + Number(d))
    return ' '
  })
  s = s.replace(/\b(?:19|20)\d{6}\b/g, (m) => {
    bump(Number(m))
    return ' '
  })
  s = s.replace(/\b\d{2}-(?:19|20)\d{2}\b/g, (m) => {
    const [mo, y] = m.split('-')
    bump(Number(y) * 10000 + Number(mo) * 100)
    return ' '
  })
  s = s.replace(/\b(?:19|20)\d{2}\b/g, (m) => {
    bump(Number(m) * 10000)
    return ' '
  })

  const ver = []
  const tokens = s.match(/\d+(?:\.\d+)?/g) || []
  for (const tok of tokens) {
    if (tok.includes('.')) {
      for (const seg of tok.split('.')) ver.push(Number(seg))
    } else if (tok.length < 4) {
      ver.push(Number(tok))
    } else if (tok.length === 4) {
      // 4 位无年份后缀当 MMDD 快照；1/2 月 +1200 跨年修正（对齐 llysc）
      const mm = Number(tok.slice(0, 2))
      const score = mm >= 1 && mm <= 2 ? Number(tok) + 1200 : Number(tok)
      bump(score)
    }
  }
  return { ver, dateScore }
}

const compareInProvider = (aName, bName) => {
  const va = parseNameVersion(aName)
  const vb = parseNameVersion(bName)
  const len = Math.max(va.ver.length, vb.ver.length)
  for (let i = 0; i < len; i++) {
    const x = va.ver[i] ?? -1
    const y = vb.ver[i] ?? -1
    if (x !== y) return y - x
  }
  const da = va.dateScore || Infinity
  const db = vb.dateScore || Infinity
  if (da !== db) return db - da
  return String(aName).localeCompare(String(bName))
}

// 整表排序：提供商 rank → 同 rank 时 provider 名字母序 → 组内版本/日期降序
export const sortModelsForDisplay = (models) => {
  return [...models].sort((a, b) => {
    const ra = providerRank(a.provider ?? '')
    const rb = providerRank(b.provider ?? '')
    if (ra !== rb) return ra - rb
    const pa = String(a.provider ?? '').toLowerCase()
    const pb = String(b.provider ?? '').toLowerCase()
    if (pa !== pb) return pa.localeCompare(pb)
    return compareInProvider(a.name ?? a.id ?? '', b.name ?? b.id ?? '')
  })
}

export const compareModelsForDisplay = (a, b) => {
  const ra = providerRank(a.provider ?? '')
  const rb = providerRank(b.provider ?? '')
  if (ra !== rb) return ra - rb
  const pa = String(a.provider ?? '').toLowerCase()
  const pb = String(b.provider ?? '').toLowerCase()
  if (pa !== pb) return pa.localeCompare(pb)
  return compareInProvider(a.name ?? a.id ?? '', b.name ?? b.id ?? '')
}
