import PostalMime, { type Attachment as PostalMimeAttachment } from 'postal-mime'
import type { Attachment, AttachmentTextExtractionStatus } from '../../src/core/types.js'
import { htmlToText } from './extract-code'

const TEXT_EXTRACTION_LIMIT_BYTES = 10 * 1024 * 1024
const TEXT_ATTACHMENT_TYPES = new Set([
  'application/json',
  'text/csv',
  'text/markdown',
  'text/plain',
])

export interface ParsedIncomingEmail {
  subject: string
  bodyText: string
  bodyHtml: string
  bodyHtmlText: string | null
  headers: Record<string, string>
  messageId: string | null
  attachmentCount: number
  attachmentNames: string
  attachmentSearchText: string
  attachments: Attachment[]
  pendingAttachmentTextExtractions: PendingAttachmentTextExtraction[]
}

export interface PendingAttachmentTextExtraction {
  attachmentId: string
  mimePartIndex: number
  filename: string
  content: PostalMimeAttachment['content']
}

interface ParseIncomingEmailOptions {
  deferAttachmentTextExtraction?: boolean
}

export async function parseIncomingEmail(
  raw: ArrayBuffer,
  emailId: string,
  createdAt: string,
  options: ParseIncomingEmailOptions = {},
): Promise<ParsedIncomingEmail> {
  const parser = new PostalMime({ attachmentEncoding: 'arraybuffer' })
  const parsed = await parser.parse(raw)
  const pendingAttachmentTextExtractions: PendingAttachmentTextExtraction[] = []
  const attachments = parsed.attachments.map((attachment, index) => {
    const prepared = toAttachmentRecord(attachment, emailId, index, createdAt, options)
    if (prepared.pendingTextExtraction) {
      pendingAttachmentTextExtractions.push(prepared.pendingTextExtraction)
    }
    return prepared.attachment
  })
  const rawBodyText = typeof parsed.text === 'string' ? parsed.text : ''
  const hasBodyText = rawBodyText.trim().length > 0
  const bodyHtml = typeof parsed.html === 'string' ? parsed.html : ''
  const bodyHtmlText = hasBodyText ? null : htmlToText(bodyHtml)
  const bodyText = hasBodyText ? rawBodyText : (bodyHtmlText ?? '')

  return {
    subject: parsed.subject ?? '',
    bodyText,
    bodyHtml,
    bodyHtmlText,
    headers: headersToRecord(parsed.headers),
    messageId: parsed.messageId ?? null,
    attachmentCount: attachments.length,
    attachmentNames: attachments.map((attachment) => attachment.filename).join(' '),
    attachmentSearchText: attachments
      .map((attachment) => attachment.text_content)
      .filter((value) => value.length > 0)
      .join('\n\n'),
    attachments,
    pendingAttachmentTextExtractions,
  }
}

function toAttachmentRecord(
  attachment: PostalMimeAttachment,
  emailId: string,
  mimePartIndex: number,
  createdAt: string,
  options: ParseIncomingEmailOptions,
): { attachment: Attachment; pendingTextExtraction: PendingAttachmentTextExtraction | null } {
  const filename = attachment.filename?.trim() || `attachment-${mimePartIndex + 1}`
  const sizeBytes = getAttachmentSize(attachment.content)
  const extraction = prepareAttachmentTextExtraction(attachment, filename, sizeBytes, mimePartIndex, options)

  return {
    attachment: {
      id: extraction.attachmentId,
      email_id: emailId,
      filename,
      content_type: attachment.mimeType || 'application/octet-stream',
      size_bytes: sizeBytes,
      content_disposition: attachment.disposition ?? null,
      content_id: attachment.contentId ?? null,
      mime_part_index: mimePartIndex,
      text_content: extraction.text,
      text_extraction_status: extraction.status,
      storage_key: null,
      downloadable: false,
      created_at: createdAt,
    },
    pendingTextExtraction: extraction.pendingTextExtraction,
  }
}

function headersToRecord(headers: Array<{ originalKey: string; value: string }>): Record<string, string> {
  const record: Record<string, string> = {}

  for (const header of headers) {
    if (record[header.originalKey]) {
      record[header.originalKey] += `\n${header.value}`
      continue
    }

    record[header.originalKey] = header.value
  }

  return record
}

function prepareAttachmentTextExtraction(
  attachment: PostalMimeAttachment,
  filename: string,
  sizeBytes: number | null,
  mimePartIndex: number,
  options: ParseIncomingEmailOptions,
): {
  attachmentId: string
  text: string
  status: AttachmentTextExtractionStatus
  pendingTextExtraction: PendingAttachmentTextExtraction | null
} {
  const attachmentId = crypto.randomUUID()

  if (sizeBytes !== null && sizeBytes > TEXT_EXTRACTION_LIMIT_BYTES) {
    return { attachmentId, text: '', status: 'too_large', pendingTextExtraction: null }
  }

  if (!TEXT_ATTACHMENT_TYPES.has(attachment.mimeType)) {
    return { attachmentId, text: '', status: 'unsupported', pendingTextExtraction: null }
  }

  if (options.deferAttachmentTextExtraction) {
    return {
      attachmentId,
      text: '',
      status: 'pending',
      pendingTextExtraction: {
        attachmentId,
        mimePartIndex,
        filename,
        content: attachment.content,
      },
    }
  }

  try {
    return {
      attachmentId,
      text: decodeAttachmentContent(attachment.content),
      status: 'done',
      pendingTextExtraction: null,
    }
  } catch {
    return { attachmentId, text: '', status: 'failed', pendingTextExtraction: null }
  }
}

export function decodeAttachmentContent(content: PostalMimeAttachment['content']): string {
  if (typeof content === 'string') {
    return content
  }

  if (content instanceof Uint8Array) {
    return new TextDecoder().decode(content)
  }

  return new TextDecoder().decode(new Uint8Array(content))
}

function getAttachmentSize(content: PostalMimeAttachment['content']): number | null {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content).byteLength
  }

  if (content instanceof Uint8Array) {
    return content.byteLength
  }

  if (content instanceof ArrayBuffer) {
    return content.byteLength
  }

  return null
}
