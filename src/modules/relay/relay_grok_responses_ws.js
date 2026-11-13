import * as xaiHelper from '../../common/xai_helper.js'
import { grokScheduler } from './relay_grok_scheduler.js'
import { grokAccountService } from '../account/account_grok_service.js'
import { pickGrokPassthroughHeaders } from './relay_header_filter.js'
import { isResponsesRateLimitError } from './relay_responses_stream_state.js'
import { handleNativeResponsesWebSocket } from './relay_native_responses_ws.js'

export const isGrokResponsesWebSocketPath = (path) => ['/grok/responses', '/grok/v1/responses'].includes(path)

export const handleGrokResponsesWebSocket = (req, socket, head) =>
  handleNativeResponsesWebSocket(req, socket, head, {
    accountType: 'grok',
    permission: 'grok',
    label: 'grok-responses',
    selectAccount: async (keyData, model) => {
      const account = await grokScheduler.selectAccount(keyData, model, null, { deferGroupAdmission: true })
      return grokAccountService.ensureFreshToken(account.id)
    },
    validateAccount: (account, model, keyData, options) =>
      grokScheduler.assertAccountForWebSocket(keyData, account.id, model, options),
    buildConnection: (account, request) => ({
      targetUrl: xaiHelper.buildResponsesUrl(grokAccountService.getUpstreamBaseUrl(account)),
      headers: {
        ...pickGrokPassthroughHeaders(request.headers),
        authorization: `Bearer ${account.authType === 'apikey' ? account.apiKey : account.accessToken}`,
        ...(account.authType === 'oauth' ? xaiHelper.buildCliIdentityHeaders() : {}),
        ...((account.userAgent ?? request.headers['user-agent'])
          ? { 'User-Agent': account.userAgent ?? request.headers['user-agent'] }
          : {}),
      },
    }),
    onTerminal: async (event, account) => {
      const error = event.response?.error ?? event.error
      if (isResponsesRateLimitError(error) && String(account.disableAutoProtection) !== 'true') {
        const seconds = Number(error.resets_in_seconds)
        await grokAccountService.markAccountRateLimited(
          account.id,
          Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 60,
        )
      }
    },
  })
