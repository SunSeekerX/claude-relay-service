const postMethods = new Set([
  'loadCodeAssist',
  'onboardUser',
  'retrieveUserQuota',
  'listExperiments',
  'fetchAdminControls',
  'recordCodeAssistMetrics',
  'recordConversationOffered',
  'recordConversationInteraction',
  'setCodeAssistGlobalUserSetting'
])

export const getCodeAssistOperation = (method, path) => {
  const name = path.match(/^\/v1internal:([A-Za-z]+)$/)?.[1]
  if (method === 'POST' && postMethods.has(name)) {
    return { name, method }
  }
  if (method === 'GET' && name === 'getCodeAssistGlobalUserSetting') {
    return { name, method }
  }
  const operationId = path.match(/^\/v1internal\/operations\/([A-Za-z0-9_-]+)$/)?.[1]
  return method === 'GET' && operationId ? { name: 'getOperation', method, operationId } : null
}
