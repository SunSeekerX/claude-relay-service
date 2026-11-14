export const responsesTextToClaudeOutputConfig = (text) => {
  const format = text?.format
  if (format?.type === 'json_schema') {
    return { format: { type: 'json_schema', schema: format.schema } }
  }
  if (format?.type === 'json_object') {
    return { format: { type: 'json_schema', schema: { type: 'object', additionalProperties: true } } }
  }
  return null
}
