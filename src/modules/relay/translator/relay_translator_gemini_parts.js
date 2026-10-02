// OpenAI Chat / Responses 多模态 content part → Gemini parts
// 对齐 CLIProxyAPI 61fdfc34：data URL / base64 → inlineData，http(s)/gs URL → fileData
// 支持 text/input_text、image_url/input_image、input_audio/audio、input_video/video、file/input_file

const AUDIO_FORMAT_MIME = {
  mp3: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
  pcm16: 'audio/pcm',
}

const VIDEO_FORMAT_MIME = {
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
}

const EXTENSION_MIME = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  ...AUDIO_FORMAT_MIME,
  ...VIDEO_FORMAT_MIME,
}

const DATA_URL_RE = /^data:([^;,]*)(;base64)?,(.*)$/is
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const REMOTE_URL_RE = /^(https?|gs):\/\//i
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

const mimeFromFilename = (filename) => {
  const match = String(filename || '').match(/\.([a-z0-9]+)$/i)
  return match ? EXTENSION_MIME[match[1].toLowerCase()] || '' : ''
}

// 显式 mime 优先；泛型 mime（octet-stream/空）按文件名或 format 推断
const resolveMime = (explicitMime, { filename = '', format = '', formatMap = EXTENSION_MIME, fallback = '' } = {}) => {
  const normalized = String(explicitMime || '')
    .trim()
    .toLowerCase()
  if (!GENERIC_MIME.has(normalized)) {
    return normalized
  }
  const formatKey = String(format || '')
    .trim()
    .toLowerCase()
  return formatMap[formatKey] || mimeFromFilename(filename) || fallback
}

// data URL / 裸 base64 / 远程 URL → Gemini part；非法数据返回 null
export const mediaSourceToGeminiPart = (source, options = {}) => {
  const value = typeof source === 'string' ? source.trim() : ''
  if (!value) {
    return null
  }
  const dataMatch = value.match(DATA_URL_RE)
  if (dataMatch) {
    const data = dataMatch[3].replace(/\s+/g, '')
    if (!dataMatch[2] || !BASE64_RE.test(data)) {
      return null
    }
    const mimeType = resolveMime(dataMatch[1], options)
    return mimeType ? { inlineData: { mimeType, data } } : null
  }
  if (REMOTE_URL_RE.test(value)) {
    const mimeType = resolveMime(options.mimeType, { ...options, filename: options.filename || value })
    return mimeType ? { fileData: { mimeType, fileUri: value } } : { fileData: { fileUri: value } }
  }
  const data = value.replace(/\s+/g, '')
  if (!BASE64_RE.test(data)) {
    return null
  }
  const mimeType = resolveMime(options.mimeType, options)
  return mimeType ? { inlineData: { mimeType, data } } : null
}
const urlOf = (value) => (typeof value === 'string' ? value : value?.url)

// 单个 OpenAI content part → Gemini part（无法识别或数据非法返回 null）
export const openAIContentPartToGeminiPart = (item) => {
  if (typeof item === 'string') {
    return { text: item }
  }
  if (!item || typeof item !== 'object') {
    return null
  }
  const type = String(item.type || '')
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    return typeof item.text === 'string' ? { text: item.text } : null
  }
  if (type === 'image_url' || type === 'input_image') {
    const source = urlOf(item.image_url) || item.source?.data || item.data
    return mediaSourceToGeminiPart(source, {
      mimeType: item.source?.media_type || item.mime_type,
      filename: item.filename,
      fallback: 'image/jpeg',
    })
  }
  if (type === 'input_audio' || type === 'audio') {
    const audio = item.input_audio || item.audio || item
    return mediaSourceToGeminiPart(audio.data || audio.url, {
      mimeType: audio.mime_type,
      format: audio.format,
      formatMap: AUDIO_FORMAT_MIME,
    })
  }
  if (type === 'input_video' || type === 'video' || type === 'video_url') {
    const video = item.video || item
    return mediaSourceToGeminiPart(urlOf(item.video_url) || video.data || video.url, {
      mimeType: video.mime_type,
      format: video.format,
      formatMap: VIDEO_FORMAT_MIME,
    })
  }
  if (type === 'file' || type === 'input_file') {
    const file = item.file || item
    return mediaSourceToGeminiPart(file.file_data || file.file_url || file.url, {
      mimeType: file.mime_type,
      filename: file.filename,
      format: file.format,
    })
  }
  return null
}

// content（字符串或 part 数组）→ Gemini parts
export const openAIContentToGeminiParts = (content) => {
  if (typeof content === 'string') {
    return [{ text: content }]
  }
  if (!Array.isArray(content)) {
    return content ? [{ text: String(content) }] : []
  }
  return content.map(openAIContentPartToGeminiPart).filter(Boolean)
}
