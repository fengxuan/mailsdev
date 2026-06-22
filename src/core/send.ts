import type { SendOptions, SendProvider, SendResult } from './types.js'
import { loadConfig, resolveApiKey } from './config.js'
import { createResendProvider } from '../providers/send/resend.js'
import { createZeptoMailProvider } from '../providers/send/zeptomail.js'
import { createHostedSendProvider } from '../providers/send/hosted.js'
import { createOSSSendProvider } from '../providers/send/oss.js'
import { prepareSendAttachments } from './send-attachments.js'

function resolveProvider(): SendProvider {
  const config = loadConfig()

  // Priority:
  // 1. api_key (hosted mode) → cloud send via /v1/send (100 free/month + x402)
  // 2. worker_url → OSS worker /api/send
  // 3. direct provider key → direct provider (self-managed)
  // 4. Nothing configured → error

  if (config.api_key) {
    return createHostedSendProvider(config.api_key)
  }

  if (config.worker_url) {
    if (!config.worker_token) {
      throw new Error('worker_token not configured. Run: mails config set worker_token <token>')
    }
    return createOSSSendProvider(config.worker_url, config.worker_token)
  }

  const preferredSendProvider = config.send_provider?.trim().toLowerCase()
  if (preferredSendProvider === 'zeptomail' && config.zeptomail_api_key) {
    return createZeptoMailProvider(config.zeptomail_api_key, config.zeptomail_api_base_url)
  }
  if (preferredSendProvider === 'resend' && config.resend_api_key) {
    return createResendProvider(config.resend_api_key)
  }

  if (config.zeptomail_api_key) {
    return createZeptoMailProvider(config.zeptomail_api_key, config.zeptomail_api_base_url)
  }
  if (config.resend_api_key) {
    return createResendProvider(config.resend_api_key)
  }

  if (preferredSendProvider === 'zeptomail') {
    throw new Error('zeptomail_api_key not configured. Run: mails config set zeptomail_api_key <key>')
  }
  if (preferredSendProvider === 'resend') {
    throw new Error('resend_api_key not configured. Run: mails config set resend_api_key <key>')
  }

  throw new Error('No send provider configured. Run: mails claim <name> or configure worker_url/resend_api_key/zeptomail_api_key')
}

export async function send(options: SendOptions): Promise<SendResult> {
  const config = loadConfig()
  const provider = resolveProvider()

  let from = options.from ?? config.default_from

  // Auto-fetch from address if using hosted mode and not configured
  if (!from && config.api_key) {
    from = await resolveApiKey(config.api_key) ?? undefined
  }

  if (!from) {
    throw new Error('No "from" address. Set default_from or pass --from')
  }

  const to = Array.isArray(options.to) ? options.to : [options.to]

  if (!options.text && !options.html) {
    throw new Error('Either text or html body is required')
  }

  const attachments = await prepareSendAttachments(options.attachments)

  return provider.send({ from, to, subject: options.subject, text: options.text, html: options.html, replyTo: options.replyTo, headers: options.headers, attachments })
}
