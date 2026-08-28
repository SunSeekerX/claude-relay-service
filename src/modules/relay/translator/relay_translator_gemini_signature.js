// Gemini thoughtSignature 纪律（对齐官方 gemini-cli）
// - Gemini 3：每轮 model 内容中第一个 functionCall 必须带 thoughtSignature
// - strip thought 时把 signature 迁到首个 functionCall
// - 缺失时用官方合成哨兵 skip_thought_signature_validator

export const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

export const isValidThoughtSignature = (signature) => typeof signature === 'string' && signature.trim().length > 0

// 遍历 contents，保证每个 model turn 的首个 functionCall 带 signature
export const ensureThoughtSignaturesOnContents = (contents, { synthetic = SYNTHETIC_THOUGHT_SIGNATURE } = {}) => {
  if (!Array.isArray(contents)) {
    return contents
  }

  for (const content of contents) {
    if (!content || content.role !== 'model' || !Array.isArray(content.parts)) {
      continue
    }

    let firstFunctionCallSeen = false
    let pendingSignatureFromThought = null

    for (const part of content.parts) {
      if (!part || typeof part !== 'object') {
        continue
      }
      if (part.thought === true && isValidThoughtSignature(part.thoughtSignature)) {
        pendingSignatureFromThought = part.thoughtSignature
      }
      if (part.functionCall) {
        if (!firstFunctionCallSeen) {
          firstFunctionCallSeen = true
          if (!isValidThoughtSignature(part.thoughtSignature)) {
            part.thoughtSignature = pendingSignatureFromThought || synthetic
          }
        }
      }
    }
  }

  return contents
}

// 从 history 剥离 thought 文本 parts 时，把 signature 迁到同 turn 首个 functionCall
export const stripThoughtPartsPreserveSignatures = (contents, { synthetic = SYNTHETIC_THOUGHT_SIGNATURE } = {}) => {
  if (!Array.isArray(contents)) {
    return contents
  }

  return contents.map((content) => {
    if (!content || !Array.isArray(content.parts)) {
      return content
    }
    if (content.role !== 'model') {
      return content
    }

    let carriedSignature = null
    const nextParts = []
    for (const part of content.parts) {
      if (!part || typeof part !== 'object') {
        continue
      }
      if (part.thought === true) {
        if (isValidThoughtSignature(part.thoughtSignature)) {
          carriedSignature = part.thoughtSignature
        }
        continue
      }
      if (part.functionCall) {
        const next = { ...part }
        if (!isValidThoughtSignature(next.thoughtSignature)) {
          next.thoughtSignature = carriedSignature || synthetic
        }
        carriedSignature = null
        nextParts.push(next)
        continue
      }
      nextParts.push(part)
    }
    return { ...content, parts: nextParts }
  })
}

// functionResponse.id 与 functionCall.id 对齐（按顺序补齐缺失 id）
export const ensureFunctionResponseIds = (contents) => {
  if (!Array.isArray(contents)) {
    return contents
  }

  const pendingCallIds = []
  for (const content of contents) {
    if (!content || !Array.isArray(content.parts)) {
      continue
    }
    if (content.role === 'model') {
      for (const part of content.parts) {
        if (part?.functionCall) {
          if (!part.functionCall.id) {
            part.functionCall.id = `fc_${pendingCallIds.length + 1}`
          }
          pendingCallIds.push(part.functionCall.id)
        }
      }
    }
  }

  let callIndex = 0
  for (const content of contents) {
    if (!content || !Array.isArray(content.parts)) {
      continue
    }
    if (content.role !== 'user') {
      continue
    }
    for (const part of content.parts) {
      if (part?.functionResponse) {
        if (!part.functionResponse.id && callIndex < pendingCallIds.length) {
          part.functionResponse.id = pendingCallIds[callIndex]
        }
        callIndex += 1
      }
    }
  }

  return contents
}
