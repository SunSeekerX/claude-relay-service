import crypto from 'node:crypto'

export const markAccountModelIdentityUpdate = (updates) => {
  const hasCredential = (value) => typeof value === 'string' && value.trim() && !value.startsWith('***')
  if (
    ['accessToken', 'refreshToken'].some((field) => hasCredential(updates[field])) ||
    ['claudeAiOauth', 'openaiOauth', 'geminiOauth'].some((field) => {
      const oauth = updates[field]
      return (
        oauth &&
        (typeof oauth === 'string'
          ? hasCredential(oauth)
          : ['accessToken', 'refreshToken', 'access_token', 'refresh_token'].some((key) => hasCredential(oauth[key])))
      )
    })
  ) {
    updates.modelIdentityVersion = crypto.randomUUID()
  }
  return updates
}
