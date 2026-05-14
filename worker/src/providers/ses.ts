import type { EmailProvider, SendRequest, SendResult } from './types'

interface SESCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

interface SESOptions {
  region: string
  endpoint?: string
}

export class SESProvider implements EmailProvider {
  readonly name = 'ses' as const
  private readonly fetchImpl: typeof fetch
  private readonly endpoint: string

  constructor(
    private credentials: SESCredentials,
    private options: SESOptions,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init))
    this.endpoint = options.endpoint?.trim() || `https://email.${options.region}.amazonaws.com/v2/email/outbound-emails`
  }

  supports(req: SendRequest): boolean {
    return !req.attachments?.length
  }

  async send(req: SendRequest): Promise<SendResult> {
    const body = JSON.stringify({
      FromEmailAddress: req.from,
      Destination: {
        ToAddresses: req.to,
        ...(req.cc?.length ? { CcAddresses: req.cc } : {}),
        ...(req.bcc?.length ? { BccAddresses: req.bcc } : {}),
      },
      Content: {
        Simple: {
          Subject: { Data: req.subject, Charset: 'UTF-8' },
          Body: {
            ...(req.text ? { Text: { Data: req.text, Charset: 'UTF-8' } } : {}),
            ...(req.html ? { Html: { Data: req.html, Charset: 'UTF-8' } } : {}),
          },
        },
      },
      ...(req.reply_to ? { ReplyToAddresses: [req.reply_to] } : {}),
    })

    const requestUrl = new URL(this.endpoint)
    const now = new Date()
    const amzDate = toAmzDate(now)
    const dateStamp = amzDate.slice(0, 8)
    const bodyHash = await sha256Hex(body)
    const canonicalHeaders = buildCanonicalHeaders(requestUrl, amzDate, bodyHash, this.credentials.sessionToken)
    const signedHeaders = Object.keys(canonicalHeaders).sort().join(';')
    const canonicalRequest = [
      'POST',
      canonicalUri(requestUrl),
      canonicalQueryString(requestUrl),
      canonicalHeadersString(canonicalHeaders),
      signedHeaders,
      bodyHash,
    ].join('\n')

    const credentialScope = `${dateStamp}/${this.options.region}/ses/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join('\n')
    const signingKey = await deriveSigningKey(this.credentials.secretAccessKey, dateStamp, this.options.region, 'ses')
    const signature = toHex(await hmacSha256(signingKey, stringToSign))
    const authorization = [
      `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(', ')

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-amz-content-sha256': bodyHash,
      'x-amz-date': amzDate,
      authorization,
    }
    if (this.credentials.sessionToken) {
      headers['x-amz-security-token'] = this.credentials.sessionToken
    }

    const doFetch = this.fetchImpl
    const res = await doFetch(requestUrl.toString(), {
      method: 'POST',
      headers,
      body,
    })

    const data = await res.json().catch(() => ({})) as { MessageId?: string; message?: string; Message?: string }
    if (!res.ok) {
      throw new Error(`SES: ${data.message ?? data.Message ?? res.statusText}`)
    }

    return { id: data.MessageId ?? crypto.randomUUID(), provider: 'ses' }
  }
}

function canonicalUri(url: URL): string {
  return url.pathname || '/'
}

function canonicalQueryString(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&')
}

function buildCanonicalHeaders(url: URL, amzDate: string, bodyHash: string, sessionToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': amzDate,
  }
  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken
  }
  return headers
}

function canonicalHeadersString(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), normalizeHeaderValue(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}\n`)
    .join('')
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

async function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = await hmacSha256(kDate, region)
  const kService = await hmacSha256(kRegion, service)
  return hmacSha256(kService, 'aws4_request')
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return toHex(digest)
}

async function hmacSha256(key: string | BufferSource, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message))
}

function toHex(buffer: BufferSource): string {
  return Array.from(new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

const encoder = new TextEncoder()
