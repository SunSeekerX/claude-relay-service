import { logger } from './logger.js'
import { CLIENT_DEFINITIONS } from './validator_client_definitions.js'

/**
 * Gemini CLI 验证器
 * 验证请求是否来自 Gemini CLI
 */
export class GeminiCliValidator {
  /**
   * 获取客户端ID
   */
  static getId() {
    return CLIENT_DEFINITIONS.GEMINI_CLI.id
  }

  /**
   * 获取客户端名称
   */
  static getName() {
    return CLIENT_DEFINITIONS.GEMINI_CLI.name
  }

  /**
   * 获取客户端描述
   */
  static getDescription() {
    return CLIENT_DEFINITIONS.GEMINI_CLI.description
  }

  /**
   * 获取客户端图标
   */
  static getIcon() {
    return CLIENT_DEFINITIONS.GEMINI_CLI.icon || '💎'
  }

  /**
   * 验证请求是否来自 Gemini CLI
   * @param {Object} req - Express 请求对象
   * @returns {boolean} 验证结果
   */
  static validate(req) {
    try {
      const userAgent = req.headers['user-agent'] || ''
      const path = req.originalUrl || ''

      // 1. 必须是 Gemini 官方路径：/gemini 前缀 或 根 /v1beta /v1internal
      const isGeminiPath =
        path.startsWith('/gemini') ||
        path.startsWith('/v1beta') ||
        path.startsWith('/v1internal') ||
        path.includes('/v1beta/') ||
        path.includes('/v1internal')
      if (!isGeminiPath) {
        return false
      }

      // 2. 对 generateContent 路径验证 User-Agent
      if (path.includes('generateContent')) {
        // 包含 generateContent 的路径需要验证 User-Agent
        const geminiCliPattern = /^GeminiCLI\/v?[\d.]+/i
        if (!geminiCliPattern.test(userAgent)) {
          logger.debug(`Gemini CLI validation failed - UA mismatch for generateContent: ${userAgent}`)
          return false
        }
      }

      // 所有必要检查通过
      logger.debug(`Gemini CLI validation passed for path: ${path}`)
      return true
    } catch (error) {
      logger.error('Error in GeminiCliValidator:', error)
      // 验证出错时默认拒绝
      return false
    }
  }

  /**
   * 比较版本号
   * @returns {number} -1: v1 < v2, 0: v1 = v2, 1: v1 > v2
   */
  static compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number)
    const parts2 = v2.split('.').map(Number)

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0
      const part2 = parts2[i] || 0

      if (part1 < part2) {
        return -1
      }
      if (part1 > part2) {
        return 1
      }
    }

    return 0
  }

  /**
   * 获取验证器信息
   */
  static getInfo() {
    return {
      id: this.getId(),
      name: this.getName(),
      description: this.getDescription(),
      icon: CLIENT_DEFINITIONS.GEMINI_CLI.icon,
    }
  }
}
