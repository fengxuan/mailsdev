import { CloudflareProvider, type CloudflareEmailBinding } from './cloudflare'
import { ResendProvider } from './resend'
import { ZeptoMailProvider } from './zeptomail'
import { SESProvider } from './ses'
import {
  AllProvidersFailedError,
  UnsupportedFeatureError,
  type EmailProvider,
  type ProviderName,
  type SendRequest,
  type SendResult,
} from './types'

export interface ChainEnv {
  OUTBOUND_FROM_EMAIL?: string
  RESEND_FROM_EMAIL?: string
  ZEPTOMAIL_FROM_EMAIL?: string
  EMAIL?: CloudflareEmailBinding
  RESEND_API_KEY?: string
  ZEPTOMAIL_API_KEY?: string
  ZEPTOMAIL_API_BASE_URL?: string
  AWS_SES_REGION?: string
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_SESSION_TOKEN?: string
  AWS_SES_ENDPOINT?: string
  EMAIL_PROVIDERS?: string
}

const DEFAULT_ORDER: ProviderName[] = ['cloudflare', 'zeptomail', 'resend', 'ses']

export function buildProviderChain(env: ChainEnv, fetchImpl: typeof fetch = fetch): EmailProvider[] {
  const order = parseOrder(env.EMAIL_PROVIDERS)
  const chain: EmailProvider[] = []
  for (const name of order) {
    if (name === 'cloudflare' && env.EMAIL && typeof env.EMAIL.send === 'function') {
      chain.push(withFixedFrom(new CloudflareProvider(env.EMAIL), env.OUTBOUND_FROM_EMAIL))
    } else if (name === 'resend' && env.RESEND_API_KEY) {
      chain.push(withFixedFrom(
        new ResendProvider(env.RESEND_API_KEY, fetchImpl),
        env.RESEND_FROM_EMAIL ?? env.OUTBOUND_FROM_EMAIL,
      ))
    } else if (name === 'zeptomail' && env.ZEPTOMAIL_API_KEY) {
      chain.push(withFixedFrom(
        new ZeptoMailProvider(env.ZEPTOMAIL_API_KEY, fetchImpl, env.ZEPTOMAIL_API_BASE_URL),
        env.ZEPTOMAIL_FROM_EMAIL ?? env.OUTBOUND_FROM_EMAIL,
      ))
    } else if (
      name === 'ses'
      && env.AWS_SES_REGION
      && env.AWS_ACCESS_KEY_ID
      && env.AWS_SECRET_ACCESS_KEY
    ) {
      chain.push(withFixedFrom(new SESProvider({
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      }, {
        region: env.AWS_SES_REGION,
        ...(env.AWS_SES_ENDPOINT ? { endpoint: env.AWS_SES_ENDPOINT } : {}),
      }, fetchImpl), env.OUTBOUND_FROM_EMAIL))
    }
  }
  return chain
}

export async function sendWithChain(
  chain: EmailProvider[],
  req: SendRequest,
): Promise<SendResult> {
  if (chain.length === 0) {
    throw new Error('No email provider configured')
  }

  const attempts: Array<{ provider: ProviderName; error: string }> = []
  let anySupports = false

  for (const provider of chain) {
    if (!provider.supports(req)) continue
    anySupports = true
    try {
      return await provider.send(req)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      attempts.push({
        provider: provider.name,
        error: errorMessage,
      })
      console.warn(JSON.stringify({
        event: 'outbound_provider_failed',
        source: 'mails-worker',
        provider: provider.name,
        error: errorMessage,
      }))
    }
  }

  if (!anySupports) {
    const features: string[] = []
    if (req.attachments?.length) features.push('attachments')
    if (Object.keys(req.headers ?? {}).length > 0) features.push('headers')
    if (req.cc?.length) features.push('cc')
    if (req.bcc?.length) features.push('bcc')
    const hint = features.length > 0 ? ` (required: ${features.join(', ')})` : ''
    throw new UnsupportedFeatureError(
      `No provider in chain supports the request${hint}. Configured chain: ${chain.map(p => p.name).join(',') || 'empty'}`,
    )
  }

  throw new AllProvidersFailedError(attempts)
}

function parseOrder(raw: string | undefined): ProviderName[] {
  if (!raw) return DEFAULT_ORDER
  const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const valid: ProviderName[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (name === 'cloudflare' || name === 'resend' || name === 'zeptomail' || name === 'ses') {
      if (!seen.has(name)) {
        valid.push(name)
        seen.add(name)
      }
    }
  }
  return valid.length > 0 ? valid : DEFAULT_ORDER
}

function withFixedFrom(provider: EmailProvider, fixedFrom: string | undefined): EmailProvider {
  if (!fixedFrom?.trim()) {
    return provider
  }

  return {
    name: provider.name,
    supports(req) {
      return provider.supports(normalizeProviderRequest(req, fixedFrom))
    },
    send(req) {
      return provider.send(normalizeProviderRequest(req, fixedFrom))
    },
  }
}

function normalizeProviderRequest(req: SendRequest, fixedFrom: string): SendRequest {
  const { use_provider_default_sender: useProviderDefaultSender, ...baseReq } = req
  if (useProviderDefaultSender !== true) {
    return baseReq
  }

  const desiredAddress = normalizeMailbox(fixedFrom)
  if (!desiredAddress) {
    return baseReq
  }

  const currentAddress = normalizeMailbox(baseReq.from)
  if (!currentAddress || currentAddress === desiredAddress) {
    return baseReq
  }

  return {
    ...baseReq,
    from: replaceFromAddress(baseReq.from, desiredAddress),
    reply_to: baseReq.reply_to ?? currentAddress,
  }
}

function normalizeMailbox(value: string): string {
  const match = value.match(/<([^>]+)>/)
  return (match?.[1] ?? value).trim().toLowerCase()
}

function replaceFromAddress(from: string, newAddress: string): string {
  const trimmed = from.trim()
  const match = trimmed.match(/^(.*)<([^>]+)>$/)
  if (!match) {
    return newAddress
  }

  const prefix = match[1]?.trimEnd() ?? ''
  return prefix ? `${prefix} <${newAddress}>` : newAddress
}
