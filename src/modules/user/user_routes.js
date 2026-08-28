import express from 'express'
import { ldapService } from './user_ldap_service.js'
import { userService } from './user_service.js'
import { apiKeyService } from '../apikey/apikey_service.js'
import { logger } from '../../common/logger.js'
import { config } from '../../../config/config.js'
import { inputValidator } from '../../common/input_validator.js'
import { RateLimiterRedis } from 'rate-limiter-flexible'
import { redis } from '../../infra/redis.js'
import { authenticateUser, authenticateUserOrAdmin, requireAdmin } from '../../infra/middleware_auth.js'
import { quotaCardService } from '../payment/payment_quota_card_service.js'
import { asyncRoute } from '../../common/route_handler.js'
import {
  ok,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  tooManyRequests,
  HttpError,
} from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'
export const router = express.Router()

// 配置登录速率限制
// 只基于IP地址限制，避免攻击者恶意锁定特定账户

// 延迟初始化速率限制器，确保 Redis 已连接
let ipRateLimiter = null
let strictIpRateLimiter = null

// 初始化速率限制器函数
const initRateLimiters = function initRateLimiters() {
  if (!ipRateLimiter) {
    try {
      const redisClient = redis.getClientSafe()

      // IP地址速率限制 - 正常限制
      ipRateLimiter = new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix: 'login_ip_limiter',
        points: 30, // 每个IP允许30次尝试
        duration: 900, // 15分钟窗口期
        blockDuration: 900, // 超限后封禁15分钟
      })

      // IP地址速率限制 - 严格限制（用于检测暴力破解）
      strictIpRateLimiter = new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix: 'login_ip_strict',
        points: 100, // 每个IP允许100次尝试
        duration: 3600, // 1小时窗口期
        blockDuration: 3600, // 超限后封禁1小时
      })
    } catch (error) {
      logger.error('初始化速率限制器失败:', error)
      // 速率限制器初始化失败时继续运行，但记录错误
    }
  }
  return { ipRateLimiter, strictIpRateLimiter }
}

// 用户登录端点
router.post(
  '/login',
  asyncRoute('User login error', async (req) => {
    const { username, password } = parseObjectBody(req.body, '用户登录')
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown'

    // 初始化速率限制器（如果尚未初始化）
    const limiters = initRateLimiters()

    // 检查IP速率限制 - 基础限制
    if (limiters.ipRateLimiter) {
      try {
        await limiters.ipRateLimiter.consume(clientIp)
      } catch (rateLimiterRes) {
        const retryAfter = Math.round(rateLimiterRes.msBeforeNext / 1000) || 900
        logger.security(`Login rate limit exceeded for IP: ${clientIp}`)
        throw tooManyRequests('Too many login attempts from this IP. Please try again later.', {
          headers: { 'Retry-After': String(retryAfter) },
        })
      }
    }

    // 检查IP速率限制 - 严格限制（防止暴力破解）
    if (limiters.strictIpRateLimiter) {
      try {
        await limiters.strictIpRateLimiter.consume(clientIp)
      } catch (rateLimiterRes) {
        const retryAfter = Math.round(rateLimiterRes.msBeforeNext / 1000) || 3600
        logger.security(`Strict rate limit exceeded for IP: ${clientIp} - possible brute force`)
        throw tooManyRequests('Too many login attempts detected. Access temporarily blocked.', {
          headers: { 'Retry-After': String(retryAfter) },
        })
      }
    }

    if (!username || !password) {
      throw badRequest('Username and password are required')
    }

    // 验证输入格式
    let validatedUsername
    try {
      validatedUsername = inputValidator.validateUsername(username)
      inputValidator.validatePassword(password)
    } catch (validationError) {
      throw badRequest(validationError.message)
    }

    // 检查用户管理是否启用
    if (!config.userManagement.enabled) {
      throw new HttpError(503, 'User management is not enabled', { expose: true })
    }

    // 检查LDAP是否启用
    if (!config.ldap || !config.ldap.enabled) {
      throw new HttpError(503, 'LDAP authentication is not enabled', { expose: true })
    }

    // 尝试LDAP认证
    const authResult = await ldapService.authenticateUserCredentials(validatedUsername, password)

    if (!authResult.success) {
      // 登录失败
      logger.info(`Failed login attempt for user: ${validatedUsername} from IP: ${clientIp}`)
      throw unauthorized(authResult.message)
    }

    // 登录成功
    logger.info(`User login successful: ${validatedUsername} from IP: ${clientIp}`)

    return ok(
      {
        user: {
          id: authResult.user.id,
          username: authResult.user.username,
          email: authResult.user.email,
          displayName: authResult.user.displayName,
          firstName: authResult.user.firstName,
          lastName: authResult.user.lastName,
          role: authResult.user.role,
        },
        sessionToken: authResult.sessionToken,
      },
      'Login successful',
    )
  }),
)

// 用户登出端点
router.post(
  '/logout',
  authenticateUser,
  asyncRoute('User logout error', async (req) => {
    await userService.invalidateUserSession(req.user.sessionToken)
    logger.info(`User logout: ${req.user.username}`)
    return ok(undefined, 'Logout successful')
  }),
)

// 获取当前用户信息
router.get(
  '/profile',
  authenticateUser,
  asyncRoute('Failed to retrieve user profile', async (req) => {
    const user = await userService.getUserById(req.user.id)
    if (!user) {
      throw notFound('User profile not found')
    }

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        apiKeyCount: user.apiKeyCount,
        totalUsage: user.totalUsage,
      },
      config: {
        maxApiKeysPerUser: config.userManagement.maxApiKeysPerUser,
        allowUserDeleteApiKeys: config.userManagement.allowUserDeleteApiKeys,
      },
    }
  }),
)

// 获取用户的API Keys
router.get(
  '/api-keys',
  authenticateUser,
  asyncRoute('Failed to retrieve API keys', async (req) => {
    const { includeDeleted = 'false' } = req.query
    const apiKeys = await apiKeyService.getUserApiKeys(req.user.id, includeDeleted === 'true')

    // 移除敏感信息并格式化usage数据
    const safeApiKeys = apiKeys.map((key) => {
      // Flatten usage structure for frontend compatibility
      let flatUsage = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
      }

      if (key.usage && key.usage.total) {
        flatUsage = {
          requests: key.usage.total.requests || 0,
          inputTokens: key.usage.total.inputTokens || 0,
          outputTokens: key.usage.total.outputTokens || 0,
          totalCost: key.totalCost || 0,
        }
      }

      return {
        id: key.id,
        name: key.name,
        description: key.description,
        tokenLimit: key.tokenLimit,
        isActive: key.isActive,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        usage: flatUsage,
        dailyCost: key.dailyCost,
        dailyCostLimit: key.dailyCostLimit,
        totalCost: key.totalCost,
        totalCostLimit: key.totalCostLimit,
        // 不返回实际的key值，只返回前缀和后几位
        keyPreview: key.key ? `${key.key.substring(0, 8)}...${key.key.substring(key.key.length - 4)}` : null,
        // Include deletion fields for deleted keys
        isDeleted: key.isDeleted,
        deletedAt: key.deletedAt,
        deletedBy: key.deletedBy,
        deletedByType: key.deletedByType,
      }
    })

    return {
      apiKeys: safeApiKeys,
      total: safeApiKeys.length,
    }
  }),
)

// 创建新的API Key
router.post(
  '/api-keys',
  authenticateUser,
  asyncRoute('Failed to create API key', async (req) => {
    const { name, description, tokenLimit, expiresAt, dailyCostLimit, totalCostLimit } = parseObjectBody(
      req.body,
      '创建用户 API Key',
    )

    if (!name || !name.trim()) {
      throw badRequest('API key name is required')
    }

    if (
      totalCostLimit !== undefined &&
      totalCostLimit !== null &&
      totalCostLimit !== '' &&
      (Number.isNaN(Number(totalCostLimit)) || Number(totalCostLimit) < 0)
    ) {
      throw badRequest('Total cost limit must be a non-negative number')
    }

    // 检查用户API Key数量限制
    const userApiKeys = await apiKeyService.getUserApiKeys(req.user.id)
    if (userApiKeys.length >= config.userManagement.maxApiKeysPerUser) {
      throw badRequest(`You can only have up to ${config.userManagement.maxApiKeysPerUser} API keys`)
    }

    // 创建API Key数据
    const apiKeyData = {
      name: name.trim(),
      description: description?.trim() || '',
      userId: req.user.id,
      userUsername: req.user.username,
      tokenLimit: tokenLimit || null,
      expiresAt: expiresAt || null,
      dailyCostLimit: dailyCostLimit || null,
      totalCostLimit: totalCostLimit || null,
      createdBy: 'user',
      // 设置服务权限为全部服务，确保前端显示“服务权限”为“全部服务”且具备完整访问权限
      permissions: 'all',
    }

    const newApiKey = await apiKeyService.createApiKey(apiKeyData)

    // 更新用户API Key数量
    await userService.updateUserApiKeyCount(req.user.id, userApiKeys.length + 1)

    logger.info(`User ${req.user.username} created API key: ${name}`)

    return ok(
      {
        apiKey: {
          id: newApiKey.id,
          name: newApiKey.name,
          description: newApiKey.description,
          key: newApiKey.apiKey, // 只在创建时返回完整key
          tokenLimit: newApiKey.tokenLimit,
          expiresAt: newApiKey.expiresAt,
          dailyCostLimit: newApiKey.dailyCostLimit,
          totalCostLimit: newApiKey.totalCostLimit,
          createdAt: newApiKey.createdAt,
        },
      },
      'API key created successfully',
      201,
    )
  }),
)

// 删除API Key
router.delete(
  '/api-keys/:keyId',
  authenticateUser,
  asyncRoute('Failed to delete API key', async (req) => {
    const { keyId } = req.params

    // 检查是否允许用户删除自己的API Keys
    if (!config.userManagement.allowUserDeleteApiKeys) {
      throw forbidden('Users are not allowed to delete their own API keys. Please contact an administrator.')
    }

    // 检查API Key是否属于当前用户
    const existingKey = await apiKeyService.getApiKeyById(keyId)
    if (!existingKey || existingKey.userId !== req.user.id) {
      throw notFound('API key not found or you do not have permission to access it')
    }

    await apiKeyService.deleteApiKey(keyId, req.user.username, 'user')

    // 更新用户API Key数量
    const userApiKeys = await apiKeyService.getUserApiKeys(req.user.id)
    await userService.updateUserApiKeyCount(req.user.id, userApiKeys.length)

    logger.info(`User ${req.user.username} deleted API key: ${existingKey.name}`)

    return ok(undefined, 'API key deleted successfully')
  }),
)

// 获取用户使用统计
router.get(
  '/usage-stats',
  authenticateUser,
  asyncRoute('Failed to retrieve usage statistics', async (req) => {
    const { period = 'week', model } = req.query

    // 获取用户的API Keys (including deleted ones for complete usage stats)
    const userApiKeys = await apiKeyService.getUserApiKeys(req.user.id, true)
    const apiKeyIds = userApiKeys.map((key) => key.id)

    if (apiKeyIds.length === 0) {
      return {
        stats: {
          totalRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCost: 0,
          dailyStats: [],
          modelStats: [],
        },
      }
    }

    // 获取使用统计
    const stats = await apiKeyService.getAggregatedUsageStats(apiKeyIds, { period, model })

    return { stats }
  }),
)

// === 管理员用户管理端点 ===

// 获取用户列表（管理员）
router.get(
  '/',
  authenticateUserOrAdmin,
  requireAdmin,
  asyncRoute('Failed to retrieve users list', async (req) => {
    const { page = 1, limit = 20, role, isActive, search } = req.query

    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      role,
      isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
    }

    const result = await userService.getAllUsers(options)

    // 如果有搜索条件，进行过滤
    let filteredUsers = result.users
    if (search) {
      const searchLower = search.toLowerCase()
      filteredUsers = result.users.filter(
        (user) =>
          user.username.toLowerCase().includes(searchLower) ||
          user.displayName.toLowerCase().includes(searchLower) ||
          user.email.toLowerCase().includes(searchLower),
      )
    }

    return {
      users: filteredUsers,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    }
  }),
)

// 获取特定用户信息（管理员）
router.get(
  '/:userId',
  authenticateUserOrAdmin,
  requireAdmin,
  asyncRoute('Failed to retrieve user details', async (req) => {
    const { userId } = req.params

    const user = await userService.getUserById(userId)
    if (!user) {
      throw notFound('User not found')
    }

    // 获取用户的API Keys（包括已删除的以保留统计数据）
    const apiKeys = await apiKeyService.getUserApiKeys(userId, true)

    return {
      user: {
        ...user,
        apiKeys: apiKeys.map((key) => {
          // Flatten usage structure for frontend compatibility
          let flatUsage = {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
          }

          if (key.usage && key.usage.total) {
            flatUsage = {
              requests: key.usage.total.requests || 0,
              inputTokens: key.usage.total.inputTokens || 0,
              outputTokens: key.usage.total.outputTokens || 0,
              totalCost: key.totalCost || 0,
            }
          }

          return {
            id: key.id,
            name: key.name,
            description: key.description,
            isActive: key.isActive,
            createdAt: key.createdAt,
            lastUsedAt: key.lastUsedAt,
            usage: flatUsage,
            keyPreview: key.key ? `${key.key.substring(0, 8)}...${key.key.substring(key.key.length - 4)}` : null,
          }
        }),
      },
    }
  }),
)

// 更新用户状态（管理员）
router.patch(
  '/:userId/status',
  authenticateUserOrAdmin,
  requireAdmin,
  asyncRoute('Failed to update user status', async (req) => {
    const { userId } = req.params
    const { isActive } = parseObjectBody(req.body, '更新用户状态')

    if (typeof isActive !== 'boolean') {
      throw badRequest('isActive must be a boolean value')
    }

    const updatedUser = await userService.updateUserStatus(userId, isActive)

    const adminUser = req.admin?.username || req.user?.username
    logger.info(`Admin ${adminUser} ${isActive ? 'enabled' : 'disabled'} user: ${updatedUser.username}`)

    return ok(
      {
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          isActive: updatedUser.isActive,
          updatedAt: updatedUser.updatedAt,
        },
      },
      `User ${isActive ? 'enabled' : 'disabled'} successfully`,
    )
  }),
)

// 更新用户角色（管理员）
router.patch(
  '/:userId/role',
  authenticateUserOrAdmin,
  requireAdmin,
  asyncRoute('Failed to update user role', async (req) => {
    const { userId } = req.params
    const { role } = parseObjectBody(req.body, '更新用户角色')

    const validRoles = ['user', 'admin']
    if (!role || !validRoles.includes(role)) {
      throw badRequest(`Role must be one of: ${validRoles.join(', ')}`)
    }

    const updatedUser = await userService.updateUserRole(userId, role)

    const adminUser = req.admin?.username || req.user?.username
    logger.info(`Admin ${adminUser} changed user ${updatedUser.username} role to: ${role}`)

    return ok(
      {
        user: {
          id: updatedUser.id,
          username: updatedUser.username,
          role: updatedUser.role,
          updatedAt: updatedUser.updatedAt,
        },
      },
      `User role updated to ${role} successfully`,
    )
  }),
)

// 禁用用户的所有API Keys（管理员）
router.post(
  '/:userId/disable-keys',
  authenticateUserOrAdmin,
  requireAdmin,
  asyncRoute('Failed to disable user API keys', async (req) => {
    const { userId } = req.params

    const user = await userService.getUserById(userId)
    if (!user) {
      throw notFound('User not found')
    }

    const result = await apiKeyService.disableUserApiKeys(userId)

    const adminUser = req.admin?.username || req.user?.username
    logger.info(`Admin ${adminUser} disabled all API keys for user: ${user.username}`)

    return ok({ disabledCount: result.count }, `Disabled ${result.count} API keys for user ${user.username}`)
  }),
)

// 获取用户使用统计（管理员）
router.get(
  '/:userId/usage-stats',
  authenticateUserOrAdmin,
  requireAdmin,
  asyncRoute('Failed to retrieve user usage statistics', async (req) => {
    const { userId } = req.params
    const { period = 'week', model } = req.query

    const user = await userService.getUserById(userId)
    if (!user) {
      throw notFound('User not found')
    }

    // 获取用户的API Keys（包括已删除的以保留统计数据）
    const userApiKeys = await apiKeyService.getUserApiKeys(userId, true)
    const apiKeyIds = userApiKeys.map((key) => key.id)

    if (apiKeyIds.length === 0) {
      return {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
        },
        stats: {
          totalRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCost: 0,
          dailyStats: [],
          modelStats: [],
        },
      }
    }

    // 获取使用统计
    const stats = await apiKeyService.getAggregatedUsageStats(apiKeyIds, { period, model })

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
      },
      stats,
    }
  }),
)

// 获取用户管理统计（管理员）
router.get(
  '/stats/overview',
  authenticateUserOrAdmin,
  requireAdmin,
  asyncRoute('Failed to retrieve user statistics', async () => {
    const stats = await userService.getUserStats()
    return { stats }
  }),
)

// 测试LDAP连接（管理员）
router.get(
  '/admin/ldap-test',
  authenticateUserOrAdmin,
  requireAdmin,
  asyncRoute('Failed to test LDAP connection', async () => {
    const testResult = await ldapService.testConnection()
    return {
      ldapTest: testResult,
      config: ldapService.getConfigInfo(),
    }
  }),
)

// ═══════════════════════════════════════════════════════════════════════════
// 额度卡核销相关路由
// ═══════════════════════════════════════════════════════════════════════════

// 核销额度卡
router.post(
  '/redeem-card',
  authenticateUser,
  asyncRoute('Redeem failed', async (req) => {
    const { code, apiKeyId } = parseObjectBody(req.body, '额度卡核销')

    if (!code) {
      throw badRequest('Card code is required')
    }

    if (!apiKeyId) {
      throw badRequest('API key ID is required')
    }

    // 验证 API Key 属于当前用户
    const keyData = await redis.getApiKey(apiKeyId)
    if (!keyData || Object.keys(keyData).length === 0) {
      throw notFound('The specified API key does not exist')
    }

    if (keyData.userId !== req.user.id) {
      throw forbidden('You can only redeem cards to your own API keys')
    }

    try {
      // 执行核销
      const result = await quotaCardService.redeemCard(code, apiKeyId, req.user.id, req.user.username)

      logger.success(`User ${req.user.username} redeemed card ${code} to key ${apiKeyId}`)

      return result
    } catch (error) {
      console.error(error)
      throw badRequest(error.message)
    }
  }),
)

// 获取用户的核销历史
router.get(
  '/redemption-history',
  authenticateUser,
  asyncRoute('Failed to get redemption history', async (req) => {
    const { limit = 50, offset = 0 } = req.query

    return quotaCardService.getRedemptions({
      userId: req.user.id,
      limit: parseInt(limit),
      offset: parseInt(offset),
    })
  }),
)

// 获取用户的额度信息
router.get(
  '/quota-info',
  authenticateUser,
  asyncRoute('Failed to get quota info', async (req) => {
    const { apiKeyId } = req.query

    if (!apiKeyId) {
      throw badRequest('API key ID is required')
    }

    // 验证 API Key 属于当前用户
    const keyData = await redis.getApiKey(apiKeyId)
    if (!keyData || Object.keys(keyData).length === 0) {
      throw notFound('The specified API key does not exist')
    }

    if (keyData.userId !== req.user.id) {
      throw forbidden('You can only view your own API key quota')
    }

    // 检查是否为聚合 Key
    if (keyData.isAggregated !== 'true') {
      return {
        isAggregated: false,
        message: 'This is a traditional API key, not using quota system',
      }
    }

    // 解析聚合 Key 数据
    let permissions
    let serviceQuotaLimits = {}
    let serviceQuotaUsed = {}

    try {
      permissions = JSON.parse(keyData.permissions || '[]')
    } catch (e) {
      permissions = [keyData.permissions]
    }

    try {
      serviceQuotaLimits = JSON.parse(keyData.serviceQuotaLimits || '{}')
      serviceQuotaUsed = JSON.parse(keyData.serviceQuotaUsed || '{}')
    } catch (e) {
      // 解析失败使用默认值
    }

    return {
      isAggregated: true,
      quotaLimit: parseFloat(keyData.quotaLimit || 0),
      quotaUsed: parseFloat(keyData.quotaUsed || 0),
      quotaRemaining: parseFloat(keyData.quotaLimit || 0) - parseFloat(keyData.quotaUsed || 0),
      permissions,
      serviceQuotaLimits,
      serviceQuotaUsed,
      expiresAt: keyData.expiresAt,
    }
  }),
)
