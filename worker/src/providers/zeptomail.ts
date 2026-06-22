import type { EmailProvider, SendRequest, SendResult } from './types'

interface ZeptoMailAddress {
  address: string
  name?: string
}

interface ZeptoMailSuccessResponse {
  request_id?: string
}

interface ZeptoMailErrorDetail {
  message?: string
  target?: string
}

interface ZeptoMailErrorResponse {
  error?: {
    message?: string
    details?: ZeptoMailErrorDetail[]
    request_id?: string
  }
  message?: string
  request_id?: string
}

export class ZeptoMailProvider implements EmailProvider {
  readonly name = 'zeptomail' as const
  private readonly fetchImpl: typeof fetch

  constructor(
    private apiKey: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init))
  }

  supports(_req: SendRequest): boolean {
    return true
  }

  async send(req: SendRequest): Promise<SendResult> {
    const body: Record<string, unknown> = {
      from: parseAddress(req.from),
      to: req.to.map((address) => ({
        email_address: { address },
      })),
      subject: req.subject,
    }

    if (req.html) {
      body.htmlbody = req.html
    } else if (req.text) {
      body.textbody = req.text
    }
    if (req.reply_to) {
      body.reply_to = [parseAddress(req.reply_to)]
    }
    if (req.headers && Object.keys(req.headers).length > 0) {
      body.mime_headers = req.headers
    }
    if (req.cc?.length) {
      body.cc = req.cc.map((address) => ({
        email_address: { address },
      }))
    }
    if (req.bcc?.length) {
      body.bcc = req.bcc.map((address) => ({
        email_address: { address },
      }))
    }
    if (req.attachments?.length) {
      body.attachments = req.attachments.map((attachment) => ({
        name: attachment.filename,
        content: attachment.content,
        ...(attachment.content_type ? { mime_type: attachment.content_type } : {}),
      }))
    }

    const doFetch = this.fetchImpl
    const res = await doFetch('https://api.zeptomail.com/v1.1/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Zoho-enczapikey ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await res.json().catch(() => ({})) as ZeptoMailSuccessResponse & ZeptoMailErrorResponse
    if (!res.ok) {
      const errorMessage = data.error?.message ?? data.message ?? res.statusText
      const detailMessage = data.error?.details
        ?.map((detail) => detail.target ? `${detail.target}: ${detail.message ?? 'invalid value'}` : (detail.message ?? 'invalid value'))
        .join('; ')
      throw new Error(`ZeptoMail: ${detailMessage ? `${errorMessage} (${detailMessage})` : errorMessage}`)
    }

    return {
      id: data.request_id ?? data.error?.request_id ?? crypto.randomUUID(),
      provider: 'zeptomail',
    }
  }
}

function parseAddress(value: string): ZeptoMailAddress {
  const trimmed = value.trim()
  const match = trimmed.match(/^(.*)<([^>]+)>$/)
  if (!match) {
    return { address: trimmed }
  }

  const name = stripWrappingQuotes(match[1]?.trim() ?? '')
  const address = match[2]?.trim() ?? trimmed
  return name ? { address, name } : { address }
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1').trim()
}
