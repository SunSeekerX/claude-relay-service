import { registry } from './payment_registry.js'
import { MockProvider } from './payment_mock_provider.js'
import { EpayProvider } from './payment_epay_provider.js'
import { XunhupayProvider } from './payment_xunhupay_provider.js'
import { StripeProvider } from './payment_stripe_provider.js'
import { AlipayProvider } from './payment_alipay_provider.js'
import { WxpayProvider } from './payment_wxpay_provider.js'
// 支付渠道注册入口：应用启动时调用 initPaymentProviders 完成注册。
// 领域/用例只依赖 registry，不在别处直接 new 具体渠道。

let initialized = false

// 注册全部支付渠道。真实渠道按 providerKey 注册；具体用哪个实例由 providerRepository 选。
export const initPaymentProviders = () => {
  if (initialized) {
    return registry
  }
  registry.register(new MockProvider())
  registry.register(new EpayProvider())
  registry.register(new XunhupayProvider())
  registry.register(new StripeProvider())
  registry.register(new AlipayProvider())
  registry.register(new WxpayProvider())
  initialized = true
  return registry
}
