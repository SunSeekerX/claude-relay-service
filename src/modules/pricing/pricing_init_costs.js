#!/usr/bin/env node
import { costInitService } from './pricing_cost_init_service.js'
import { logger } from '../../common/logger.js'
import { redis } from '../../infra/redis.js'
const main = async function main() {
  try {
    // 连接Redis
    await redis.connect()

    console.log('Starting cost data initialization...\n')

    // 执行初始化
    const result = await costInitService.initializeAllCosts()

    console.log('\nCost initialization completed!')
    console.log(`   Processed: ${result.processed} API Keys`)
    console.log(`   Errors: ${result.errors}`)

    // 断开连接
    await redis.disconnect()
    throw new Error('INIT_COSTS_SUCCESS')
  } catch (error) {
    if (error.message === 'INIT_COSTS_SUCCESS') {
      return
    }
    console.error('\nCost initialization failed:', error.message)
    logger.error('Cost initialization failed:', error)
    throw error
  }
}

// 运行主函数
main()
