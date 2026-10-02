const DEFAULT_ANTIGRAVITY_MODEL = 'gemini-2.5-flash'

// DEC_20261001_114137 上游模型对齐 CLIProxyAPI registry antigravity（2026-09-15）；
// 已下线 gemini-3-pro-high/low 与 3.1-pro-high，旧别名重定向到 gemini-pro-agent / gemini-3.1-pro-low
const UPSTREAM_TO_ALIAS = {
  'rev19-uic3-1p': 'gemini-2.5-computer-use-preview-10-2025',
  'gemini-3-pro-image': 'gemini-3-pro-image-preview',
  'gemini-pro-agent': 'gemini-3.1-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'claude-sonnet-4-5': 'gemini-claude-sonnet-4-5',
  'claude-sonnet-4-5-thinking': 'gemini-claude-sonnet-4-5-thinking',
  'claude-opus-4-5-thinking': 'gemini-claude-opus-4-5-thinking',
  'claude-opus-4-6-thinking': 'gemini-claude-opus-4-6-thinking',
  chat_20706: '',
  chat_23310: '',
  'gemini-2.5-flash-thinking': '',
  'gemini-3.1-pro-low': '',
  'gemini-2.5-pro': '',
}

const ALIAS_TO_UPSTREAM = {
  'gemini-2.5-computer-use-preview-10-2025': 'rev19-uic3-1p',
  'gemini-3-pro-image-preview': 'gemini-3-pro-image',
  'gemini-3-pro-preview': 'gemini-pro-agent',
  'gemini-3-pro-high': 'gemini-pro-agent',
  'gemini-3.1-pro-preview': 'gemini-pro-agent',
  'gemini-3.1-pro-high': 'gemini-pro-agent',
  'gemini-3-pro-low': 'gemini-3.1-pro-low',
  'gemini-3-flash-preview': 'gemini-3-flash',
  'gemini-claude-sonnet-4-5': 'claude-sonnet-4-5',
  'gemini-claude-sonnet-4-5-thinking': 'claude-sonnet-4-5-thinking',
  'gemini-claude-opus-4-5-thinking': 'claude-opus-4-5-thinking',
  'gemini-claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
  'gemini-claude-sonnet-4-6': 'claude-sonnet-4-6',
}

const ANTIGRAVITY_MODEL_METADATA = {
  'gemini-2.5-flash': {
    thinking: { min: 0, max: 24576, zeroAllowed: true, dynamicAllowed: true },
    name: 'models/gemini-2.5-flash',
  },
  'gemini-2.5-flash-lite': {
    thinking: { min: 0, max: 24576, zeroAllowed: true, dynamicAllowed: true },
    name: 'models/gemini-2.5-flash-lite',
  },
  'gemini-2.5-computer-use-preview-10-2025': {
    name: 'models/gemini-2.5-computer-use-preview-10-2025',
  },
  // 上游已重定向到 gemini-pro-agent
  'gemini-3-pro-preview': {
    thinking: {
      min: 1,
      max: 65535,
      zeroAllowed: false,
      dynamicAllowed: true,
      levels: ['low', 'medium', 'high'],
    },
    name: 'models/gemini-3-pro-preview',
  },
  'gemini-3-pro-image-preview': {
    thinking: {
      min: 128,
      max: 32768,
      zeroAllowed: false,
      dynamicAllowed: true,
      levels: ['low', 'high'],
    },
    name: 'models/gemini-3-pro-image-preview',
  },
  // 上游 gemini-pro-agent（Gemini 3.1 Pro High）
  'gemini-3.1-pro-preview': {
    thinking: {
      min: 1,
      max: 65535,
      zeroAllowed: false,
      dynamicAllowed: true,
      levels: ['low', 'medium', 'high'],
    },
    name: 'models/gemini-3.1-pro-preview',
  },
  'gemini-3-flash-preview': {
    thinking: {
      min: 128,
      max: 32768,
      zeroAllowed: false,
      dynamicAllowed: true,
      levels: ['minimal', 'low', 'medium', 'high'],
    },
    name: 'models/gemini-3-flash-preview',
  },
  'gemini-claude-sonnet-4-5-thinking': {
    thinking: { min: 1024, max: 64000, zeroAllowed: true, dynamicAllowed: true },
    maxCompletionTokens: 64000,
  },
  'gemini-claude-opus-4-5-thinking': {
    thinking: { min: 1024, max: 64000, zeroAllowed: true, dynamicAllowed: true },
    maxCompletionTokens: 64000,
  },
  'gemini-claude-opus-4-6-thinking': {
    thinking: { min: 1024, max: 64000, zeroAllowed: true, dynamicAllowed: true },
    maxCompletionTokens: 64000,
  },
  'gemini-claude-sonnet-4-6': {
    thinking: { min: 1024, max: 64000, zeroAllowed: true, dynamicAllowed: true },
    maxCompletionTokens: 64000,
  },
  'gemini-3.6-flash-high': {
    thinking: {
      min: 1,
      max: 65535,
      zeroAllowed: false,
      dynamicAllowed: true,
      levels: ['minimal', 'low', 'medium', 'high'],
    },
    name: 'models/gemini-3.6-flash-high',
  },
  'gemini-3.7-flash-high': {
    thinking: { min: 1, max: 65535, zeroAllowed: false, dynamicAllowed: true, levels: ['low', 'medium', 'high'] },
    name: 'models/gemini-3.7-flash-high',
  },
  'gemini-3.8-flash-high': {
    thinking: { min: 1, max: 65535, zeroAllowed: false, dynamicAllowed: true, levels: ['low', 'medium', 'high'] },
    name: 'models/gemini-3.8-flash-high',
  },
  'gemini-3.1-pro-low': {
    thinking: { min: 1, max: 65535, zeroAllowed: false, dynamicAllowed: true, levels: ['low', 'medium', 'high'] },
    name: 'models/gemini-3.1-pro-low',
  },
  'gemini-3.1-flash-image': {
    thinking: { min: 128, max: 32768, zeroAllowed: false, dynamicAllowed: true, levels: ['minimal', 'high'] },
    name: 'models/gemini-3.1-flash-image',
  },
  'gemini-3.1-flash-lite': {
    thinking: {
      min: 1,
      max: 65535,
      zeroAllowed: true,
      dynamicAllowed: true,
      levels: ['minimal', 'low', 'medium', 'high'],
    },
    name: 'models/gemini-3.1-flash-lite',
  },
  'gemini-3.5-flash-lite': {
    thinking: {
      min: 1,
      max: 65535,
      zeroAllowed: false,
      dynamicAllowed: true,
      levels: ['minimal', 'low', 'medium', 'high'],
    },
    name: 'models/gemini-3.5-flash-lite',
  },
}

export const normalizeAntigravityModelInput = (model, defaultModel = DEFAULT_ANTIGRAVITY_MODEL) => {
  if (!model) {
    return defaultModel
  }
  return model.startsWith('models/') ? model.slice('models/'.length) : model
}

export const getAntigravityModelAlias = (modelName) => {
  const normalized = normalizeAntigravityModelInput(modelName)
  if (Object.prototype.hasOwnProperty.call(UPSTREAM_TO_ALIAS, normalized)) {
    return UPSTREAM_TO_ALIAS[normalized]
  }
  return normalized
}

export const getAntigravityModelMetadata = (modelName) => {
  const normalized = normalizeAntigravityModelInput(modelName)
  if (Object.prototype.hasOwnProperty.call(ANTIGRAVITY_MODEL_METADATA, normalized)) {
    return ANTIGRAVITY_MODEL_METADATA[normalized]
  }
  const alias = UPSTREAM_TO_ALIAS[normalized]
  if (alias && Object.prototype.hasOwnProperty.call(ANTIGRAVITY_MODEL_METADATA, alias)) {
    return ANTIGRAVITY_MODEL_METADATA[alias]
  }
  if (normalized.startsWith('claude-')) {
    const prefixed = `gemini-${normalized}`
    if (Object.prototype.hasOwnProperty.call(ANTIGRAVITY_MODEL_METADATA, prefixed)) {
      return ANTIGRAVITY_MODEL_METADATA[prefixed]
    }
    const thinkingAlias = `${prefixed}-thinking`
    if (Object.prototype.hasOwnProperty.call(ANTIGRAVITY_MODEL_METADATA, thinkingAlias)) {
      return ANTIGRAVITY_MODEL_METADATA[thinkingAlias]
    }
  }
  return null
}

export const mapAntigravityUpstreamModel = (model) => {
  const normalized = normalizeAntigravityModelInput(model)
  let upstream = Object.prototype.hasOwnProperty.call(ALIAS_TO_UPSTREAM, normalized)
    ? ALIAS_TO_UPSTREAM[normalized]
    : normalized

  if (upstream.startsWith('gemini-claude-')) {
    upstream = upstream.replace(/^gemini-/, '')
  }

  const mapping = {
    // Opus：上游更常见的是 thinking 变体（CLIProxyAPI 也按此处理）
    'claude-opus-4-5': 'claude-opus-4-5-thinking',
    'claude-opus-4-6': 'claude-opus-4-6-thinking',
    // Gemini thinking 变体回退
    'gemini-2.5-flash-thinking': 'gemini-2.5-flash',
  }

  return mapping[upstream] || upstream
}
