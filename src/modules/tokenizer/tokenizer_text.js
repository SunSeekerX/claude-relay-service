export const extractCountTexts = (body) => {
  const texts = []
  const missing = new Set()
  let items = 0
  const visit = (value, depth = 0) => {
    if (++items > 20000 || depth > 32) {
      missing.add('structured-content-limit')
      return
    }
    if (typeof value === 'string') {
      texts.push(value)
      return
    }
    if (!value || typeof value !== 'object') {
      return
    }
    if (Array.isArray(value)) {
      for (const part of value) {
        visit(part, depth + 1)
      }
      return
    }
    if (['image', 'document', 'input_image', 'input_audio', 'audio', 'video'].includes(value.type)) {
      missing.add(value.type)
      return
    }
    for (const [key, part] of Object.entries(value)) {
      if (['type', 'role', 'source', 'data', 'signature', 'cache_control'].includes(key)) {
        continue
      }
      visit(part, depth + 1)
    }
  }
  visit(body.system)
  visit(body.messages)
  if (body.tools !== undefined) {
    texts.push(JSON.stringify(body.tools))
  }
  if (body.tool_choice !== undefined) {
    texts.push(JSON.stringify(body.tool_choice))
  }
  return { texts, missing: [...missing] }
}

export const estimateVisibleTokens = (texts) =>
  Math.max(1, Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 3))
