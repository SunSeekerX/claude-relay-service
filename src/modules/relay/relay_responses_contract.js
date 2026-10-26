export const getResponsesBridgeProvider = (pathname) => {
  if (/^\/openai\/claude\/(?:v1\/)?responses(?:\/compact)?\/?$/.test(pathname)) {
    return 'claude'
  }
  if (/^\/gemini\/(?:v1\/)?responses(?:\/compact)?\/?$/.test(pathname)) {
    return 'gemini'
  }
  return null
}
