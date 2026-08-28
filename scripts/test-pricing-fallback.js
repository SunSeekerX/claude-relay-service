#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pricingService } from '../src/modules/pricing/pricing_service.js'
// 测试定价服务的fallback机制
async function testPricingFallback() {
  console.log('Testing pricing service fallback mechanism...\n')

  // 备份现有的模型定价文件
  const dataDir = path.join(process.cwd(), 'data')
  const pricingFile = path.join(dataDir, 'model_pricing.json')
  const backupFile = path.join(dataDir, 'model_pricing.backup.json')

  // 1. 备份现有文件
  if (fs.existsSync(pricingFile)) {
    console.log('Backing up existing pricing file...')
    fs.copyFileSync(pricingFile, backupFile)
  }

  try {
    // 2. 删除现有定价文件以触发fallback
    if (fs.existsSync(pricingFile)) {
      console.log(' Removing existing pricing file to test fallback...')
      fs.unlinkSync(pricingFile)
    }

    // 3. 初始化定价服务
    console.log('Initializing pricing service...\n')

    // 清除require缓存以确保重新加载
    delete require.cache[require.resolve('../src/modules/pricing/pricing_service.js')]

    // 模拟网络失败，强制使用fallback
    const originalDownload = pricingService._downloadFromRemote
    pricingService._downloadFromRemote = function () {
      return Promise.reject(new Error('Simulated network failure for testing'))
    }

    // 初始化服务
    await pricingService.initialize()

    // 4. 验证fallback是否工作
    console.log('\nVerifying fallback data...')
    const status = pricingService.getStatus()
    console.log(`   - Initialized: ${status.initialized}`)
    console.log(`   - Model count: ${status.modelCount}`)
    console.log(`   - Last updated: ${status.lastUpdated}`)

    // 5. 测试获取模型定价
    const testModels = ['claude-3-opus-20240229', 'gpt-4', 'gemini-pro']
    console.log('\nTesting model pricing retrieval:')

    for (const model of testModels) {
      const pricing = pricingService.getModelPricing(model)
      if (pricing) {
        console.log(`   ${model}: Found pricing data`)
      } else {
        console.log(`   ${model}: No pricing data`)
      }
    }

    // 6. 验证文件是否被创建
    if (fs.existsSync(pricingFile)) {
      console.log('\nFallback successfully created pricing file in data directory')
      const fileStats = fs.statSync(pricingFile)
      console.log(`   - File size: ${(fileStats.size / 1024).toFixed(2)} KB`)
    } else {
      console.log('\nFallback failed to create pricing file')
    }

    // 恢复原始下载函数
    pricingService._downloadFromRemote = originalDownload
  } finally {
    // 7. 恢复备份文件
    if (fs.existsSync(backupFile)) {
      console.log('\nRestoring original pricing file...')
      fs.copyFileSync(backupFile, pricingFile)
      fs.unlinkSync(backupFile)
    }
  }

  console.log('\nFallback mechanism test completed!')
}

// 运行测试
testPricingFallback().catch((error) => {
  console.error('Test failed:', error)
  process.exit(1)
})
