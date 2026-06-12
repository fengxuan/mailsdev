import { extractEmailCode } from './extract-code'
import { buildMailChatProjection } from './mail-chat-projection'
import { parseIncomingEmail } from './mime'
import {
  AllProvidersFailedError,
  UnsupportedFeatureError,
  buildProviderChain,
  sendWithChain,
  type CloudflareEmailBinding,
  type SendRequest,
} from './providers'

export interface Env {
  DB: D1Database
  /** Single-mailbox token. Requires MAILBOX to be set. */
  AUTH_TOKEN?: string
  ACCESS_TOKEN_SECRET?: string
  /** Single mailbox address associated with AUTH_TOKEN. */
  MAILBOX?: string
  /** Optional multi-mailbox token map as JSON: {"mailbox@example.com":"token"} */
  AUTH_TOKENS_JSON?: string
  /** Internal token used by trusted services to act on behalf of any mailbox. */
  INTERNAL_API_TOKEN?: string
  /** Fixed sender address allowed for outbound mail, e.g. chat@canyin.uk. */
  OUTBOUND_FROM_EMAIL?: string
  /** Resend API key for outbound email sending. */
  RESEND_API_KEY?: string
  /** AWS SES region for outbound email sending, e.g. us-east-1. */
  AWS_SES_REGION?: string
  /** AWS access key id for SES API requests. */
  AWS_ACCESS_KEY_ID?: string
  /** AWS secret access key for SES API requests. */
  AWS_SECRET_ACCESS_KEY?: string
  /** Optional AWS session token for temporary credentials. */
  AWS_SESSION_TOKEN?: string
  /** Optional custom SES endpoint for testing or alternate AWS partitions. */
  AWS_SES_ENDPOINT?: string
  /** Cloudflare Email Service binding (private beta). */
  EMAIL?: CloudflareEmailBinding
  /** Base URL for the realtime notify Worker, e.g. https://mails-realtime-notify.example.com */
  REALTIME_NOTIFY_BASE_URL?: string
  /** Internal bearer token required by the realtime notify Worker. */
  REALTIME_INTERNAL_TOKEN?: string
  /**
   * Ordered provider preference list, e.g. "cloudflare,resend,ses".
   * Defaults to "cloudflare,resend,ses"; providers lacking configuration are
   * silently skipped so existing Resend-only deployments continue to work.
   */
  EMAIL_PROVIDERS?: string
}

interface CliTokenAuthRow {
  mailbox: string
  token_hash: string
  expires_at: string
  revoked_at: string | null
  user_status: 'pending' | 'active' | 'disabled'
}

interface AccessTokenClaims {
  sub: string
  email: string
  mailbox: string
  iat: number
  exp: number
}

interface ConversationSummaryRow {
  peer_address: string
  id: string
  direction: 'inbound' | 'outbound'
  status: 'received' | 'sent' | 'failed' | 'queued'
  body_text: string
  body_html: string
  received_at: string
}

type RealtimeNotifyScope = 'direct' | 'group'
type RealtimeNotifyDirection = 'inbound' | 'outbound'
type RealtimeConversationType = 'direct' | 'group'
type RealtimeSyncMode = 'mail' | 'fast_chat'

interface RealtimeConversationPayload {
  peer: string
  conversation_type: RealtimeConversationType
  group_mailbox: string | null
  sync_mode: RealtimeSyncMode
  title: string
  peer_display_name: string | null
  peer_alias: string | null
  last_message: string
  last_render_text?: string | null
  last_direction: RealtimeNotifyDirection
  last_at: string
  last_sender_email: string | null
  last_sender_name: string | null
  unread_count: number
}

interface RealtimeMessagePayload {
  id: string
  peer: string
  conversation_type: RealtimeConversationType
  group_mailbox: string | null
  sync_mode: RealtimeSyncMode
  topic?: string | null
  direction: RealtimeNotifyDirection
  text: string
  render_text?: string | null
  sent_at: string
  status: 'received' | 'sent' | 'failed'
  sender_email: string | null
  sender_name: string | null
}

interface DirectExternalEmailThreadRow {
  id: string
  owner_mailbox: string
  peer_email: string
  topic_key: string
  topic_label: string | null
  anchor_message_id: string
  references_chain: string
  reply_subject: string | null
  created_at: string
  updated_at: string
}

interface RealtimeNotifyEvent {
  targetUserId: string
  mailbox: string
  source: string
  scope: RealtimeNotifyScope
  peer: string
  direction: RealtimeNotifyDirection
  conversationType?: RealtimeConversationType
  syncMode?: RealtimeSyncMode
  groupMailbox?: string | null
  conversation?: RealtimeConversationPayload
  message?: RealtimeMessagePayload
}

interface PersistedInboundEmailRef {
  id: string
  mailbox: string
  receivedAt: string
}

interface LocalDeliveryClassification {
  activeLocalRecipients: string[]
  deletedLocalRecipients: string[]
  unresolvedLocalRecipients: string[]
  allAreLocalDomain: boolean
  hasExternalRecipients: boolean
}

interface IndexedGroupRealtimeMessageRef {
  groupId: string
  groupMailbox: string
  syncMode: 'mail' | 'fast_chat'
  emailId: string
  senderEmail: string
  senderName: string | null
  receivedAt: string
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    let response: Response

    // /health is always public
    if (url.pathname === '/health') {
      response = Response.json({ ok: true })
    } else if (url.pathname.startsWith('/api/')) {
      const auth = await requirePublicAuthorizedMailbox(request, env)
      if ('response' in auth) {
        response = auth.response
      } else {
        switch (url.pathname) {
          case '/api/inbox':
            response = await handleInbox(url, env, auth.mailbox)
            break
          case '/api/code':
            response = await handleGetCode(url, env, auth.mailbox)
            break
          case '/api/email':
            response = await handleGetEmail(url, env, auth.mailbox)
            break
          case '/api/conversations':
            response = await handleConversations(url, env, auth.mailbox)
            break
          case '/api/send':
            if (request.method !== 'POST') {
              response = Response.json({ error: 'Method not allowed' }, { status: 405 })
            } else {
              response = await handleSend(request, env, auth.mailbox, ctx)
            }
            break
          case '/api/sync':
            response = await handleSync(url, env, auth.mailbox)
            break
          default:
            response = Response.json({ error: 'Not found' }, { status: 404 })
        }
      }
    } else if (url.pathname.startsWith('/internal/')) {
      const auth = await requireInternalAuthorizedMailbox(request, env)
      if ('response' in auth) {
        response = auth.response
      } else {
        switch (url.pathname) {
          case '/internal/inbox':
            response = await handleInbox(url, env, auth.mailbox)
            break
          case '/internal/code':
            response = await handleGetCode(url, env, auth.mailbox)
            break
          case '/internal/email':
            response = await handleGetEmail(url, env, auth.mailbox)
            break
          case '/internal/conversations':
            response = await handleConversations(url, env, auth.mailbox)
            break
          case '/internal/thread-latest-inbound':
            response = await handleLatestInboundThread(url, env, auth.mailbox)
            break
          case '/internal/send':
            if (request.method !== 'POST') {
              response = Response.json({ error: 'Method not allowed' }, { status: 405 })
            } else {
              response = await handleSend(request, env, auth.mailbox, ctx)
            }
            break
          case '/internal/mailbox/delete':
            if (request.method !== 'POST') {
              response = Response.json({ error: 'Method not allowed' }, { status: 405 })
            } else {
              response = await handleDeleteMailbox(env, auth.mailbox)
            }
            break
          case '/internal/sync':
            response = await handleSync(url, env, auth.mailbox)
            break
          default:
            response = Response.json({ error: 'Not found' }, { status: 404 })
        }
      }
    } else {
      response = Response.json({ name: 'mails-worker', version: '1.0.0' })
    }

    // Add CORS headers to all responses
    for (const [key, value] of Object.entries(corsHeaders)) {
      response.headers.set(key, value)
    }
    return response
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx?: ExecutionContext): Promise<void> {
    const to = message.to
    const from = message.from
    const mailbox = normalizeMailbox(to)
    const fromAddress = normalizeMailbox(message.headers.get('from') ?? from)
    if (await isDeletedMailbox(env, mailbox)) {
      return
    }
    const group = await getActiveChatGroupByMailbox(env, mailbox)
    if (group?.sync_mode === 'fast_chat') {
      console.warn(JSON.stringify({
        event: 'fast_chat_group_email_ignored',
        source: 'mails-worker',
        mailbox,
        from: fromAddress,
      }))
      return
    }
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const parsed = await parseIncomingEmail(await new Response(message.raw).arrayBuffer(), id, now)
    const subject = parsed.subject || message.headers.get('subject') || ''
    const code = extractEmailCode({
      subject,
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
    })
    const fromName = parseFromName(message.headers.get('from') ?? from)
    const statements = [
      env.DB.prepare(`
        INSERT INTO emails (
          id, mailbox, from_address, from_name, to_address, peer_address, subject,
          body_text, body_html, code, headers, metadata, message_id,
          has_attachments, attachment_count, attachment_names, attachment_search_text,
          raw_storage_key, direction, status, received_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbound', 'received', ?, ?)
      `).bind(
        id,
        mailbox,
        fromAddress,
        fromName,
        mailbox,
        fromAddress,
        subject,
        parsed.bodyText.slice(0, 50000),
        parsed.bodyHtml.slice(0, 100000),
        code,
        JSON.stringify(parsed.headers),
        JSON.stringify({}),
        parsed.messageId,
        parsed.attachmentCount > 0 ? 1 : 0,
        parsed.attachmentCount,
        parsed.attachmentNames,
        parsed.attachmentSearchText,
        null,
        now,
        now
      ),
      ...parsed.attachments.map((attachment) =>
        env.DB.prepare(`
          INSERT INTO attachments (
            id, email_id, filename, content_type, size_bytes,
            content_disposition, content_id, mime_part_index,
            text_content, text_extraction_status, storage_key, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          attachment.id,
          attachment.email_id,
          attachment.filename,
          attachment.content_type,
          attachment.size_bytes,
          attachment.content_disposition,
          attachment.content_id,
          attachment.mime_part_index,
          attachment.text_content,
          attachment.text_extraction_status,
          attachment.storage_key,
          attachment.created_at
        )
      ),
    ]

    await env.DB.batch(statements)
    await maybeUpsertDirectExternalEmailThreadFromInbound(env, {
      mailbox,
      fromAddress,
      subject,
      headers: parsed.headers,
      messageId: parsed.messageId,
      receivedAt: now,
    })
    const indexedGroupMessage = await maybeUpsertChatGroupMessageIndex(env, {
      emailId: id,
      mailbox,
      senderMailbox: fromAddress,
      senderName: fromName,
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      provider: null,
      receivedAt: now,
    })
    scheduleRealtimeNotifyForIncomingMailbox(env, ctx, {
      mailbox,
      senderMailbox: fromAddress,
      senderName: fromName,
      subject,
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      emailId: id,
      receivedAt: now,
      currentGroupMessage: indexedGroupMessage,
      source: 'email_inbound',
    })
  },
} satisfies ExportedHandler<Env>

// --- HTTP Handlers ---

async function handleGetCode(url: URL, env: Env, authorizedMailbox: string): Promise<Response> {
  const to = url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })
  if (normalizeMailbox(to) !== authorizedMailbox) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const timeoutSec = Math.min(parseInt(url.searchParams.get('timeout') ?? '30'), 55)
  const since = url.searchParams.get('since')
  const deadline = Date.now() + timeoutSec * 1000

  while (Date.now() < deadline) {
    let query = 'SELECT id, code, from_address, subject, body_text, body_html, received_at FROM emails WHERE mailbox = ?'
    const params: string[] = [authorizedMailbox]

    if (since) {
      query += ' AND received_at > ?'
      params.push(since)
    }

    query += ' ORDER BY received_at DESC LIMIT 50'

    const rows = await env.DB.prepare(query).bind(...params).all<{
      id: string
      code: string | null
      from_address: string
      subject: string
      body_text: string
      body_html: string
      received_at: string
    }>()

    for (const row of rows.results ?? []) {
      const resolvedCode = resolveEmailCode(row as Record<string, unknown>)
      if (!resolvedCode) continue

      return Response.json({
        id: (row as { id: string }).id,
        code: resolvedCode,
        from: (row as { from_address: string }).from_address,
        subject: (row as { subject: string }).subject,
        received_at: (row as { received_at: string }).received_at,
      })
    }

    await new Promise(r => setTimeout(r, 2000))
  }

  return Response.json({ code: null })
}

async function handleInbox(url: URL, env: Env, authorizedMailbox: string): Promise<Response> {
  const to = url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })
  if (normalizeMailbox(to) !== authorizedMailbox) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100)
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0
  const direction = url.searchParams.get('direction')
  const query = url.searchParams.get('query')?.trim()

  let sql = `
    SELECT id, mailbox, from_address, from_name, subject, body_text, body_html, code,
           direction, status, provider, received_at, has_attachments, attachment_count
    FROM emails WHERE mailbox = ?`
  const params: (string | number)[] = [authorizedMailbox]

  if (direction === 'inbound' || direction === 'outbound') {
    sql += ' AND direction = ?'
    params.push(direction)
  }

  if (query) {
    const pattern = `%${escapeLike(query)}%`
    sql += " AND (subject LIKE ? ESCAPE '\\' OR body_text LIKE ? ESCAPE '\\' OR from_address LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')"
    params.push(pattern, pattern, pattern, pattern, pattern)
  }

  sql += ' ORDER BY received_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = await env.DB.prepare(sql).bind(...params).all()

  return Response.json({
    emails: rows.results.map((row) => toInboxEmail(row as Record<string, unknown>)),
  })
}

async function handleConversations(url: URL, env: Env, authorizedMailbox: string): Promise<Response> {
  const to = url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })
  if (normalizeMailbox(to) !== authorizedMailbox) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100)
  const before = optionalIsoTime(url.searchParams.get('before'))
  const params: Array<string | number> = [authorizedMailbox]
  const beforeFilter = before ? ' AND e.received_at < ?' : ''

  if (before) {
    params.push(before)
  }

  const rows = await env.DB.prepare(`
    WITH latest_per_peer AS (
      SELECT
        peer_address,
        MAX(received_at) AS last_at
      FROM emails
      WHERE mailbox = ?
        AND peer_address IS NOT NULL
        AND peer_address != ''
        ${before ? 'AND received_at < ?' : ''}
      GROUP BY peer_address
    ), ranked AS (
      SELECT
        e.peer_address,
        e.id,
        e.direction,
        e.status,
        e.body_text,
        e.body_html,
        e.received_at,
        ROW_NUMBER() OVER (
          PARTITION BY e.peer_address
          ORDER BY e.received_at DESC, e.id DESC
        ) AS row_num
      FROM emails e
      INNER JOIN latest_per_peer latest
        ON latest.peer_address = e.peer_address
       AND latest.last_at = e.received_at
      WHERE e.mailbox = ?
        ${beforeFilter}
    )
    SELECT peer_address, id, direction, status, body_text, body_html, received_at
    FROM ranked
    WHERE row_num = 1
    ORDER BY received_at DESC, id DESC
    LIMIT ?
  `).bind(...params, authorizedMailbox, ...(before ? [before] : []), limit).all<ConversationSummaryRow>()

  return Response.json({
    conversations: (rows.results ?? []).map((row) => ({
      peer: row.peer_address,
      email: {
        id: row.id,
        direction: row.direction,
        status: row.status,
        body_text: row.body_text,
        body_html: row.body_html,
        received_at: row.received_at,
      },
    })),
    next_cursor: null,
  })
}

async function handleGetEmail(url: URL, env: Env, authorizedMailbox: string): Promise<Response> {
  const id = url.searchParams.get('id')
  if (!id) return Response.json({ error: 'Missing ?id= parameter' }, { status: 400 })

  let row = await env.DB.prepare('SELECT * FROM emails WHERE id = ? AND mailbox = ?').bind(id, authorizedMailbox).first<{
    id: string
    mailbox: string
    from_address: string
    from_name: string
    to_address: string
    subject: string
    body_text: string
    body_html: string
    code: string | null
    headers: string
    metadata: string
    direction: 'inbound' | 'outbound'
    status: 'received' | 'sent' | 'failed' | 'queued'
    provider: string | null
    message_id: string | null
    has_attachments: number
    attachment_count: number
    attachment_names: string
    attachment_search_text: string
    raw_storage_key: string | null
    received_at: string
    created_at: string
  }>()

  if (!row) {
    const safeId = id.replace(/%/g, '\\%').replace(/_/g, '\\_')
    const matches = await env.DB.prepare("SELECT * FROM emails WHERE id LIKE ? ESCAPE '\\' AND mailbox = ? ORDER BY received_at DESC LIMIT 2").bind(`${safeId}%`, authorizedMailbox).all<{
      id: string
      mailbox: string
      from_address: string
      from_name: string
      to_address: string
      subject: string
      body_text: string
      body_html: string
      code: string | null
      headers: string
      metadata: string
      direction: 'inbound' | 'outbound'
      status: 'received' | 'sent' | 'failed' | 'queued'
      provider: string | null
      message_id: string | null
      has_attachments: number
      attachment_count: number
      attachment_names: string
      attachment_search_text: string
      raw_storage_key: string | null
      received_at: string
      created_at: string
    }>()

    if ((matches.results?.length ?? 0) > 1) {
      return Response.json({ error: `Ambiguous email id: ${id}` }, { status: 409 })
    }

    row = matches.results?.[0] ?? null
  }

  if (!row) return Response.json({ error: 'Email not found' }, { status: 404 })

  const attachments = await env.DB.prepare(
    'SELECT * FROM attachments WHERE email_id = ? ORDER BY mime_part_index ASC'
  ).bind(row.id).all<{
    id: string
    email_id: string
    filename: string
    content_type: string
    size_bytes: number | null
    content_disposition: string | null
    content_id: string | null
    mime_part_index: number
    text_content: string
    text_extraction_status: string
    storage_key: string | null
    created_at: string
  }>()

  return Response.json(
    toDetailEmail(
      row as unknown as Record<string, unknown>,
      attachments.results as Record<string, unknown>[],
    ),
  )
}

async function handleSend(
  request: Request,
  env: Env,
  authorizedMailbox: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const body = await request.json() as {
    from?: string
    to?: string[]
    subject?: string
    text?: string
    html?: string
    reply_to?: string
    headers?: Record<string, string>
    skip_sender_realtime_ack?: boolean
    cc?: string[]
    bcc?: string[]
    attachments?: Array<{ filename: string; content: string; content_type?: string }>
  }

  if (!body.from || !body.to?.length || !body.subject) {
    return Response.json({ error: 'Missing required fields: from, to, subject' }, { status: 400 })
  }
  if (!body.text && !body.html) {
    return Response.json({ error: 'Either text or html is required' }, { status: 400 })
  }

  const senderMailbox = normalizeMailbox(body.from)
  const allowedSender = normalizeMailbox(authorizedMailbox)
  if (senderMailbox !== allowedSender) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const sendReq: SendRequest = {
    from: body.from,
    to: body.to,
    subject: body.subject,
    text: body.text,
    html: body.html,
    reply_to: body.reply_to,
    headers: body.headers,
    cc: body.cc,
    bcc: body.bcc,
    attachments: body.attachments,
  }

  const allRecipientFields = [
    ...(body.to ?? []),
    ...(body.cc ?? []),
    ...(body.bcc ?? []),
  ]
  const localDelivery = await classifyLocalRecipients(env, allRecipientFields)
  const deletedLocalRecipientSet = new Set(localDelivery.deletedLocalRecipients)
  const filteredTo = filterDeletedLocalRecipients(body.to ?? [], deletedLocalRecipientSet)
  const filteredCc = filterDeletedLocalRecipients(body.cc ?? [], deletedLocalRecipientSet)
  const filteredBcc = filterDeletedLocalRecipients(body.bcc ?? [], deletedLocalRecipientSet)
  const filteredRecipients = [
    ...filteredTo,
    ...filteredCc,
    ...filteredBcc,
  ]

  if (localDelivery.allAreLocalDomain && localDelivery.unresolvedLocalRecipients.length === 0) {
    const normalizedAuthorizedMailbox = normalizeMailbox(authorizedMailbox)
    const activeLocalRecipientSet = new Set(localDelivery.activeLocalRecipients)
    const localInboundRecipients = filteredRecipients
      .map(normalizeMailbox)
      .filter((recipient) => activeLocalRecipientSet.has(recipient) && recipient !== normalizedAuthorizedMailbox)
    const primaryRecipient = filteredTo.length === 1 && filteredCc.length === 0 && filteredBcc.length === 0
      ? normalizeMailbox(filteredTo[0] ?? '')
      : null
    const messageId = crypto.randomUUID()
    const senderName = parseFromName(body.from)
    const outboundReceivedAt = new Date().toISOString()
    await persistOutboundEmail(env, {
      id: messageId,
      mailbox: authorizedMailbox,
      fromAddress: senderMailbox,
      fromName: senderName,
      toAddress: body.to.join(', '),
      subject: body.subject,
      bodyText: body.text,
      bodyHtml: body.html,
      headers: body.headers,
      messageId: headerMessageID(body.headers),
      attachmentCount: body.attachments?.length ?? 0,
      provider: 'local',
      receivedAt: outboundReceivedAt,
    })

    if (localInboundRecipients.length > 0) {
      const persistedInboundEmails = await persistLocalInboundEmails(env, {
        recipients: localInboundRecipients,
        fromAddress: senderMailbox,
        fromName: senderName,
        subject: body.subject,
        bodyText: body.text,
        bodyHtml: body.html,
        replyTo: body.reply_to,
      })
      for (const email of persistedInboundEmails) {
        let indexedGroupMessage: IndexedGroupRealtimeMessageRef | null = null
        try {
          indexedGroupMessage = await maybeUpsertChatGroupMessageIndex(env, {
            emailId: email.id,
            mailbox: email.mailbox,
            senderMailbox,
            senderName,
            bodyText: body.text,
            bodyHtml: body.html,
            provider: 'local',
            receivedAt: email.receivedAt,
          })
        } catch (error) {
          console.warn(JSON.stringify({
            event: 'local_inbound_group_index_failed',
            source: 'mails-worker',
            mailbox: email.mailbox,
            sender_mailbox: senderMailbox,
            email_id: email.id,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
        scheduleRealtimeNotifyForIncomingMailbox(env, ctx, {
          mailbox: email.mailbox,
          senderMailbox,
          senderName,
          subject: body.subject,
          bodyText: body.text,
          bodyHtml: body.html,
          emailId: email.id,
          receivedAt: email.receivedAt,
          currentGroupMessage: indexedGroupMessage,
          source: 'local_inbound',
        })
      }
    }

    if (primaryRecipient && isRealtimeNotifyConfigured(env) && body.skip_sender_realtime_ack !== true) {
      try {
        const isDirectRecipient = await isDirectConversationRecipientMailbox(env, primaryRecipient)
        if (isDirectRecipient) {
          scheduleRealtimeNotifyForDirectOutboundSender(env, ctx, {
            senderMailbox,
            senderName,
            subject: body.subject,
            bodyText: body.text,
            bodyHtml: body.html,
            emailId: messageId,
            receivedAt: outboundReceivedAt,
            peerMailbox: primaryRecipient,
            source: 'send_direct_outbound',
            status: 'sent',
          })
        }
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'direct_outbound_realtime_prepare_failed',
          source: 'mails-worker',
          mailbox: normalizeMailbox(authorizedMailbox),
          peer: primaryRecipient,
          email_id: messageId,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }

    return Response.json({ id: messageId, from: body.from, provider: 'local' })
  }

  if (filteredRecipients.length === 0) {
    const messageId = crypto.randomUUID()
    const now = new Date().toISOString()
    await persistOutboundEmail(env, {
      id: messageId,
      mailbox: authorizedMailbox,
      fromAddress: senderMailbox,
      fromName: parseFromName(body.from),
      toAddress: body.to.join(', '),
      subject: body.subject,
      bodyText: body.text,
      bodyHtml: body.html,
      headers: body.headers,
      messageId: headerMessageID(body.headers),
      attachmentCount: body.attachments?.length ?? 0,
      provider: 'local',
      receivedAt: now,
    })
    return Response.json({ id: messageId, from: body.from, provider: 'local' })
  }

  const chain = buildProviderChain(env)
  if (chain.length === 0) {
    return Response.json({ error: 'No email provider configured' }, { status: 503 })
  }

  const filteredSendReq: SendRequest = {
    from: sendReq.from,
    to: filteredTo,
    subject: sendReq.subject,
    text: sendReq.text,
    html: sendReq.html,
    reply_to: sendReq.reply_to,
    headers: sendReq.headers,
    cc: filteredCc.length ? filteredCc : undefined,
    bcc: filteredBcc.length ? filteredBcc : undefined,
    attachments: sendReq.attachments,
  }

  let result: { id: string; provider: 'cloudflare' | 'resend' | 'ses' }
  try {
    result = await sendWithChain(chain, filteredSendReq)
  } catch (err) {
    if (err instanceof UnsupportedFeatureError) {
      return Response.json({ error: err.message }, { status: 400 })
    }
    if (err instanceof AllProvidersFailedError) {
      return Response.json({ error: err.message, attempts: err.attempts }, { status: 502 })
    }
    throw err
  }

  const now = new Date().toISOString()
  await persistOutboundEmail(env, {
    id: result.id,
    mailbox: authorizedMailbox,
    fromAddress: senderMailbox,
    fromName: parseFromName(body.from),
    toAddress: filteredTo.join(', '),
    subject: body.subject,
    bodyText: body.text,
    bodyHtml: body.html,
    headers: body.headers,
    messageId: headerMessageID(body.headers),
    attachmentCount: body.attachments?.length ?? 0,
    provider: result.provider,
    receivedAt: now,
  })

  const primaryRecipient = filteredTo.length === 1 ? normalizeMailbox(filteredTo[0] ?? '') : null
  if (primaryRecipient && isRealtimeNotifyConfigured(env) && body.skip_sender_realtime_ack !== true) {
    try {
      const isDirectRecipient = await isDirectConversationRecipientMailbox(env, primaryRecipient)
      if (isDirectRecipient) {
        scheduleRealtimeNotifyForDirectOutboundSender(env, ctx, {
          senderMailbox,
          senderName: parseFromName(body.from),
          subject: body.subject,
          bodyText: body.text,
          bodyHtml: body.html,
          emailId: result.id,
          receivedAt: now,
          peerMailbox: primaryRecipient,
          source: 'send_direct_outbound',
          status: 'sent',
        })
      }
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'direct_outbound_realtime_prepare_failed',
        source: 'mails-worker',
        mailbox: normalizeMailbox(authorizedMailbox),
        peer: primaryRecipient,
        email_id: result.id,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  return Response.json({ id: result.id, from: body.from, provider: result.provider })
}

async function classifyLocalRecipients(env: Env, recipients: string[]): Promise<LocalDeliveryClassification> {
  const normalizedRecipients = recipients.map(normalizeMailbox)
  const localDomain = getLocalDomain(env)
  if (!localDomain || normalizedRecipients.length === 0) {
    return {
      activeLocalRecipients: [],
      deletedLocalRecipients: [],
      unresolvedLocalRecipients: [],
      allAreLocalDomain: false,
      hasExternalRecipients: normalizedRecipients.length > 0,
    }
  }

  const localDomainRecipients = normalizedRecipients.filter((recipient) => recipient.endsWith(`@${localDomain}`))
  const hasExternalRecipients = localDomainRecipients.length !== normalizedRecipients.length
  if (localDomainRecipients.length === 0) {
    return {
      activeLocalRecipients: [],
      deletedLocalRecipients: [],
      unresolvedLocalRecipients: [],
      allAreLocalDomain: false,
      hasExternalRecipients,
    }
  }

  const placeholders = localDomainRecipients.map(() => '?').join(', ')
  const rows = await env.DB.prepare(`
    SELECT mailbox FROM users WHERE mailbox IN (${placeholders}) AND status = 'active'
  `).bind(...localDomainRecipients).all<{ mailbox: string }>()

  const matched = new Set((rows.results ?? []).map((row) => normalizeMailbox(row.mailbox)))
  const deleted = new Set(await listDeletedMailboxes(env, localDomainRecipients))
  const unresolved = localDomainRecipients.filter((recipient) => !matched.has(recipient) && !deleted.has(recipient))

  return {
    activeLocalRecipients: [...matched],
    deletedLocalRecipients: [...deleted],
    unresolvedLocalRecipients: unresolved,
    allAreLocalDomain: !hasExternalRecipients,
    hasExternalRecipients,
  }
}

function filterDeletedLocalRecipients(recipients: string[], deletedMailboxes: Set<string>): string[] {
  return recipients.filter((recipient) => !deletedMailboxes.has(normalizeMailbox(recipient)))
}

async function persistLocalInboundEmails(
  env: Env,
  input: {
    recipients: string[]
    fromAddress: string
    fromName: string
    subject: string
    bodyText?: string
    bodyHtml?: string
    replyTo?: string
  },
): Promise<PersistedInboundEmailRef[]> {
  const now = new Date().toISOString()
  const persistedEmails = input.recipients.map((recipient) => ({
    id: crypto.randomUUID(),
    mailbox: recipient,
    receivedAt: now,
  }))
  const statements = persistedEmails.map((email) =>
    env.DB.prepare(`
      INSERT INTO emails (
        id, mailbox, from_address, from_name, to_address, peer_address, subject,
        body_text, body_html, code, headers, metadata, message_id,
        has_attachments, attachment_count, attachment_names, attachment_search_text,
        raw_storage_key, direction, status, provider, received_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '{}', NULL, 0, 0, '', '', NULL, 'inbound', 'received', 'local', ?, ?)
    `).bind(
      email.id,
      email.mailbox,
      input.fromAddress,
      input.fromName,
      email.mailbox,
      input.fromAddress,
      input.subject,
      (input.bodyText ?? '').slice(0, 50000),
      (input.bodyHtml ?? '').slice(0, 100000),
      JSON.stringify(buildLocalHeaders(input.fromAddress, input.replyTo)),
      email.receivedAt,
      email.receivedAt,
    )
  )

  await env.DB.batch(statements)
  return persistedEmails
}

async function persistOutboundEmail(
  env: Env,
  input: {
    id: string
    mailbox: string
    fromAddress: string
    fromName: string
    toAddress: string
    subject: string
    bodyText?: string
    bodyHtml?: string
    headers?: Record<string, string>
    messageId?: string | null
    attachmentCount: number
    provider: 'cloudflare' | 'resend' | 'ses' | 'local'
    receivedAt: string
  },
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO emails (
      id, mailbox, from_address, from_name, to_address, peer_address, subject,
      body_text, body_html, code, headers, metadata, message_id,
      has_attachments, attachment_count, attachment_names, attachment_search_text,
      raw_storage_key, direction, status, provider, received_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '{}', ?, ?, ?, '', '', NULL, 'outbound', 'sent', ?, ?, ?)
  `).bind(
    input.id,
    input.mailbox,
    input.fromAddress,
    input.fromName,
    input.toAddress,
    normalizeSingleRecipient(input.toAddress),
    input.subject,
    (input.bodyText ?? '').slice(0, 50000),
    (input.bodyHtml ?? '').slice(0, 100000),
    JSON.stringify(input.headers ?? {}),
    input.messageId ?? null,
    input.attachmentCount > 0 ? 1 : 0,
    input.attachmentCount,
    input.provider,
    input.receivedAt,
    input.receivedAt,
  ).run()
}

function headerMessageID(headers?: Record<string, string>): string | null {
  if (!headers) return null
  for (const [key, value] of Object.entries(headers)) {
    if (key.trim().toLowerCase() === 'message-id') {
      const trimmed = value.trim()
      return trimmed || null
    }
  }
  return null
}

function buildLocalHeaders(fromAddress: string, replyTo?: string): Record<string, string> {
  const headers: Record<string, string> = {
    from: fromAddress,
  }

  if (replyTo) {
    headers['reply-to'] = replyTo
  }

  return headers
}

async function maybeUpsertChatGroupMessageIndex(
  env: Env,
  input: {
    emailId: string
    mailbox: string
    senderMailbox: string
    senderName: string
    bodyText?: string
    bodyHtml?: string
    provider: string | null
    receivedAt: string
  },
): Promise<IndexedGroupRealtimeMessageRef | null> {
  const group = await getActiveChatGroupByMailbox(env, input.mailbox)
  if (!group) return null

  const normalizedSenderMailbox = normalizeMailbox(input.senderMailbox)
  const projection = buildRealtimeMessageProjection(input.bodyText, input.bodyHtml)
  const member = await getActiveChatGroupMemberForIndex(env, group.id, normalizedSenderMailbox)
  if (member) {
    const senderEmail = member.member_mailbox
    const senderName = nonEmptyTrimmed(member.display_name) ?? nonEmptyTrimmed(input.senderName)
    await upsertChatGroupMessageIndex(env, {
      groupId: group.id,
      groupMailbox: group.mailbox,
      emailId: input.emailId,
      senderEmail,
      senderName,
      senderSource: 'internal',
      text: projection.text,
      renderText: projection.renderText,
      provider: input.provider,
      receivedAt: input.receivedAt,
    })
    return {
      groupId: group.id,
      groupMailbox: group.mailbox,
      syncMode: group.sync_mode,
      emailId: input.emailId,
      senderEmail,
      senderName,
      receivedAt: input.receivedAt,
    }
  }

  const externalMember = await getActiveChatGroupExternalMemberForIndex(env, group.id, normalizedSenderMailbox)
  if (!externalMember) return null

  const senderEmail = externalMember.email
  const senderName = nonEmptyTrimmed(externalMember.display_name) ?? nonEmptyTrimmed(input.senderName)
  await upsertChatGroupMessageIndex(env, {
    groupId: group.id,
    groupMailbox: group.mailbox,
    emailId: input.emailId,
    senderEmail,
    senderName,
    senderSource: 'external',
    text: projection.text,
    renderText: projection.renderText,
    provider: input.provider,
    receivedAt: input.receivedAt,
  })
  return {
    groupId: group.id,
    groupMailbox: group.mailbox,
    syncMode: group.sync_mode,
    emailId: input.emailId,
    senderEmail,
    senderName,
    receivedAt: input.receivedAt,
  }
}

function indexedChatMessageText(bodyText?: string, bodyHtml?: string): string {
  return buildRealtimeMessageProjection(bodyText, bodyHtml).text
}

function nonEmptyTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

async function upsertChatGroupMessageIndex(
  env: Env,
  input: {
    groupId: string
    groupMailbox: string
    emailId: string
    senderEmail: string
    senderName: string | null
    senderSource: 'internal' | 'external'
    text: string
    renderText: string | null
    provider: string | null
    receivedAt: string
  },
): Promise<void> {
  const nowIso = new Date().toISOString()
  await env.DB.prepare(`
    INSERT INTO chat_group_message_index (
      id, group_id, group_mailbox, email_id, sender_email, sender_name,
      sender_source, text, render_text, provider, received_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id, email_id) DO UPDATE SET
      sender_email = excluded.sender_email,
      sender_name = excluded.sender_name,
      sender_source = excluded.sender_source,
      text = excluded.text,
      render_text = excluded.render_text,
      provider = excluded.provider,
      received_at = excluded.received_at
  `).bind(
    crypto.randomUUID(),
    input.groupId,
    input.groupMailbox,
    input.emailId,
    input.senderEmail,
    input.senderName,
    input.senderSource,
    input.text,
    input.renderText,
    input.provider,
    input.receivedAt,
    nowIso,
  ).run()
}

function getLocalDomain(env: Env): string | null {
  const mailbox = env.OUTBOUND_FROM_EMAIL?.trim().toLowerCase() ?? env.MAILBOX?.trim().toLowerCase() ?? ''
  const domain = mailbox.split('@')[1] ?? ''
  return domain || null
}

async function handleDeleteMailbox(env: Env, mailbox: string): Promise<Response> {
  const deleted = await deleteMailbox(env, mailbox, {
    reason: 'account_delete',
    createdBy: 'internal_api',
  })
  return Response.json({ ok: true, deleted })
}

async function deleteMailbox(
  env: Env,
  mailbox: string,
  input: { reason: string; createdBy: string },
): Promise<{ emails: number; attachments: number }> {
  const normalizedMailbox = normalizeMailbox(mailbox)
  const deletedAt = new Date().toISOString()
  const attachmentsCount = await countRows(
    env,
    'SELECT COUNT(*) as count FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE mailbox = ?)',
    normalizedMailbox,
  )
  const emailsCount = await countRows(
    env,
    'SELECT COUNT(*) as count FROM emails WHERE mailbox = ?',
    normalizedMailbox,
  )

  await env.DB.prepare(`
    INSERT INTO deleted_mailboxes (mailbox, deleted_at, reason, created_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(mailbox) DO UPDATE SET
      deleted_at = excluded.deleted_at,
      reason = excluded.reason,
      created_by = excluded.created_by
  `).bind(
    normalizedMailbox,
    deletedAt,
    input.reason,
    input.createdBy,
  ).run()

  await runOptionalDelete(
    env,
    'DELETE FROM chat_group_message_index WHERE email_id IN (SELECT id FROM emails WHERE mailbox = ?)',
    normalizedMailbox,
  )
  await env.DB.prepare(
    'DELETE FROM attachments WHERE email_id IN (SELECT id FROM emails WHERE mailbox = ?)'
  ).bind(normalizedMailbox).run()
  await env.DB.prepare(
    'DELETE FROM emails WHERE mailbox = ?'
  ).bind(normalizedMailbox).run()

  return {
    emails: emailsCount,
    attachments: attachmentsCount,
  }
}

async function countRows(env: Env, sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...params).first<{ count: number | null }>()
  return Number(row?.count ?? 0)
}

async function runOptionalDelete(env: Env, sql: string, ...params: unknown[]): Promise<void> {
  try {
    await env.DB.prepare(sql).bind(...params).run()
  } catch (error) {
    if (isMissingTableError(error)) {
      return
    }
    throw error
  }
}

async function isDeletedMailbox(env: Env, mailbox: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT mailbox
    FROM deleted_mailboxes
    WHERE mailbox = ?
    LIMIT 1
  `).bind(normalizeMailbox(mailbox)).first<{ mailbox: string }>()
  return Boolean(row?.mailbox)
}

async function listDeletedMailboxes(env: Env, mailboxes: string[]): Promise<string[]> {
  const normalizedMailboxes = [...new Set(mailboxes.map(normalizeMailbox))]
  if (normalizedMailboxes.length === 0) {
    return []
  }
  const placeholders = normalizedMailboxes.map(() => '?').join(', ')
  const rows = await env.DB.prepare(`
    SELECT mailbox
    FROM deleted_mailboxes
    WHERE mailbox IN (${placeholders})
  `).bind(...normalizedMailboxes).all<{ mailbox: string }>()
  return (rows.results ?? []).map((row) => normalizeMailbox(row.mailbox))
}

async function handleSync(url: URL, env: Env, authorizedMailbox: string): Promise<Response> {
  const to = url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })
  if (normalizeMailbox(to) !== authorizedMailbox) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const since = url.searchParams.get('since') || '1970-01-01T00:00:00Z'
  const peer = optionalPeer(url.searchParams.get('peer'))
  const before = optionalIsoTime(url.searchParams.get('before'))
  const sinceId = optionalCursorId(url.searchParams.get('since_id'))
  const beforeId = optionalCursorId(url.searchParams.get('before_id'))
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 500)
  const offset = parseInt(url.searchParams.get('offset') ?? '0')
  const direction = url.searchParams.get('direction')

  const whereParts = ['mailbox = ?']
  const params: Array<string | number> = [authorizedMailbox]

  if (sinceId) {
    whereParts.push('(received_at > ? OR (received_at = ? AND id > ?))')
    params.push(since, since, sinceId)
  } else {
    whereParts.push('received_at > ?')
    params.push(since)
  }

  if (peer) {
    whereParts.push(`(
      peer_address = ?
      OR (peer_address IS NULL AND direction = 'inbound' AND lower(trim(from_address)) = ?)
      OR (peer_address IS NULL AND direction = 'outbound' AND instr(to_address, ',') = 0 AND lower(trim(to_address)) = ?)
    )`)
    params.push(peer, peer, peer)
  }

  if (direction === 'inbound' || direction === 'outbound') {
    whereParts.push('direction = ?')
    params.push(direction)
  }

  if (before) {
    if (peer && beforeId) {
      whereParts.push('(received_at < ? OR (received_at = ? AND id < ?))')
      params.push(before, before, beforeId)
    } else {
      whereParts.push('received_at < ?')
      params.push(before)
    }
  }

  const whereClause = whereParts.join(' AND ')

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM emails WHERE ${whereClause}`
  ).bind(...params).first<{ total: number }>()
  const total = countRow?.total ?? 0

  const orderBy = peer
    ? 'received_at DESC, id DESC'
    : 'received_at ASC, id ASC'

  const rows = await env.DB.prepare(`
    SELECT * FROM emails
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all()

  const emails = []
  for (const row of rows.results) {
    const r = row as Record<string, unknown>
    const attachments = await env.DB.prepare(
      'SELECT * FROM attachments WHERE email_id = ? ORDER BY mime_part_index ASC'
    ).bind(r.id).all()

    emails.push(toDetailEmail(r, attachments.results as Record<string, unknown>[]))
  }

  return Response.json({
    emails,
    total,
    has_more: offset + limit < total,
  })
}

async function handleLatestInboundThread(url: URL, env: Env, authorizedMailbox: string): Promise<Response> {
  const to = url.searchParams.get('to')
  if (!to) return Response.json({ error: 'Missing ?to= parameter' }, { status: 400 })
  if (normalizeMailbox(to) !== authorizedMailbox) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const peer = optionalPeer(url.searchParams.get('peer'))
  if (!peer) {
    return Response.json({ error: 'Missing ?peer= parameter' }, { status: 400 })
  }

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '3'), 20)
  const rows = await env.DB.prepare(`
    SELECT
      id,
      mailbox,
      from_address,
      from_name,
      to_address,
      peer_address,
      subject,
      headers,
      message_id,
      direction,
      status,
      provider,
      received_at
    FROM emails
    WHERE mailbox = ?
      AND direction = 'inbound'
      AND (
        peer_address = ?
        OR (peer_address IS NULL AND lower(trim(from_address)) = ?)
      )
      AND message_id IS NOT NULL
      AND trim(message_id) != ''
    ORDER BY received_at DESC, id DESC
    LIMIT ?
  `).bind(authorizedMailbox, peer, peer, limit).all()

  const emails = (rows.results ?? []).map((row) => {
    const record = row as Record<string, unknown>
    return {
      id: record.id as string,
      mailbox: record.mailbox as string,
      from_address: record.from_address as string,
      from_name: (record.from_name as string) ?? '',
      to_address: record.to_address as string,
      subject: (record.subject as string) ?? '',
      headers: safeJsonParse(record.headers as string, {}),
      message_id: record.message_id as string,
      direction: record.direction as string,
      status: record.status as string,
      provider: (record.provider as string | null) ?? null,
      received_at: record.received_at as string,
    }
  })

  return Response.json({ emails })
}

async function maybeUpsertDirectExternalEmailThreadFromInbound(
  env: Env,
  input: {
    mailbox: string
    fromAddress: string
    subject: string
    headers: Record<string, string>
    messageId: string | null
    receivedAt: string
  },
): Promise<void> {
  const ownerMailbox = normalizeMailbox(input.mailbox)
  const peerEmail = normalizeMailbox(input.fromAddress)
  const inboundMessageID = normalizeMessageID(input.messageId)
  if (!ownerMailbox || !peerEmail || !inboundMessageID) {
    return
  }

  const localDomain = getLocalDomain(env)
  if (!localDomain) {
    return
  }
  if (peerEmail.endsWith(`@${localDomain}`)) {
    return
  }

  if (!(await isDirectConversationRecipientMailbox(env, ownerMailbox))) {
    return
  }

  const existingRows = (await env.DB.prepare(`
    SELECT id, owner_mailbox, peer_email, topic_key, topic_label, anchor_message_id, references_chain, reply_subject, created_at, updated_at
    FROM direct_external_email_threads
    WHERE owner_mailbox = ? AND peer_email = ?
    ORDER BY updated_at DESC, id DESC
  `).bind(ownerMailbox, peerEmail).all<DirectExternalEmailThreadRow>()).results ?? []

  const normalizedReplySubject = normalizeReplySubject(input.subject)
  const selectedThread = selectDirectExternalThreadForInbound(existingRows, {
    inboundMessageID,
    headers: input.headers,
  })
  const existingAnchor = normalizeMessageID(selectedThread?.anchor_message_id ?? null)
  if (existingAnchor === inboundMessageID || isMessageIDInReferencesChain(inboundMessageID, selectedThread?.references_chain ?? '')) {
    if (selectedThread && normalizedReplySubject && normalizedReplySubject !== (selectedThread.reply_subject ?? null)) {
      await env.DB.prepare(`
        UPDATE direct_external_email_threads
        SET reply_subject = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        normalizedReplySubject,
        input.receivedAt,
        selectedThread.id,
      ).run()
    }
    return
  }

  const inboundReferencesChain = appendMessageIDToReferencesChain(buildNormalizedInboundReferencesChain(
    selectedThread?.references_chain ?? '',
    selectedThread?.anchor_message_id ?? '',
    input.headers,
  ), inboundMessageID)
  const topicLabel = deriveTopicLabelFromReplySubject(normalizedReplySubject)
  const topicKey = selectedThread?.topic_key
    ?? normalizeTopicKey(topicLabel)

  if (selectedThread) {
    await env.DB.prepare(`
      UPDATE direct_external_email_threads
      SET anchor_message_id = ?, references_chain = ?, reply_subject = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      inboundMessageID,
      inboundReferencesChain,
      normalizedReplySubject,
      input.receivedAt,
      selectedThread.id,
    ).run()
    return
  }

  await env.DB.prepare(`
    INSERT INTO direct_external_email_threads (
      id, owner_mailbox, peer_email, topic_key, topic_label, anchor_message_id, references_chain, reply_subject, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    ownerMailbox,
    peerEmail,
    topicKey,
    topicLabel,
    inboundMessageID,
    inboundReferencesChain,
    normalizedReplySubject,
    input.receivedAt,
    input.receivedAt,
  ).run()
}

function toInboxEmail(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    mailbox: row.mailbox as string,
    from_address: row.from_address as string,
    from_name: (row.from_name as string) ?? '',
    subject: (row.subject as string) ?? '',
    code: resolveEmailCode(row),
    direction: row.direction as string,
    status: row.status as string,
    provider: (row.provider as string | null) ?? null,
    received_at: row.received_at as string,
    has_attachments: Boolean(row.has_attachments),
    attachment_count: Number(row.attachment_count ?? 0),
  }
}

function toDetailEmail(row: Record<string, unknown>, attachments: Record<string, unknown>[]) {
  return {
    id: row.id as string,
    mailbox: row.mailbox as string,
    from_address: row.from_address as string,
    from_name: (row.from_name as string) ?? '',
    to_address: row.to_address as string,
    subject: (row.subject as string) ?? '',
    body_text: (row.body_text as string) ?? '',
    body_html: (row.body_html as string) ?? '',
    code: resolveEmailCode(row),
    headers: safeJsonParse(row.headers as string, {}),
    metadata: safeJsonParse(row.metadata as string, {}),
    direction: row.direction as string,
    status: row.status as string,
    provider: (row.provider as string | null) ?? null,
    message_id: (row.message_id as string) ?? null,
    has_attachments: Boolean(row.has_attachments),
    attachment_count: Number(row.attachment_count ?? 0),
    attachment_names: (row.attachment_names as string) ?? '',
    attachment_search_text: (row.attachment_search_text as string) ?? '',
    raw_storage_key: (row.raw_storage_key as string) ?? null,
    received_at: row.received_at as string,
    created_at: row.created_at as string,
    attachments: attachments.map(toAttachmentRecord),
  }
}

function toAttachmentRecord(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    email_id: row.email_id as string,
    filename: row.filename as string,
    content_type: row.content_type as string,
    size_bytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    content_disposition: (row.content_disposition as string) ?? null,
    content_id: (row.content_id as string) ?? null,
    mime_part_index: Number(row.mime_part_index),
    text_content: (row.text_content as string) ?? '',
    text_extraction_status: row.text_extraction_status as string,
    storage_key: (row.storage_key as string) ?? null,
    downloadable: Boolean(row.storage_key),
    created_at: row.created_at as string,
  }
}

function resolveEmailCode(row: Record<string, unknown>): string | null {
  return extractEmailCode({
    subject: (row.subject as string) ?? '',
    bodyText: (row.body_text as string) ?? '',
    bodyHtml: (row.body_html as string) ?? '',
    storedCode: (row.code as string | null) ?? null,
  })
}

function parseFromName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</)
  return match ? match[1]!.trim() : ''
}

function optionalPeer(value: string | null): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return normalizeMailbox(trimmed)
}

function optionalIsoTime(value: string | null): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed
}

function optionalCursorId(value: string | null): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed
}

function normalizeMailbox(value: string): string {
  const match = value.match(/<([^>]+)>/)
  const mailbox = (match?.[1] ?? value).trim().toLowerCase()
  return mailbox
}

function normalizeSingleRecipient(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes(',')) {
    return null
  }
  return normalizeMailbox(trimmed)
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function normalizeReplySubject(subject: string | null | undefined): string | null {
  const normalized = (subject ?? '').replace(/[\r\n]+/g, ' ').trim()
  return normalized || null
}

function stripReplySubjectPrefix(subject: string | null | undefined): string | null {
  const normalized = normalizeReplySubject(subject)
  if (!normalized) return null
  return normalized.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim() || normalized
}

function deriveExternalDirectTopicLabel(env: Env, peer: string, subject: string | null | undefined): string | null {
  const localDomain = getLocalDomain(env)
  if (!localDomain) return null
  if (normalizeMailbox(peer).endsWith(`@${localDomain}`)) {
    return null
  }
  return deriveTopicLabelFromReplySubject(subject)
}

function deriveTopicLabelFromReplySubject(subject: string | null | undefined): string | null {
  return stripReplySubjectPrefix(subject)
}

function normalizeTopicKey(value: string | null | undefined): string {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'default'
}

function selectDirectExternalThreadForInbound(
  rows: DirectExternalEmailThreadRow[],
  input: {
    inboundMessageID: string
    headers: Record<string, string>
  },
): DirectExternalEmailThreadRow | null {
  if (rows.length === 0) {
    return null
  }

  const inboundTokens = parseMessageIDList(normalizeReferencesChain([
    getHeaderValueCaseInsensitive(input.headers, 'References'),
    getHeaderValueCaseInsensitive(input.headers, 'In-Reply-To'),
    input.inboundMessageID,
  ].join(' ')))
  const inboundSet = new Set(inboundTokens)

  const ancestryMatch = rows.find((row) => {
    const rowTokens = parseMessageIDList(buildReferencesHeader(row.references_chain, row.anchor_message_id))
    if (rowTokens.length === 0 || inboundTokens.length === 0) {
      return false
    }
    return rowTokens.some((token) => inboundSet.has(token))
  })
  if (ancestryMatch) {
    return ancestryMatch
  }
  return null
}

function getHeaderValueCaseInsensitive(headers: Record<string, string>, name: string): string {
  const target = name.trim().toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.trim().toLowerCase() === target) {
      return value
    }
  }
  return ''
}

function buildNormalizedInboundReferencesChain(
  existingReferencesChain: string,
  existingAnchorMessageID: string,
  headers: Record<string, string>,
): string {
  const localTokens = parseMessageIDList(buildReferencesHeader(existingReferencesChain, existingAnchorMessageID))
  const referencesTokens = parseMessageIDList(getHeaderValueCaseInsensitive(headers, 'References'))
  const inReplyToTokens = parseMessageIDList(getHeaderValueCaseInsensitive(headers, 'In-Reply-To'))
  const headerTokens = parseMessageIDList(normalizeReferencesChain([
    ...referencesTokens,
    ...inReplyToTokens,
  ].join(' ')))

  if (!hasMessageIDOverlap(localTokens, headerTokens)) {
    return normalizeReferencesChain(headerTokens.join(' '))
  }

  return normalizeReferencesChain(mergeOrderedMessageIDLists(localTokens, headerTokens).join(' '))
}

function hasMessageIDOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false
  }
  const leftSet = new Set(left)
  return right.some((token) => leftSet.has(token))
}

function mergeOrderedMessageIDLists(primary: string[], secondary: string[]): string[] {
  const nodes = Array.from(new Set([...primary, ...secondary]))
  if (nodes.length <= 1) {
    return nodes
  }

  const primaryPosition = new Map<string, number>()
  const secondaryPosition = new Map<string, number>()
  primary.forEach((token, index) => {
    if (!primaryPosition.has(token)) primaryPosition.set(token, index)
  })
  secondary.forEach((token, index) => {
    if (!secondaryPosition.has(token)) secondaryPosition.set(token, index)
  })

  const adjacency = new Map<string, Set<string>>()
  const indegree = new Map<string, number>()
  for (const token of nodes) {
    adjacency.set(token, new Set())
    indegree.set(token, 0)
  }

  function addSequenceEdges(sequence: string[]) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const from = sequence[index]
      const to = sequence[index + 1]
      if (from === to) continue
      const neighbors = adjacency.get(from)
      if (!neighbors || neighbors.has(to)) continue
      neighbors.add(to)
      indegree.set(to, (indegree.get(to) ?? 0) + 1)
    }
  }

  addSequenceEdges(primary)
  addSequenceEdges(secondary)

  const remaining = new Set(nodes)
  const ordered: string[] = []

  while (remaining.size > 0) {
    const available = [...remaining]
      .filter((token) => (indegree.get(token) ?? 0) === 0)
      .sort((left, right) => compareMessageIDMergePriority(
        left,
        right,
        primaryPosition,
        secondaryPosition,
      ))

    const next = available[0]
      ?? [...remaining].sort((left, right) => compareMessageIDMergePriority(
        left,
        right,
        primaryPosition,
        secondaryPosition,
      ))[0]
    if (!next) break

    ordered.push(next)
    remaining.delete(next)
    for (const neighbor of adjacency.get(next) ?? []) {
      indegree.set(neighbor, Math.max(0, (indegree.get(neighbor) ?? 0) - 1))
    }
  }

  return ordered
}

function compareMessageIDMergePriority(
  left: string,
  right: string,
  primaryPosition: Map<string, number>,
  secondaryPosition: Map<string, number>,
): number {
  const leftSecondary = secondaryPosition.get(left) ?? Number.POSITIVE_INFINITY
  const rightSecondary = secondaryPosition.get(right) ?? Number.POSITIVE_INFINITY
  if (leftSecondary !== rightSecondary) {
    return leftSecondary - rightSecondary
  }

  const leftPrimary = primaryPosition.get(left) ?? Number.POSITIVE_INFINITY
  const rightPrimary = primaryPosition.get(right) ?? Number.POSITIVE_INFINITY
  if (leftPrimary !== rightPrimary) {
    return leftPrimary - rightPrimary
  }

  return left.localeCompare(right)
}

const DIRECT_EXTERNAL_THREAD_REFERENCE_LIMIT = 20
const DIRECT_EXTERNAL_THREAD_REFERENCE_MAX_BYTES = 4096
const MESSAGE_ID_PATTERN = /<[^<>\r\n]+>/g
const BARE_MESSAGE_ID_CANDIDATE_PATTERN = /[^\s<>,;]+@[^\s<>,;]+/g
const BARE_MESSAGE_ID_PATTERN = /^[^<>\s@]+@[^<>\s@]+$/

function buildReferencesHeader(referencesChain: string, anchorMessageID: string): string {
  const normalizedAnchorMessageID = normalizeMessageID(anchorMessageID)
  return normalizeReferencesChain([
    ...parseMessageIDList(referencesChain),
    ...(normalizedAnchorMessageID ? [normalizedAnchorMessageID] : []),
  ].join(' '))
}

function appendMessageIDToReferencesChain(referencesChain: string, messageID: string): string {
  const normalizedMessageID = normalizeMessageID(messageID)
  if (!normalizedMessageID) return normalizeReferencesChain(referencesChain)
  return normalizeReferencesChain([...parseMessageIDList(referencesChain), normalizedMessageID].join(' '))
}

function isMessageIDInReferencesChain(messageID: string, referencesChain: string): boolean {
  const normalized = normalizeMessageID(messageID)
  if (!normalized) return false
  return parseMessageIDList(referencesChain).includes(normalized)
}

function normalizeReferencesChain(value: string): string {
  const tokens = parseMessageIDList(value)
  if (tokens.length === 0) return ''

  const deduped: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    deduped.push(token)
  }

  let trimmed = trimReferencesChainPreservingRoot(deduped)
  while (trimmed.length > 0 && new TextEncoder().encode(trimmed.join(' ')).byteLength > DIRECT_EXTERNAL_THREAD_REFERENCE_MAX_BYTES) {
    if (trimmed.length === 1) break
    trimmed = [trimmed[0], ...trimmed.slice(2)]
  }
  return trimmed.join(' ')
}

function trimReferencesChainPreservingRoot(tokens: string[]): string[] {
  if (tokens.length <= DIRECT_EXTERNAL_THREAD_REFERENCE_LIMIT) {
    return tokens
  }
  return [
    tokens[0],
    ...tokens.slice(-(DIRECT_EXTERNAL_THREAD_REFERENCE_LIMIT - 1)),
  ]
}

function parseMessageIDList(value: string | null | undefined): string[] {
  if (!value) return []
  const bracketedTokens = value.match(MESSAGE_ID_PATTERN) ?? []
  if (bracketedTokens.length > 0) return bracketedTokens

  return (value.match(BARE_MESSAGE_ID_CANDIDATE_PATTERN) ?? [])
    .map((token) => normalizeMessageID(token))
    .filter((token): token is string => Boolean(token))
}

function normalizeMessageID(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const bracketedTokens = trimmed.match(MESSAGE_ID_PATTERN)
  if (bracketedTokens && bracketedTokens.length > 0) {
    return bracketedTokens[0] ?? null
  }
  if (BARE_MESSAGE_ID_PATTERN.test(trimmed)) {
    return `<${trimmed}>`
  }
  return null
}

function isRealtimeNotifyConfigured(env: Env): boolean {
  return Boolean(env.REALTIME_NOTIFY_BASE_URL?.trim() && env.REALTIME_INTERNAL_TOKEN?.trim())
}

function scheduleRealtimeNotifyForIncomingMailboxes(
  env: Env,
  ctx: ExecutionContext | undefined,
  input: {
    mailboxes: string[]
    senderMailbox: string
    senderName?: string | null
    bodyText?: string
    bodyHtml?: string
    emailId?: string
    receivedAt?: string
    currentGroupMessage?: IndexedGroupRealtimeMessageRef | null
    source: string
  },
): void {
  const uniqueMailboxes = [...new Set(input.mailboxes.map(normalizeMailbox))]
  for (const mailbox of uniqueMailboxes) {
    scheduleRealtimeNotifyForIncomingMailbox(env, ctx, {
      mailbox,
      senderMailbox: input.senderMailbox,
      senderName: input.senderName,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
      emailId: input.emailId,
      receivedAt: input.receivedAt,
      currentGroupMessage: input.currentGroupMessage,
      source: input.source,
    })
  }
}

function scheduleRealtimeNotifyForIncomingMailbox(
  env: Env,
  ctx: ExecutionContext | undefined,
  input: {
    mailbox: string
    senderMailbox: string
    senderName?: string | null
    subject?: string | null
    bodyText?: string
    bodyHtml?: string
    emailId?: string
    receivedAt?: string
    currentGroupMessage?: IndexedGroupRealtimeMessageRef | null
    source: string
  },
): void {
  if (!isRealtimeNotifyConfigured(env)) {
    return
  }

  runBackground(ctx, (async () => {
    try {
      const events = await resolveRealtimeEventsForIncomingMailbox(env, {
        mailbox: input.mailbox,
        senderMailbox: input.senderMailbox,
        senderName: input.senderName,
        subject: input.subject,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml,
        emailId: input.emailId,
        receivedAt: input.receivedAt,
        currentGroupMessage: input.currentGroupMessage,
        source: input.source,
      })
      await sendRealtimeNotifyEvents(env, events)
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'realtime_notify_failed',
        source: 'mails-worker',
        trigger_source: input.source,
        mailbox: normalizeMailbox(input.mailbox),
        sender_mailbox: normalizeMailbox(input.senderMailbox),
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  })())
}

function scheduleRealtimeNotifyForDirectOutboundSender(
  env: Env,
  ctx: ExecutionContext | undefined,
  input: {
    senderMailbox: string
    senderName?: string | null
    subject?: string | null
    bodyText?: string
    bodyHtml?: string
    emailId?: string
    receivedAt?: string
    peerMailbox: string
    source: string
    status?: 'sent' | 'failed'
  },
): void {
  if (!isRealtimeNotifyConfigured(env)) {
    return
  }

  runBackground(ctx, (async () => {
    try {
      const event = await resolveRealtimeEventForDirectOutboundSender(env, input)
      if (!event) return
      await sendRealtimeNotifyEvent(env, event)
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'realtime_notify_failed',
        source: 'mails-worker',
        trigger_source: input.source,
        mailbox: normalizeMailbox(input.senderMailbox),
        peer: normalizeMailbox(input.peerMailbox),
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  })())
}

async function sendRealtimeNotifyEvent(env: Env, event: RealtimeNotifyEvent): Promise<void> {
  const result = await sendRealtimeNotifyEvents(env, [event])
  if (!result.ok) {
    console.warn(JSON.stringify({
      event: 'realtime_notify_failed',
      source: 'mails-worker',
      trigger_source: event.source,
      target_user_id: event.targetUserId,
      mailbox: event.mailbox,
      scope: event.scope,
      peer: event.peer,
      direction: event.direction,
      status: result.status,
    }))
    return
  }
}

async function sendRealtimeNotifyEvents(
  env: Env,
  events: RealtimeNotifyEvent[],
): Promise<{ ok: boolean; status: number }> {
  if (events.length === 0) {
    return { ok: true, status: 200 }
  }

  if (events.length === 1) {
    const event = events[0]!
    const envelope = buildRealtimeNotifyEnvelope(event)
    const response = await fetch(new URL('/internal/notify', env.REALTIME_NOTIFY_BASE_URL), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.REALTIME_INTERNAL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(envelope),
    })

    if (!response.ok) {
      return { ok: false, status: response.status }
    }

    console.log(JSON.stringify({
      event: 'realtime_notify_sent',
      source: 'mails-worker',
      trigger_source: event.source,
      event_id: envelope.event_id,
      type: envelope.type,
      target_user_id: event.targetUserId,
      mailbox: event.mailbox,
      scope: event.scope,
      peer: event.peer,
      direction: event.direction,
    }))
    return { ok: true, status: response.status }
  }

  const envelopes = events.map(buildRealtimeNotifyEnvelope)
  const response = await fetch(new URL('/internal/notify-batch', env.REALTIME_NOTIFY_BASE_URL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.REALTIME_INTERNAL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ events: envelopes }),
  })

  if (!response.ok) {
    return { ok: false, status: response.status }
  }

  console.log(JSON.stringify({
    event: 'realtime_notify_batch_sent',
    source: 'mails-worker',
    trigger_source: events[0]!.source,
    event_count: envelopes.length,
    mailbox: events[0]!.mailbox,
    scope: events[0]!.scope,
    peer: events[0]!.peer,
  }))
  return { ok: true, status: response.status }
}

function buildRealtimeNotifyEnvelope(event: RealtimeNotifyEvent) {
  if (event.conversation) {
    return {
      v: 1 as const,
      type: 'conversation_updated' as const,
      event_id: crypto.randomUUID(),
      emitted_at: new Date().toISOString(),
      target: {
        user_id: event.targetUserId,
      },
      data: {
        peer: event.peer,
        conversation_type: event.conversationType ?? 'direct',
        group_mailbox: event.groupMailbox ?? null,
        sync_mode: event.syncMode ?? 'mail',
        conversation: event.conversation,
        ...(event.message ? { message: event.message } : {}),
        refresh_hint: {
          conversations: true,
          messages: false,
        },
      },
    }
  }
  const envelope = {
    v: 1 as const,
    type: 'conversations_dirty' as const,
    event_id: crypto.randomUUID(),
    emitted_at: new Date().toISOString(),
    target: {
      user_id: event.targetUserId,
    },
    data: {
      scope: event.scope,
      peer: event.peer,
      direction: event.direction,
    },
  }
  return envelope
}

async function resolveRealtimeEventsForIncomingMailbox(
  env: Env,
  input: {
    mailbox: string
    senderMailbox: string
    senderName?: string | null
    subject?: string | null
    bodyText?: string
    bodyHtml?: string
    emailId?: string
    receivedAt?: string
    currentGroupMessage?: IndexedGroupRealtimeMessageRef | null
    source: string
  },
): Promise<RealtimeNotifyEvent[]> {
  const normalizedMailbox = normalizeMailbox(input.mailbox)
  const normalizedSenderMailbox = normalizeMailbox(input.senderMailbox)
  const group = input.currentGroupMessage && normalizeMailbox(input.currentGroupMessage.groupMailbox) === normalizedMailbox
    ? {
        id: input.currentGroupMessage.groupId,
        mailbox: normalizeMailbox(input.currentGroupMessage.groupMailbox),
        sync_mode: input.currentGroupMessage.syncMode,
      }
    : await getActiveChatGroupByMailbox(env, normalizedMailbox)
  if (group) {
    const latestIndexedMessage = input.currentGroupMessage && input.currentGroupMessage.groupId === group.id
      ? null
      : await getLatestChatGroupMessageIndex(env, group.id)
    const members = await listActiveChatGroupRealtimeMembers(env, group.id)
    const uniqueMembers = new Map<string, string>()
    for (const member of members) {
      if (!member.user_id) continue
      uniqueMembers.set(member.user_id, normalizeMailbox(member.member_mailbox))
    }
    return [...uniqueMembers.entries()].map(([targetUserId, memberMailbox]) => ({
      targetUserId,
      mailbox: group.mailbox,
      source: input.source,
      scope: 'group' as const,
      peer: group.mailbox,
      direction: memberMailbox === normalizedSenderMailbox ? 'outbound' : 'inbound',
      conversationType: 'group',
      syncMode: group.sync_mode,
      groupMailbox: group.mailbox,
      ...(input.currentGroupMessage && input.emailId && input.receivedAt
        ? buildRealtimeGroupPayloadEventFieldsForInboundEmail({
            group,
            memberMailbox,
            emailId: input.currentGroupMessage.emailId,
            senderMailbox: input.currentGroupMessage.senderEmail,
            senderName: input.currentGroupMessage.senderName,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
            receivedAt: input.currentGroupMessage.receivedAt,
          })
        : latestIndexedMessage
        ? buildRealtimeGroupPayloadEventFields({
            group,
            memberMailbox,
            latestMessage: latestIndexedMessage,
          })
        : input.emailId && input.receivedAt
          ? buildRealtimeGroupPayloadEventFieldsForInboundEmail({
              group,
              memberMailbox,
              emailId: input.emailId,
              senderMailbox: normalizedSenderMailbox,
              senderName: nonEmptyTrimmed(input.senderName) ?? null,
              bodyText: input.bodyText,
              bodyHtml: input.bodyHtml,
              receivedAt: input.receivedAt,
            })
          : {}),
    }))
  }

  const directUserId = await findActiveDirectUserIdByMailbox(env, normalizedMailbox)
  if (!directUserId) {
    return []
  }

  if (input.emailId && input.receivedAt) {
    return [{
      targetUserId: directUserId,
      mailbox: normalizedMailbox,
      source: input.source,
      scope: 'direct',
      peer: normalizedSenderMailbox,
      direction: 'inbound',
      conversationType: 'direct',
      syncMode: 'mail',
      ...buildRealtimeDirectPayloadEventFieldsForInboundEmail({
        env,
        peer: normalizedSenderMailbox,
        emailId: input.emailId,
        subject: input.subject,
        senderName: nonEmptyTrimmed(input.senderName) ?? null,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml,
        receivedAt: input.receivedAt,
      }),
    }]
  }

  const latestEmail = await getLatestDirectConversationEmail(env, normalizedMailbox, normalizedSenderMailbox)
  const latestProjection = latestEmail
    ? buildRealtimeMessageProjection(latestEmail.body_text, latestEmail.body_html)
    : EMPTY_REALTIME_MESSAGE_PROJECTION
  const latestTopic = latestEmail
    ? deriveExternalDirectTopicLabel(env, normalizedSenderMailbox, latestEmail.subject)
    : null

  return [{
    targetUserId: directUserId,
    mailbox: normalizedMailbox,
    source: input.source,
    scope: 'direct',
    peer: normalizedSenderMailbox,
    direction: 'inbound',
    conversationType: 'direct',
    syncMode: 'mail',
    ...(latestEmail
      ? {
          conversation: {
            peer: normalizedSenderMailbox,
            conversation_type: 'direct',
            group_mailbox: null,
            sync_mode: 'mail',
            title: normalizedSenderMailbox,
            peer_display_name: null,
            peer_alias: null,
            last_message: latestProjection.text,
            ...(latestProjection.renderText ? { last_render_text: latestProjection.renderText } : {}),
            last_direction: 'inbound',
            last_at: latestEmail.received_at,
            last_sender_email: normalizedSenderMailbox,
            last_sender_name: latestEmail.from_name || null,
            unread_count: 0,
          } satisfies RealtimeConversationPayload,
          message: {
            id: latestEmail.id,
            peer: normalizedSenderMailbox,
            conversation_type: 'direct',
            group_mailbox: null,
            sync_mode: 'mail',
            ...(latestTopic ? { topic: latestTopic } : {}),
            direction: 'inbound',
            text: latestProjection.text,
            ...(latestProjection.renderText ? { render_text: latestProjection.renderText } : {}),
            sent_at: latestEmail.received_at,
            status: latestEmail.status === 'failed' ? 'failed' : 'received',
            sender_email: normalizedSenderMailbox,
            sender_name: latestEmail.from_name || null,
          } satisfies RealtimeMessagePayload,
        }
      : {}),
  }]
}

async function resolveRealtimeEventForDirectOutboundSender(
  env: Env,
  input: {
    senderMailbox: string
    senderName?: string | null
    subject?: string | null
    bodyText?: string
    bodyHtml?: string
    emailId?: string
    receivedAt?: string
    peerMailbox: string
    source: string
    status?: 'sent' | 'failed'
  },
): Promise<RealtimeNotifyEvent | null> {
  const normalizedSenderMailbox = normalizeMailbox(input.senderMailbox)
  const normalizedPeerMailbox = normalizeMailbox(input.peerMailbox)
  const senderUserId = await findActiveDirectUserIdByMailbox(env, normalizedSenderMailbox)
  if (!senderUserId) return null

  if (input.emailId && input.receivedAt) {
    return {
      targetUserId: senderUserId,
      mailbox: normalizedSenderMailbox,
      source: input.source,
      scope: 'direct',
      peer: normalizedPeerMailbox,
      direction: 'outbound',
      conversationType: 'direct',
      syncMode: 'mail',
      ...buildRealtimeDirectPayloadEventFieldsForOutboundEmail({
        env,
        peer: normalizedPeerMailbox,
        emailId: input.emailId,
        senderMailbox: normalizedSenderMailbox,
        senderName: nonEmptyTrimmed(input.senderName) ?? null,
        subject: input.subject,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml,
        receivedAt: input.receivedAt,
        status: input.status ?? 'sent',
      }),
    }
  }

  const latestEmail = await getLatestDirectConversationEmail(env, normalizedSenderMailbox, normalizedPeerMailbox)
  const latestProjection = latestEmail
    ? buildRealtimeMessageProjection(latestEmail.body_text, latestEmail.body_html)
    : EMPTY_REALTIME_MESSAGE_PROJECTION
  return {
    targetUserId: senderUserId,
    mailbox: normalizedSenderMailbox,
    source: input.source,
    scope: 'direct',
    peer: normalizedPeerMailbox,
    direction: 'outbound',
    conversationType: 'direct',
    syncMode: 'mail',
    ...(latestEmail ? {
      conversation: {
        peer: normalizedPeerMailbox,
        conversation_type: 'direct',
        group_mailbox: null,
        sync_mode: 'mail',
        title: normalizedPeerMailbox,
        peer_display_name: null,
        peer_alias: null,
        last_message: latestProjection.text,
        ...(latestProjection.renderText ? { last_render_text: latestProjection.renderText } : {}),
        last_direction: 'outbound',
        last_at: latestEmail.received_at,
        last_sender_email: normalizedSenderMailbox,
        last_sender_name: latestEmail.from_name || null,
        unread_count: 0,
      } satisfies RealtimeConversationPayload,
      message: {
        id: latestEmail.id,
        peer: normalizedPeerMailbox,
        conversation_type: 'direct',
        group_mailbox: null,
        sync_mode: 'mail',
        topic: deriveTopicLabelFromReplySubject(latestEmail.subject),
        direction: 'outbound',
        text: latestProjection.text,
        ...(latestProjection.renderText ? { render_text: latestProjection.renderText } : {}),
        sent_at: latestEmail.received_at,
        status: latestEmail.status === 'failed' ? 'failed' : 'sent',
        sender_email: normalizedSenderMailbox,
        sender_name: latestEmail.from_name || null,
      } satisfies RealtimeMessagePayload,
    } : {}),
  }
}

async function isDirectConversationRecipientMailbox(env: Env, mailbox: string): Promise<boolean> {
  const normalizedMailbox = normalizeMailbox(mailbox)
  if (!normalizedMailbox || !isValidEmail(normalizedMailbox)) {
    return false
  }
  const group = await getActiveChatGroupByMailbox(env, normalizedMailbox)
  return !group
}

async function getActiveChatGroupByMailbox(
  env: Env,
  mailbox: string,
): Promise<{ id: string; mailbox: string; sync_mode: 'mail' | 'fast_chat' } | null> {
  try {
    const group = await env.DB.prepare(`
      SELECT id, mailbox, sync_mode
      FROM chat_groups
      WHERE mailbox = ? AND status = 'active'
      LIMIT 1
    `).bind(normalizeMailbox(mailbox)).first<{ id: string; mailbox: string; sync_mode: 'mail' | 'fast_chat' }>()
    if (!group) return null
    return {
      id: group.id,
      mailbox: normalizeMailbox(group.mailbox),
      sync_mode: group.sync_mode,
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'realtime_notify_lookup_failed',
      source: 'mails-worker',
      mailbox: normalizeMailbox(mailbox),
      error: error instanceof Error ? error.message : String(error),
    }))
    return null
  }
}

async function getLatestChatGroupMessageIndex(
  env: Env,
  groupId: string,
): Promise<{
  email_id: string
  sender_email: string
  sender_name: string | null
  text: string
  render_text: string | null
  received_at: string
} | null> {
  try {
    const row = await env.DB.prepare(`
      SELECT email_id, sender_email, sender_name, text, render_text, received_at
      FROM chat_group_message_index
      WHERE group_id = ?
      ORDER BY received_at DESC, email_id DESC
      LIMIT 1
    `).bind(groupId).first<{
      email_id: string
      sender_email: string
      sender_name: string | null
      text: string
      render_text: string | null
      received_at: string
    }>()
    return row ?? null
  } catch {
    return null
  }
}

async function getLatestDirectConversationEmail(
  env: Env,
  mailbox: string,
  peer: string,
): Promise<{
  id: string
  from_name: string | null
  subject: string | null
  body_text: string
  body_html: string
  status: 'received' | 'sent' | 'failed' | 'queued'
  received_at: string
} | null> {
  try {
    const row = await env.DB.prepare(`
      SELECT id, from_name, subject, body_text, body_html, status, received_at
      FROM emails
      WHERE mailbox = ?
        AND (
          peer_address = ?
          OR (peer_address IS NULL AND direction = 'inbound' AND lower(trim(from_address)) = ?)
          OR (peer_address IS NULL AND direction = 'outbound' AND instr(to_address, ',') = 0 AND lower(trim(to_address)) = ?)
        )
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `).bind(mailbox, peer, peer, peer).first<{
      id: string
      from_name: string | null
      subject: string | null
      body_text: string
      body_html: string
      status: 'received' | 'sent' | 'failed' | 'queued'
      received_at: string
    }>()
    return row ?? null
  } catch {
    return null
  }
}

function extractRealtimeMessageText(bodyText: string | null | undefined, bodyHtml: string | null | undefined): string {
  return buildRealtimeMessageProjection(bodyText, bodyHtml).text
}

function buildRealtimeGroupPayloadEventFields(input: {
  group: { mailbox: string; sync_mode: 'mail' | 'fast_chat' }
  memberMailbox: string
  latestMessage: {
    email_id: string
    sender_email: string
    sender_name: string | null
    text: string
    render_text: string | null
    received_at: string
  }
}): Pick<RealtimeNotifyEvent, 'conversation' | 'message'> {
  const direction: RealtimeNotifyDirection =
    normalizeMailbox(input.memberMailbox) === normalizeMailbox(input.latestMessage.sender_email)
      ? 'outbound'
      : 'inbound'
  return {
    conversation: {
      peer: input.group.mailbox,
      conversation_type: 'group',
      group_mailbox: input.group.mailbox,
      sync_mode: input.group.sync_mode,
      title: input.group.mailbox,
      peer_display_name: input.group.mailbox,
      peer_alias: null,
      last_message: input.latestMessage.text,
      ...(input.latestMessage.render_text ? { last_render_text: input.latestMessage.render_text } : {}),
      last_direction: direction,
      last_at: input.latestMessage.received_at,
      last_sender_email: input.latestMessage.sender_email,
      last_sender_name: input.latestMessage.sender_name,
      unread_count: 0,
    },
    message: {
      id: input.latestMessage.email_id,
      peer: input.group.mailbox,
      conversation_type: 'group',
      group_mailbox: input.group.mailbox,
      sync_mode: input.group.sync_mode,
      direction,
      text: input.latestMessage.text,
      ...(input.latestMessage.render_text ? { render_text: input.latestMessage.render_text } : {}),
      sent_at: input.latestMessage.received_at,
      status: direction === 'outbound' ? 'sent' : 'received',
      sender_email: input.latestMessage.sender_email,
      sender_name: input.latestMessage.sender_name,
    },
  }
}

function buildRealtimeGroupPayloadEventFieldsForInboundEmail(input: {
  group: { mailbox: string; sync_mode: 'mail' | 'fast_chat' }
  memberMailbox: string
  emailId: string
  senderMailbox: string
  senderName: string | null
  bodyText?: string
  bodyHtml?: string
  receivedAt: string
}): Pick<RealtimeNotifyEvent, 'conversation' | 'message'> {
  const direction: RealtimeNotifyDirection =
    normalizeMailbox(input.memberMailbox) === normalizeMailbox(input.senderMailbox)
      ? 'outbound'
      : 'inbound'
  const projection = buildRealtimeMessageProjection(input.bodyText, input.bodyHtml)
  const senderMailbox = normalizeMailbox(input.senderMailbox)

  return {
    conversation: {
      peer: input.group.mailbox,
      conversation_type: 'group',
      group_mailbox: input.group.mailbox,
      sync_mode: input.group.sync_mode,
      title: input.group.mailbox,
      peer_display_name: input.group.mailbox,
      peer_alias: null,
      last_message: projection.text,
      ...(projection.renderText ? { last_render_text: projection.renderText } : {}),
      last_direction: direction,
      last_at: input.receivedAt,
      last_sender_email: senderMailbox,
      last_sender_name: input.senderName,
      unread_count: 0,
    },
    message: {
      id: input.emailId,
      peer: input.group.mailbox,
      conversation_type: 'group',
      group_mailbox: input.group.mailbox,
      sync_mode: input.group.sync_mode,
      direction,
      text: projection.text,
      ...(projection.renderText ? { render_text: projection.renderText } : {}),
      sent_at: input.receivedAt,
      status: direction === 'outbound' ? 'sent' : 'received',
      sender_email: senderMailbox,
      sender_name: input.senderName,
    },
  }
}

function buildRealtimeDirectPayloadEventFieldsForInboundEmail(input: {
  env: Env
  peer: string
  emailId: string
  subject?: string | null
  senderName: string | null
  bodyText?: string
  bodyHtml?: string
  receivedAt: string
}): Pick<RealtimeNotifyEvent, 'conversation' | 'message'> {
  const projection = buildRealtimeMessageProjection(input.bodyText, input.bodyHtml)
  const topic = deriveExternalDirectTopicLabel(input.env, input.peer, input.subject)

  return {
    conversation: {
      peer: input.peer,
      conversation_type: 'direct',
      group_mailbox: null,
      sync_mode: 'mail',
      title: input.peer,
      peer_display_name: null,
      peer_alias: null,
      last_message: projection.text,
      ...(projection.renderText ? { last_render_text: projection.renderText } : {}),
      last_direction: 'inbound',
      last_at: input.receivedAt,
      last_sender_email: input.peer,
      last_sender_name: input.senderName,
      unread_count: 0,
    },
    message: {
      id: input.emailId,
      peer: input.peer,
      conversation_type: 'direct',
      group_mailbox: null,
      sync_mode: 'mail',
      ...(topic ? { topic } : {}),
      direction: 'inbound',
      text: projection.text,
      ...(projection.renderText ? { render_text: projection.renderText } : {}),
      sent_at: input.receivedAt,
      status: 'received',
      sender_email: input.peer,
      sender_name: input.senderName,
    },
  }
}

function buildRealtimeDirectPayloadEventFieldsForOutboundEmail(input: {
  env: Env
  peer: string
  emailId: string
  senderMailbox: string
  senderName: string | null
  subject?: string | null
  bodyText?: string
  bodyHtml?: string
  receivedAt: string
  status: 'sent' | 'failed'
}): Pick<RealtimeNotifyEvent, 'conversation' | 'message'> {
  const projection = buildRealtimeMessageProjection(input.bodyText, input.bodyHtml)
  const topic = deriveExternalDirectTopicLabel(input.env, input.peer, input.subject)

  return {
    conversation: {
      peer: input.peer,
      conversation_type: 'direct',
      group_mailbox: null,
      sync_mode: 'mail',
      title: input.peer,
      peer_display_name: null,
      peer_alias: null,
      last_message: projection.text,
      ...(projection.renderText ? { last_render_text: projection.renderText } : {}),
      last_direction: 'outbound',
      last_at: input.receivedAt,
      last_sender_email: input.senderMailbox,
      last_sender_name: input.senderName,
      unread_count: 0,
    },
    message: {
      id: input.emailId,
      peer: input.peer,
      conversation_type: 'direct',
      group_mailbox: null,
      sync_mode: 'mail',
      ...(topic ? { topic } : {}),
      direction: 'outbound',
      text: projection.text,
      ...(projection.renderText ? { render_text: projection.renderText } : {}),
      sent_at: input.receivedAt,
      status: input.status,
      sender_email: input.senderMailbox,
      sender_name: input.senderName,
    },
  }
}

const EMPTY_REALTIME_MESSAGE_PROJECTION = {
  text: '',
  renderText: null,
}

function buildRealtimeMessageProjection(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): { text: string; renderText: string | null } {
  const normalizedBodyText = typeof bodyText === 'string' ? bodyText.slice(0, 50_000) : undefined
  const normalizedBodyHtml = typeof bodyHtml === 'string' ? bodyHtml.slice(0, 100_000) : undefined
  return buildMailChatProjection({
    bodyText: normalizedBodyText,
    bodyHTML: normalizedBodyHtml,
  })
}

async function listActiveChatGroupRealtimeMembers(
  env: Env,
  groupId: string,
): Promise<Array<{ user_id: string; member_mailbox: string }>> {
  try {
    const rows = await env.DB.prepare(`
      SELECT m.user_id, m.member_mailbox
      FROM chat_group_members m
      INNER JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ?
        AND m.status = 'active'
        AND u.status = 'active'
    `).bind(groupId).all<{ user_id: string; member_mailbox: string }>()
    return rows.results ?? []
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'realtime_notify_lookup_failed',
      source: 'mails-worker',
      group_id: groupId,
      error: error instanceof Error ? error.message : String(error),
    }))
    return []
  }
}

async function getActiveChatGroupMemberForIndex(
  env: Env,
  groupId: string,
  mailbox: string,
): Promise<{ member_mailbox: string; display_name: string | null } | null> {
  try {
    const row = await env.DB.prepare(`
      SELECT m.member_mailbox, u.display_name
      FROM chat_group_members m
      INNER JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ?
        AND m.member_mailbox = ?
        AND m.status = 'active'
        AND u.status = 'active'
      LIMIT 1
    `).bind(groupId, normalizeMailbox(mailbox)).first<{ member_mailbox: string; display_name: string | null }>()
    if (!row) return null
    return {
      member_mailbox: normalizeMailbox(row.member_mailbox),
      display_name: row.display_name ?? null,
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'chat_group_index_lookup_failed',
      source: 'mails-worker',
      group_id: groupId,
      mailbox: normalizeMailbox(mailbox),
      error: error instanceof Error ? error.message : String(error),
    }))
    return null
  }
}

async function getActiveChatGroupExternalMemberForIndex(
  env: Env,
  groupId: string,
  email: string,
): Promise<{ email: string; display_name: string | null } | null> {
  try {
    const row = await env.DB.prepare(`
      SELECT email, display_name
      FROM chat_group_external_members
      WHERE group_id = ?
        AND email = ?
        AND status = 'active'
      LIMIT 1
    `).bind(groupId, normalizeMailbox(email)).first<{ email: string; display_name: string | null }>()
    if (!row) return null
    return {
      email: normalizeMailbox(row.email),
      display_name: row.display_name ?? null,
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'chat_group_index_lookup_failed',
      source: 'mails-worker',
      group_id: groupId,
      mailbox: normalizeMailbox(email),
      error: error instanceof Error ? error.message : String(error),
    }))
    return null
  }
}

async function findActiveDirectUserIdByMailbox(env: Env, mailbox: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare(`
      SELECT u.id
      FROM users u
      LEFT JOIN chat_groups g
        ON g.service_user_id = u.id
       AND g.status = 'active'
      WHERE u.mailbox = ?
        AND u.status = 'active'
        AND g.id IS NULL
      LIMIT 1
    `).bind(normalizeMailbox(mailbox)).first<{ id: string }>()
    return row?.id ?? null
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'realtime_notify_lookup_failed',
      source: 'mails-worker',
      mailbox,
      error: error instanceof Error ? error.message : String(error),
    }))
    return null
  }
}

function runBackground(ctx: ExecutionContext | undefined, task: Promise<void>): void {
  if (ctx) {
    ctx.waitUntil(task)
    return
  }

  void task.catch((error) => {
    console.warn(JSON.stringify({
      event: 'background_task_failed',
      source: 'mails-worker',
      error: error instanceof Error ? error.message : String(error),
    }))
  })
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

function extractBearerValue(value: string | null): string | null {
  if (!value?.startsWith('Bearer ')) return null
  const token = value.slice(7).trim()
  return token || null
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)
  const length = Math.max(aBytes.length, bBytes.length)
  let diff = aBytes.length ^ bBytes.length

  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0)
  }

  return diff === 0
}

function isMissingTableError(error: unknown): boolean {
  return String(error).toLowerCase().includes('no such table')
}

async function hashCliToken(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`cli_token:${value}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return bytesToHex(new Uint8Array(digest))
}

function requireAccessTokenSecret(env: Env): string {
  const secret = env.ACCESS_TOKEN_SECRET?.trim()
  if (!secret) {
    throw new Error('ACCESS_TOKEN_SECRET is not configured')
  }
  return secret
}

async function verifyAccessToken(env: Env, token: string): Promise<AccessTokenClaims> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.')
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('invalid_access_token')
  }

  const expected = await hmacSha256(requireAccessTokenSecret(env), `${encodedHeader}.${encodedPayload}`)
  const actual = base64UrlDecodeToBytes(encodedSignature)
  if (!timingSafeEqualBytes(actual, expected)) {
    throw new Error('invalid_access_token')
  }

  let claims: AccessTokenClaims
  try {
    claims = JSON.parse(base64UrlDecode(encodedPayload)) as AccessTokenClaims
  } catch {
    throw new Error('invalid_access_token')
  }

  if (
    typeof claims.sub !== 'string' ||
    typeof claims.email !== 'string' ||
    typeof claims.mailbox !== 'string' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number'
  ) {
    throw new Error('invalid_access_token')
  }

  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('access_token_expired')
  }

  return claims
}

async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return new Uint8Array(signature)
}

function base64UrlDecode(value: string): string {
  return new TextDecoder().decode(base64UrlDecodeToBytes(value))
}

function base64UrlDecodeToBytes(value: string): Uint8Array {
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length)
  let diff = a.length ^ b.length

  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }

  return diff === 0
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function getMailboxTokens(
  env: Env,
): { tokens: Map<string, string> } | { missingConfig: true } | { response: Response } {
  const tokens = new Map<string, string>()

  if (env.AUTH_TOKENS_JSON) {
    try {
      const parsed = JSON.parse(env.AUTH_TOKENS_JSON) as Record<string, unknown>
      for (const [mailbox, token] of Object.entries(parsed)) {
        if (typeof token !== 'string' || !token.trim()) {
          return { response: Response.json({ error: 'AUTH_TOKENS_JSON is invalid' }, { status: 503 }) }
        }
        tokens.set(normalizeMailbox(mailbox), token)
      }
    } catch {
      return { response: Response.json({ error: 'AUTH_TOKENS_JSON is invalid' }, { status: 503 }) }
    }
  }

  if (env.AUTH_TOKEN) {
    if (!env.MAILBOX) {
      return { response: Response.json({ error: 'MAILBOX not configured' }, { status: 503 }) }
    }
    tokens.set(normalizeMailbox(env.MAILBOX), env.AUTH_TOKEN)
  }

  if (tokens.size === 0) {
    return { missingConfig: true }
  }

  return { tokens }
}

async function requirePublicAuthorizedMailbox(request: Request, env: Env): Promise<{ mailbox: string } | { response: Response }> {
  const token = extractBearerToken(request)
  if (!token) {
    return { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const configured = getMailboxTokens(env)
  if ('tokens' in configured) {
    let matchedMailbox: string | null = null
    for (const [mailbox, expectedToken] of configured.tokens) {
      if (timingSafeEqual(token, expectedToken)) {
        if (matchedMailbox) {
          return { response: Response.json({ error: 'Duplicate mailbox tokens are not allowed' }, { status: 503 }) }
        }
        matchedMailbox = mailbox
      }
    }

    if (matchedMailbox) {
      return { mailbox: matchedMailbox }
    }
  }

  const cliTokenMailbox = await findAuthorizedMailboxByCliToken(env, token)
  if (cliTokenMailbox) {
    return { mailbox: cliTokenMailbox }
  }

  if ('response' in configured) {
    return { response: configured.response }
  }
  if ('missingConfig' in configured) {
    return { response: Response.json({ error: 'AUTH_TOKEN not configured' }, { status: 503 }) }
  }

  return { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
}

async function requireInternalAuthorizedMailbox(request: Request, env: Env): Promise<{ mailbox: string } | { response: Response }> {
  const token = extractBearerToken(request)
  if (!token || !env.INTERNAL_API_TOKEN || !timingSafeEqual(token, env.INTERNAL_API_TOKEN)) {
    return { response: Response.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  const mailbox = normalizeMailbox(request.headers.get('X-Mailbox') ?? '')
  if (!mailbox || !isValidEmail(mailbox)) {
    return { response: Response.json({ error: 'X-Mailbox is required' }, { status: 400 }) }
  }

  const internalReadResponse = await authorizeInternalReadMailbox(request, env, mailbox)
  if (internalReadResponse) {
    return { response: internalReadResponse }
  }

  return { mailbox }
}

async function authorizeInternalReadMailbox(request: Request, env: Env, mailbox: string): Promise<Response | null> {
  const pathname = new URL(request.url).pathname
  if (!isInternalReadMailboxPath(pathname)) {
    return null
  }

  if (isChatGroupCommandMailbox(mailbox)) {
    return null
  }

  const directUserId = await findActiveDirectUserIdByMailbox(env, mailbox)
  if (!directUserId) {
    return null
  }

  const userToken = extractBearerValue(request.headers.get('X-User-Authorization'))
  if (!userToken) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const claims = await verifyAccessToken(env, userToken)
    if (claims.sub !== directUserId || normalizeMailbox(claims.mailbox) !== mailbox) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
  } catch {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  return null
}

function isInternalReadMailboxPath(pathname: string): boolean {
  return pathname === '/internal/inbox'
    || pathname === '/internal/code'
    || pathname === '/internal/email'
    || pathname === '/internal/conversations'
    || pathname === '/internal/thread-latest-inbound'
    || pathname === '/internal/sync'
}

function isChatGroupCommandMailbox(mailbox: string): boolean {
  return normalizeMailbox(mailbox).startsWith('admin_command@')
}

async function findAuthorizedMailboxByCliToken(env: Env, token: string): Promise<string | null> {
  const tokenId = parseOpaqueTokenId(token)
  if (!tokenId) {
    return null
  }

  const row = await env.DB.prepare(`
    SELECT users.mailbox AS mailbox, cli_tokens.token_hash AS token_hash,
           cli_tokens.expires_at AS expires_at, cli_tokens.revoked_at AS revoked_at,
           users.status AS user_status
    FROM cli_tokens
    JOIN users ON users.id = cli_tokens.user_id
    WHERE cli_tokens.id = ?
    LIMIT 1
  `).bind(tokenId).first<CliTokenAuthRow>()

  if (!row) {
    return null
  }
  if (row.user_status !== 'active' || row.revoked_at) {
    return null
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return null
  }

  const expectedHash = await hashCliToken(token)
  if (!timingSafeEqual(expectedHash, row.token_hash)) {
    return null
  }

  await env.DB.prepare(`
    UPDATE cli_tokens
    SET last_used_at = ?
    WHERE id = ?
  `).bind(new Date().toISOString(), tokenId).run()

  return row.mailbox
}

function parseOpaqueTokenId(token: string): string | null {
  const id = token.split('.')[0]?.trim() ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return null
  }
  return id
}
