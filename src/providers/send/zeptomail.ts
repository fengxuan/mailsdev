import type { SendProvider, SendResult } from '../../core/types.js'

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

interface ZeptoMailAddress {
  address: string
  name?: string
}

export function createZeptoMailProvider(apiKey: string): SendProvider {
  return {
    name: 'zeptomail',

    async send(options): Promise<SendResult> {
      const from = parseAddress(options.from)
      const body: Record<string, unknown> = {
        from,
        to: options.to.map((address) => ({
          email_address: { address },
        })),
        subject: options.subject,
      }

      if (options.html) {
        body.htmlbody = options.html
      } else if (options.text) {
        body.textbody = options.text
      }

      if (options.replyTo) {
        body.reply_to = [parseAddress(options.replyTo)]
      }
      if (options.headers && Object.keys(options.headers).length > 0) {
        body.mime_headers = options.headers
      }
      if (options.attachments?.length) {
        const attachments = options.attachments
          .filter((attachment) => !attachment.contentId)
          .map((attachment) => ({
            name: attachment.filename,
            content: attachment.content,
            ...(attachment.contentType ? { mime_type: attachment.contentType } : {}),
          }))
        if (attachments.length > 0) {
          body.attachments = attachments
        }

        const inlineImages = options.attachments
          .filter((attachment) => attachment.contentId)
          .map((attachment) => ({
            name: attachment.filename,
            content: attachment.content,
            cid: attachment.contentId!,
            ...(attachment.contentType ? { mime_type: attachment.contentType } : {}),
          }))
        if (inlineImages.length > 0) {
          body.inline_images = inlineImages
        }
      }

      const res = await fetch('https://api.zeptomail.com/v1.1/email', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Zoho-enczapikey ${apiKey}`,
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
        throw new Error(`ZeptoMail error: ${detailMessage ? `${errorMessage} (${detailMessage})` : errorMessage}`)
      }

      return {
        id: data.request_id ?? data.error?.request_id ?? crypto.randomUUID(),
        provider: 'zeptomail',
      }
    },
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
