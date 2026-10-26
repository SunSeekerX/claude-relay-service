const createStats = () => ({
  requests: 0,
  http: {
    completed: 0,
    disconnected: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
  },
  relay: { total: 0, completed: 0, failed: 0, incomplete: 0, unmetered: 0 },
})

let stats = createStats()

export const httpRequestStats = {
  observe(req, res) {
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0]
    if (path === '/health' || path === '/api/health') {
      return
    }
    let httpRecorded = false
    let relayOutcome = null
    let relayUnmetered = false
    let relayFinal = false
    req._crsRecordRelayResult = (result) => {
      if (relayFinal && result.final !== true) {
        return
      }
      const outcome =
        result.errorCode === 'response_incomplete'
          ? 'incomplete'
          : result.statusCode >= 400 || (result.errorCode && result.errorCode !== 'usage_missing')
            ? 'failed'
            : 'completed'
      if (relayOutcome !== outcome) {
        if (relayOutcome) {
          stats.relay[relayOutcome]--
        } else {
          stats.relay.total++
        }
        stats.relay[outcome]++
        relayOutcome = outcome
      }
      if (typeof result.hasUsage === 'boolean' && relayUnmetered !== !result.hasUsage) {
        stats.relay.unmetered += result.hasUsage ? -1 : 1
        relayUnmetered = !result.hasUsage
      }
      relayFinal ||= result.final === true
    }
    const recordHttp = (disconnected) => {
      if (httpRecorded) {
        return
      }
      httpRecorded = true
      stats.requests++
      stats.http[disconnected ? 'disconnected' : 'completed']++
      if (!disconnected || res.headersSent) {
        const bucket = `status${Math.floor(res.statusCode / 100)}xx`
        if (Object.hasOwn(stats.http, bucket)) {
          stats.http[bucket]++
        }
      }
      // 非流式上游拒绝也计入转发结果；断连 drain 的终态由用量链稍后报告。
      if (!disconnected && !relayOutcome && req._crsUpstreamHeaders && !req._crsUsageDetailHandled) {
        req._crsRecordRelayResult({ statusCode: res.statusCode })
      }
    }
    res.once('finish', () => recordHttp(false))
    res.once('close', () => recordHttp(true))
  },
  getStats() {
    return { requests: stats.requests, http: { ...stats.http }, relay: { ...stats.relay } }
  },
  reset() {
    stats = createStats()
  },
}
