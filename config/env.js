// 进程环境唯一入口：业务与 config 只许从本模块读环境，禁止直访 process.env
import dotenv from 'dotenv'

dotenv.config()

const raw = process.env

export const getEnv = (key, fallback = undefined) => {
  const value = raw[key]
  if (value === undefined || value === '') {
    return fallback
  }
  return value
}

export const hasEnv = (key) => {
  const value = raw[key]
  return value !== undefined && value !== ''
}

// env.NODE_ENV / env[dynamicKey] 均走此处，动态键名 dump 场景也收口
export const env = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'get') {
        return getEnv
      }
      if (prop === 'has') {
        return hasEnv
      }
      if (typeof prop === 'symbol') {
        return undefined
      }
      return raw[prop]
    },
    has(_target, prop) {
      return typeof prop === 'string' && Object.prototype.hasOwnProperty.call(raw, prop)
    }
  }
)

