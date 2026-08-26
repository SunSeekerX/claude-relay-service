// xAI Grok Imagine 媒体模型价兜底
// LiteLLM 种子未收录这些 id 时，未传 model 的媒体请求会落到默认名；查价 miss 会 0 元。
// [人工决策-2026-08-25 10:12:52] 官方分档价硬兜底（含分辨率/质量）；内部完整计费模型整模优先仍可覆盖。
// 价源：https://docs.x.ai/developers/pricing
// 无分辨率/质量时取该模型最低输出档（少收风险低于盲压单一中档；明确传了高档必须按高档收）

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// 输出图分档：key = 1k|2k 或 1k_low|2k_low|1k_medium|2k_medium
// 输出视频分档：key = 480p|720p|1080p
export const GROK_MEDIA_FALLBACK_PRICING = {
  'grok-imagine-image': {
    litellm_provider: 'xai',
    mode: 'image_generation',
    input_cost_per_image: 0.002,
    // 文档：标准档 1K/2K 同价 $0.02
    output_cost_per_image: 0.02,
    xai_image_output_tiers: {
      '1k': 0.02,
      '2k': 0.02,
    },
  },
  'grok-imagine-edit': {
    litellm_provider: 'xai',
    mode: 'image_generation',
    input_cost_per_image: 0.002,
    output_cost_per_image: 0.02,
    xai_image_output_tiers: {
      '1k': 0.02,
      '2k': 0.02,
    },
  },
  'grok-imagine': {
    litellm_provider: 'xai',
    mode: 'image_generation',
    input_cost_per_image: 0.002,
    output_cost_per_image: 0.02,
    xai_image_output_tiers: {
      '1k': 0.02,
      '2k': 0.02,
    },
  },
  'grok-imagine-image-quality': {
    litellm_provider: 'xai',
    mode: 'image_generation',
    input_cost_per_image: 0.01,
    // 默认展示/未传分辨率：1K
    output_cost_per_image: 0.05,
    xai_image_output_tiers: {
      '1k': 0.05,
      '2k': 0.07,
    },
  },
  'grok-imagine-image-2.0': {
    litellm_provider: 'xai',
    mode: 'image_generation',
    input_cost_per_image: 0.01,
    // 默认：1K low
    output_cost_per_image: 0.04,
    // 分辨率 × 质量
    xai_image_output_tiers: {
      '1k_low': 0.04,
      '2k_low': 0.06,
      '1k_medium': 0.06,
      '2k_medium': 0.08,
    },
  },
  'grok-imagine-video': {
    litellm_provider: 'xai',
    mode: 'video_generation',
    input_cost_per_image: 0.002,
    input_cost_per_video_per_second: 0.01,
    // 默认 480p
    output_cost_per_video_per_second: 0.05,
    xai_video_output_tiers: {
      '480p': 0.05,
      '720p': 0.07,
    },
  },
  'grok-imagine-video-1.5': {
    litellm_provider: 'xai',
    mode: 'video_generation',
    input_cost_per_image: 0.01,
    input_cost_per_video_per_second: 0.01,
    // 默认 480p
    output_cost_per_video_per_second: 0.08,
    xai_video_output_tiers: {
      '480p': 0.08,
      '720p': 0.14,
      '1080p': 0.25,
    },
  },
}

// 从 size 字符串推断 1k/2k（像素最长边 >=1536 视为 2k）
export const resolveImageResolution = (size) => {
  const text = String(size || '')
    .trim()
    .toLowerCase()
  if (!text) {
    return '1k'
  }
  // 先解析 WxH，避免 1792x1024 被 includes('1024') 误判成 1k
  const matched = text.match(/(\d+)\s*[x×*]\s*(\d+)/)
  if (matched) {
    const maxEdge = Math.max(Number(matched[1]), Number(matched[2]))
    if (Number.isFinite(maxEdge) && maxEdge >= 1536) {
      return '2k'
    }
    return '1k'
  }
  if (text.includes('2k') || text.includes('2048') || text.includes('1920')) {
    return '2k'
  }
  if (text.includes('1k') || text.includes('1024') || text.includes('512')) {
    return '1k'
  }
  return '1k'
}

// low | medium（2.0 质量档）；其它/空 → low
export const resolveImageQuality = (quality) => {
  const text = String(quality || '')
    .trim()
    .toLowerCase()
  if (!text) {
    return 'low'
  }
  if (text.includes('med') || text.includes('high') || text === 'hd' || text === '2') {
    return 'medium'
  }
  return 'low'
}

// 480p | 720p | 1080p
export const resolveVideoResolution = (resolution, size) => {
  const text = `${resolution || ''} ${size || ''}`.trim().toLowerCase()
  if (!text) {
    return '480p'
  }
  if (text.includes('1080') || text.includes('1920') || text.includes('1k') || text.includes('fhd')) {
    return '1080p'
  }
  if (text.includes('720') || text.includes('hd')) {
    return '720p'
  }
  if (text.includes('480') || text.includes('sd')) {
    return '480p'
  }
  const matched = text.match(/(\d+)\s*[x×*]\s*(\d+)/)
  if (matched) {
    const minEdge = Math.min(Number(matched[1]), Number(matched[2]))
    if (minEdge >= 1000) {
      return '1080p'
    }
    if (minEdge >= 700) {
      return '720p'
    }
    return '480p'
  }
  return '480p'
}

// 按 usage 中的分辨率/质量从分档表取输出单价；无分档则回落扁平字段
export const resolveGrokMediaUnitPrices = (pricing, usage = {}) => {
  const base = {
    imageOutputPrice: num(pricing?.output_cost_per_image),
    imageInputPrice: num(pricing?.input_cost_per_image),
    requestPrice: num(pricing?.input_cost_per_request),
    queryPrice: num(pricing?.input_cost_per_query),
    audioInputPerSecond: num(pricing?.input_cost_per_audio_per_second ?? pricing?.input_cost_per_second),
    audioOutputPerSecond: num(pricing?.output_cost_per_audio_per_second ?? pricing?.output_cost_per_second),
    videoInputPerSecond: num(pricing?.input_cost_per_video_per_second),
    videoOutputPerSecond: num(pricing?.output_cost_per_video_per_second),
  }

  if (!pricing || typeof pricing !== 'object') {
    return base
  }

  const imageTiers = pricing.xai_image_output_tiers
  if (imageTiers && typeof imageTiers === 'object') {
    const res = resolveImageResolution(usage.image_size || usage.size || usage.resolution)
    const quality = resolveImageQuality(usage.image_quality || usage.quality)
    // 优先 分辨率_质量 复合键（2.0），否则纯分辨率键（quality 模型）
    const compound = `${res}_${quality}`
    if (imageTiers[compound] !== null) {
      base.imageOutputPrice = num(imageTiers[compound])
    } else if (imageTiers[res] !== null) {
      base.imageOutputPrice = num(imageTiers[res])
    } else {
      // 分档表有值但 key 未命中：取表内最高价，避免高档请求落到默认低价少收
      const tierValues = Object.values(imageTiers)
        .map(num)
        .filter((v) => v > 0)
      if (tierValues.length) {
        base.imageOutputPrice = Math.max(...tierValues)
      }
    }
  }

  const videoTiers = pricing.xai_video_output_tiers
  if (videoTiers && typeof videoTiers === 'object') {
    const res = resolveVideoResolution(usage.video_resolution || usage.resolution, usage.video_size || usage.size)
    if (videoTiers[res] !== null) {
      base.videoOutputPerSecond = num(videoTiers[res])
    } else {
      // 未识别分辨率：若请求像高档（1080）但表无该键，取最高；否则取 480p/最低
      const keys = Object.keys(videoTiers)
      if (res === '1080p' || res === '720p') {
        const tierValues = Object.values(videoTiers)
          .map(num)
          .filter((v) => v > 0)
        if (tierValues.length) {
          base.videoOutputPerSecond = Math.max(...tierValues)
        }
      } else if (videoTiers['480p'] !== null) {
        base.videoOutputPerSecond = num(videoTiers['480p'])
      } else if (keys.length) {
        base.videoOutputPerSecond = num(videoTiers[keys[0]])
      }
    }
  }

  return base
}
