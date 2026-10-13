const DURATION_FIELDS = [
  'authenticationMs',
  'schedulingMs',
  'localPreparationMs',
  'upstreamHeadersMs',
  'upstreamResponseMs',
  'firstContentWaitMs'
]

const stateFor = (req) => {
  if (!req) {
    return null
  }
  req._crsTimings ??= { started: {}, durations: {}, upstreamAttempts: null }
  return req._crsTimings
}

export const startRequestTiming = (req, stage) => {
  const state = stateFor(req)
  if (state) {
    state.started[stage] = Date.now()
  }
}

export const finishRequestTiming = (req, stage) => {
  const state = req?._crsTimings
  const start = state?.started[stage]
  if (start === undefined) {
    return
  }
  const now = Date.now()
  state.durations[`${stage}Ms`] = (state.durations[`${stage}Ms`] ?? 0) + Math.max(0, now - start)
  state[`${stage}FinishedAt`] = now
  delete state.started[stage]
}

export const trackRequestTiming = async (req, stage, operation) => {
  startRequestTiming(req, stage)
  try {
    return await operation()
  } finally {
    finishRequestTiming(req, stage)
  }
}

export const startUpstreamTiming = (req) => {
  const state = stateFor(req)
  if (!state) {
    return
  }
  state.upstreamStartedAt = Date.now()
  state.upstreamHeadersAt = null
  state.upstreamHeadersMs = null
  state.upstreamResponseMs = null
  state.upstreamAttempts = (state.upstreamAttempts ?? 0) + 1
}

export const finishUpstreamTiming = (req, { headersOnly = true } = {}) => {
  const state = req?._crsTimings
  if (state?.upstreamStartedAt === undefined) {
    return
  }
  const now = Date.now()
  const duration = Math.max(0, now - state.upstreamStartedAt)
  if (headersOnly) {
    state.upstreamHeadersAt = now
    state.upstreamHeadersMs = duration
  } else {
    state.upstreamResponseMs = duration
  }
}

export const timedUpstreamRequest = async (req, operation) => {
  startUpstreamTiming(req)
  const response = await operation()
  finishUpstreamTiming(req, { headersOnly: typeof response?.data?.pipe === 'function' })
  return response
}

export const normalizeRequestTimings = (value) => {
  if (!value || typeof value !== 'object') {
    return null
  }
  const timings = Object.fromEntries(
    DURATION_FIELDS.map((field) => [
      field,
      typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= 0
        ? value[field]
        : null
    ])
  )
  timings.upstreamAttempts =
    Number.isSafeInteger(value.upstreamAttempts) && value.upstreamAttempts >= 0
      ? value.upstreamAttempts
      : null
  return timings
}

export const getRequestTimings = (req) => {
  const state = req?._crsTimings
  if (!state) {
    return null
  }
  const preparedAt = state.schedulingFinishedAt ?? state.authenticationFinishedAt
  return normalizeRequestTimings({
    ...state.durations,
    localPreparationMs:
      preparedAt !== undefined && state.upstreamStartedAt !== undefined
        ? Math.max(0, state.upstreamStartedAt - preparedAt)
        : null,
    upstreamHeadersMs: state.upstreamHeadersMs,
    upstreamResponseMs: state.upstreamResponseMs,
    firstContentWaitMs:
      state.upstreamHeadersAt !== null &&
      state.upstreamHeadersAt !== undefined &&
      req.firstTokenAt !== null &&
      req.firstTokenAt !== undefined &&
      req.firstTokenAt >= state.upstreamHeadersAt
        ? Math.max(0, req.firstTokenAt - state.upstreamHeadersAt)
        : null,
    upstreamAttempts: state.upstreamAttempts
  })
}
