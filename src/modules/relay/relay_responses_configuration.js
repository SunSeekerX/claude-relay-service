// Targets without durable configuration items receive the final effective settings.
export const resolveResponsesConfiguration = (source) => {
  if (!Array.isArray(source.input)) {
    return source
  }
  let reasoning
  let text
  let updated = false
  const input = source.input.filter((item) => {
    if (item?.type !== 'configuration_update') {
      return true
    }
    if (item.reasoning !== undefined) {
      const effort = item.reasoning?.effort
      if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
        throw Object.assign(new Error('Unsupported configuration_update reasoning effort'), {
          statusCode: 400,
          code: 'unsupported_parameter',
        })
      }
      reasoning = { ...(reasoning ?? source.reasoning), effort }
    }
    if (item.text !== undefined) {
      const format = item.text?.format
      if (!['text', 'json_schema', 'json_object'].includes(format?.type)) {
        throw Object.assign(new Error('Unsupported configuration_update text format'), {
          statusCode: 400,
          code: 'unsupported_parameter',
        })
      }
      text = { ...(text ?? source.text), format }
    }
    if (item.reasoning === undefined && item.text === undefined) {
      throw Object.assign(new Error('configuration_update requires reasoning or text'), {
        statusCode: 400,
        code: 'unsupported_parameter',
      })
    }
    updated = true
    return false
  })
  return updated
    ? {
        ...source,
        input,
        ...(reasoning ? { reasoning } : {}),
        ...(text ? { text } : {}),
      }
    : source
}
