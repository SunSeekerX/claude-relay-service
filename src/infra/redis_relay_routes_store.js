import { RedisKeys, LIMITS } from './redis_key.js'
import { RedisLua } from './redis_lua.js'

export const attach = (redisClient) => {
  redisClient.getRelayRoute = async (code) => {
    const raw = await redisClient.getClientSafe().hget(RedisKeys.relayRoutes, code)
    return raw === null ? null : JSON.parse(raw)
  }
  redisClient.getRelayRoutes = async () => {
    const values = await redisClient.getClientSafe().hvals(RedisKeys.relayRoutes)
    return values.map((value) => JSON.parse(value))
  }
  redisClient.saveRelayRoute = async (route, mode) =>
    redisClient
      .getClientSafe()
      .eval(
        RedisLua.relayRoutes.write,
        1,
        RedisKeys.relayRoutes,
        route.code,
        JSON.stringify(route),
        mode,
        LIMITS.relayRoutes,
      )
  redisClient.deleteRelayRoute = async (code) => redisClient.getClientSafe().hdel(RedisKeys.relayRoutes, code)
}
