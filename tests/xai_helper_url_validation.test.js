import { validateBaseUrl } from '../src/common/xai_helper.js'

describe('xai_helper validateBaseUrl private host guard', () => {
  it('rejects plain private IPv4', () => {
    expect(() => validateBaseUrl('https://127.0.0.1/v1')).toThrow(/private hosts/)
    expect(() => validateBaseUrl('https://10.0.0.1/v1')).toThrow(/private hosts/)
    expect(() => validateBaseUrl('https://192.168.1.1/v1')).toThrow(/private hosts/)
  })

  it('rejects IPv4-mapped and IPv4-compatible IPv6 forms', () => {
    expect(() => validateBaseUrl('https://[::ffff:127.0.0.1]/v1')).toThrow(/private hosts/)
    expect(() => validateBaseUrl('https://[::ffff:7f00:1]/v1')).toThrow(/private hosts/)
    expect(() => validateBaseUrl('https://[::7f00:1]/v1')).toThrow(/private hosts/)
    expect(() => validateBaseUrl('https://[::a9fe:a9fe]/v1')).toThrow(/private hosts/)
  })

  it('allows official and public hosts', () => {
    expect(validateBaseUrl('https://api.x.ai/v1')).toContain('api.x.ai')
    expect(validateBaseUrl('https://cli-chat-proxy.grok.com/v1')).toContain('cli-chat-proxy.grok.com')
    expect(validateBaseUrl('https://8.8.8.8/v1')).toContain('8.8.8.8')
  })
})
