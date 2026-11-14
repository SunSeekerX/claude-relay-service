import { env } from './env.js'

const positiveInteger = (name, defaultValue) => {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return defaultValue
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export const requestResourcesConfig = {
  maxRequests: 0,
  maxBodyBytes: positiveInteger('REQUEST_MAX_SIZE_MB', 100) * 1024 * 1024,
  maxInflightBodyBytes: 0,
  syncIntervalMs: 60000,
}
