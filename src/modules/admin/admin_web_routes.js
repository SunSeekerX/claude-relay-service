import { fileURLToPath } from 'node:url'
import express from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { redis } from '../../infra/redis.js'
import { logger } from '../../common/logger.js'
import { config } from '../../../config/config.js'
import { RedisKeys } from '../../infra/redis_key.js'
import { asyncRoute } from '../../common/route_handler.js'
import { ok, badRequest, unauthorized } from '../../common/http_result.js'
import { parseObjectBody } from '../../common/parse_body.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const router = express.Router()

// 服务静态文件
router.use('/assets', express.static(path.join(__dirname, '../../web/assets')))

// 页面路由重定向到新版 admin-spa
router.get('/', (req, res) => {
  res.redirect(301, '/admin-next/api-stats')
})

// 管理员登录
router.post(
  '/auth/login',
  asyncRoute('Login error', async (req) => {
    const { username, password } = parseObjectBody(req.body, '管理员登录')

    if (!username || !password) {
      throw badRequest('Username and password are required')
    }

    // 从Redis获取管理员信息
    let adminData = await redis.getSession('admin_credentials')

    // 如果Redis中没有管理员凭据，尝试从init.json重新加载
    if (!adminData || Object.keys(adminData).length === 0) {
      const initFilePath = path.join(__dirname, '../../data/init.json')

      if (fs.existsSync(initFilePath)) {
        try {
          const initData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'))
          const saltRounds = 10
          const passwordHash = await bcrypt.hash(initData.adminPassword, saltRounds)

          adminData = {
            username: initData.adminUsername,
            passwordHash,
            createdAt: initData.initializedAt || new Date().toISOString(),
            lastLogin: null,
            updatedAt: initData.updatedAt || null,
          }

          // 重新存储到Redis，不设置过期时间
          await redis.getClient().hset(RedisKeys.session.adminCredentials, adminData)

          logger.info('Admin credentials reloaded from init.json')
        } catch (error) {
          logger.error('Failed to reload admin credentials:', error)
          throw unauthorized('Invalid username or password')
        }
      } else {
        throw unauthorized('Invalid username or password')
      }
    }

    // 验证用户名和密码
    const isValidUsername = adminData.username === username
    const isValidPassword = await bcrypt.compare(password, adminData.passwordHash)

    if (!isValidUsername || !isValidPassword) {
      logger.security(`Failed login attempt for username: ${username}`)
      throw unauthorized('Invalid username or password')
    }

    // 生成会话token
    const sessionId = crypto.randomBytes(32).toString('hex')

    // 存储会话
    const sessionData = {
      username: adminData.username,
      loginTime: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    }

    await redis.setSession(sessionId, sessionData, config.security.adminSessionTimeout)

    // 不写 Redis 最后登录时间（Redis 仅为缓存）
    // init.json 是唯一真实数据源

    logger.success(`Admin login successful: ${username}`)

    return {
      token: sessionId,
      expiresIn: config.security.adminSessionTimeout,
      username: adminData.username,
    }
  }),
)

// 管理员登出
router.post(
  '/auth/logout',
  asyncRoute('Logout error', async (req) => {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (token) {
      await redis.deleteSession(token)
      logger.success('Admin logout successful')
    }

    return ok(undefined, 'Logout successful')
  }),
)

// 修改账户信息
router.post(
  '/auth/change-password',
  asyncRoute('Change password error', async (req) => {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (!token) {
      throw unauthorized('Authentication required')
    }

    const { newUsername, currentPassword, newPassword } = parseObjectBody(req.body, '修改管理员密码')

    if (!currentPassword || !newPassword) {
      throw badRequest('Current password and new password are required')
    }

    // 验证新密码长度
    if (newPassword.length < 8) {
      throw badRequest('New password must be at least 8 characters long')
    }

    // 获取当前会话
    const sessionData = await redis.getSession(token)

    // 安全修复：检查空对象
    if (!sessionData || Object.keys(sessionData).length === 0) {
      throw unauthorized('Session expired or invalid')
    }

    // 安全修复：验证会话完整性
    if (!sessionData.username || !sessionData.loginTime) {
      logger.security(`Invalid session structure in /auth/change-password from ${req.ip || 'unknown'}`)
      await redis.deleteSession(token)
      throw unauthorized('Session data corrupted or incomplete')
    }

    // 获取当前管理员信息
    const adminData = await redis.getSession('admin_credentials')
    if (!adminData) {
      throw new Error('Administrator credentials not found')
    }

    // 验证当前密码
    const isValidPassword = await bcrypt.compare(currentPassword, adminData.passwordHash)
    if (!isValidPassword) {
      logger.security(`Invalid current password attempt for user: ${sessionData.username}`)
      throw unauthorized('Current password is incorrect')
    }

    // 准备更新的数据
    const updatedUsername = newUsername && newUsername.trim() ? newUsername.trim() : adminData.username

    // 先更新 init.json（唯一真实数据源）
    const initFilePath = path.join(__dirname, '../../data/init.json')
    if (!fs.existsSync(initFilePath)) {
      throw new Error('init.json file is missing')
    }

    try {
      const initData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'))

      // 更新 init.json
      initData.adminUsername = updatedUsername
      initData.adminPassword = newPassword // 保存明文密码到init.json
      initData.updatedAt = new Date().toISOString()

      // 先写入文件（如果失败则不会影响 Redis）
      fs.writeFileSync(initFilePath, JSON.stringify(initData, null, 2))

      // 文件写入成功后，更新 Redis 缓存
      const saltRounds = 10
      const newPasswordHash = await bcrypt.hash(newPassword, saltRounds)

      const updatedAdminData = {
        username: updatedUsername,
        passwordHash: newPasswordHash,
        createdAt: adminData.createdAt,
        lastLogin: adminData.lastLogin,
        updatedAt: new Date().toISOString(),
      }

      await redis.setSession('admin_credentials', updatedAdminData)
    } catch (fileError) {
      logger.error('Failed to update init.json:', fileError)
      throw new Error('Failed to update configuration file', { cause: fileError })
    }

    // 清除当前会话（强制用户重新登录）
    await redis.deleteSession(token)

    logger.success(`Admin password changed successfully for user: ${updatedUsername}`)

    return ok({ newUsername: updatedUsername }, 'Password changed successfully. Please login again.')
  }),
)

// 获取当前用户信息
router.get(
  '/auth/user',
  asyncRoute('Get user info error', async (req) => {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (!token) {
      throw unauthorized('Authentication required')
    }

    // 获取当前会话
    const sessionData = await redis.getSession(token)

    // 安全修复：检查空对象
    if (!sessionData || Object.keys(sessionData).length === 0) {
      throw unauthorized('Session expired or invalid')
    }

    // 安全修复：验证会话完整性
    if (!sessionData.username || !sessionData.loginTime) {
      logger.security(`Invalid session structure in /auth/user from ${req.ip || 'unknown'}`)
      await redis.deleteSession(token)
      throw unauthorized('Session data corrupted or incomplete')
    }

    // 获取管理员信息
    const adminData = await redis.getSession('admin_credentials')
    if (!adminData) {
      throw new Error('Administrator credentials not found')
    }

    return {
      user: {
        username: adminData.username,
        loginTime: sessionData.loginTime,
        lastActivity: sessionData.lastActivity,
      },
    }
  }),
)

// 刷新token
router.post(
  '/auth/refresh',
  asyncRoute('Token refresh error', async (req) => {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken

    if (!token) {
      throw unauthorized('Authentication required')
    }

    const sessionData = await redis.getSession(token)

    // 安全修复：检查空对象（hgetall 对不存在的 key 返回 {}）
    if (!sessionData || Object.keys(sessionData).length === 0) {
      throw unauthorized('Session expired or invalid')
    }

    // 安全修复：验证会话完整性（必须有 username 和 loginTime）
    if (!sessionData.username || !sessionData.loginTime) {
      logger.security(`Invalid session structure detected from ${req.ip || 'unknown'}`)
      await redis.deleteSession(token) // 清理无效/伪造的会话
      throw unauthorized('Session data corrupted or incomplete')
    }

    // 更新最后活动时间
    sessionData.lastActivity = new Date().toISOString()
    await redis.setSession(token, sessionData, config.security.adminSessionTimeout)

    return {
      token,
      expiresIn: config.security.adminSessionTimeout,
    }
  }),
)
