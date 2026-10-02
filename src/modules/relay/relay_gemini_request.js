// 保留 GenerateContent 的原生字段及省略语义，不混入兼容入口的 Chat 字段
const generateContentFields = [
  'contents',
  'generationConfig',
  'safetySettings',
  'systemInstruction',
  'tools',
  'toolConfig',
  'cachedContent',
  'labels',
  'serviceTier',
  'store',
]

export const buildGeminiGenerateBody = (body) => {
  const result = {}
  for (const field of generateContentFields) {
    if (body[field] !== undefined) {
      result[field] = body[field]
    }
  }
  if (typeof result.systemInstruction === 'string') {
    result.systemInstruction = { parts: [{ text: result.systemInstruction }] }
  }
  return result
}
