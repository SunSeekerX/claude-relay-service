import { AsyncLocalStorage } from 'node:async_hooks'
import crypto from 'node:crypto'

const routeContext = new AsyncLocalStorage()

export const getRelayRouteContext = () => routeContext.getStore()

export const runWithRelayRoute = (apiKey, callback) =>
  routeContext.run(apiKey._relayRoute ? { keyId: apiKey.id, route: apiKey._relayRoute } : null, callback)

export const scopeRouteSession = (sessionId) => {
  const context = routeContext.getStore()
  if (!context || !sessionId) {
    return sessionId
  }
  const { route, keyId } = context
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([keyId, route.code, route.provider, route.binding, sessionId]))
    .digest('hex')
    .slice(0, 32)
}
