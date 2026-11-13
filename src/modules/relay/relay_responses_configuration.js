// Targets without durable configuration items receive the final effective effort.
export const resolveResponsesConfiguration = (source) => {
  if (!Array.isArray(source.input)) {
    return source
  }
  let effort
  const input = source.input.filter((item) => {
    if (item?.type !== 'configuration_update') {
      return true
    }
    const level = item.reasoning?.effort
    if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) {
      throw Object.assign(new Error('Unsupported configuration_update reasoning effort'), {
        statusCode: 400,
        code: 'unsupported_parameter',
      })
    }
    effort = level
    return false
  })
  return effort === undefined
    ? source
    : {
        ...source,
        input,
        reasoning: { ...source.reasoning, effort },
      }
}
