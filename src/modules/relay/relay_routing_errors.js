import { getRequestRouteFormat } from './relay_routing_contract.js'

export const routeErrorBody = (req, status, message) => {
  const type = status === 403 ? 'permission_error' : status < 500 ? 'invalid_request_error' : 'api_error'
  const format = getRequestRouteFormat(req)
  if (format === 'claude-messages') {
    return { type: 'error', error: { type, message } }
  }
  if (format === 'gemini-generate') {
    const names = {
      400: 'INVALID_ARGUMENT',
      401: 'UNAUTHENTICATED',
      403: 'PERMISSION_DENIED',
      404: 'NOT_FOUND',
      429: 'RESOURCE_EXHAUSTED',
      501: 'UNIMPLEMENTED',
      503: 'UNAVAILABLE',
    }
    return { error: { code: status, status: names[status] ?? 'INTERNAL', message } }
  }
  return { error: { type, message, code: 'relay_route_error' } }
}
