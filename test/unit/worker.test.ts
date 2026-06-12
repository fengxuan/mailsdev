import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { buildMailChatProjection } from '../../worker/src/mail-chat-projection'
import { parseIncomingEmail } from '../../worker/src/mime'
import type { Env } from '../../worker/src/index'
import worker from '../../worker/src/index'
import { createHmac } from 'node:crypto'

const DEFAULT_AUTH_TOKEN = 'unit_test_auth_token'

type DirectExternalEmailThreadRow = {
  id: string
  owner_mailbox: string
  peer_email: string
  topic_key?: string
  topic_label?: string | null
  anchor_message_id: string
  references_chain: string
  reply_subject?: string | null
  created_at: string
  updated_at: string
}

function singleMailboxEnv(
  mailbox: string,
  env: Omit<Env, 'AUTH_TOKEN' | 'MAILBOX'> & { AUTH_TOKEN?: string; MAILBOX?: string }
): Env {
  return {
    ...env,
    AUTH_TOKEN: env.AUTH_TOKEN ?? DEFAULT_AUTH_TOKEN,
    MAILBOX: env.MAILBOX ?? mailbox,
  }
}

function authedRequest(input: string, init: RequestInit = {}, token = DEFAULT_AUTH_TOKEN): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return new Request(input, { ...init, headers })
}

function createAccessToken(
  claims: { sub: string; email: string; mailbox: string; iat?: number; exp?: number },
  secret = 'test-auth-secret',
): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: claims.sub,
    email: claims.email,
    mailbox: claims.mailbox,
    iat: claims.iat ?? now,
    exp: claims.exp ?? now + 3600,
  }
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest()
    .toString('base64url')
  return `${encodedHeader}.${encodedPayload}.${signature}`
}

describe('worker: MIME parsing', () => {
  test('extracts body and text attachment metadata from multipart email', async () => {
    const attachment = Buffer.from('invoice number 42').toString('base64')
    const raw = [
      'From: "Sender" <sender@test.com>',
      'Subject: Invoice',
      'Message-ID: <msg-42@test.com>',
      'Content-Type: multipart/mixed; boundary="boundary"',
      '',
      '--boundary',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      'Email body',
      '--boundary',
      'Content-Type: text/plain; name="invoice.txt"',
      'Content-Disposition: attachment; filename="invoice.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      attachment,
      '--boundary--',
      '',
    ].join('\r\n')

    const parsed = await parseIncomingEmail(
      new TextEncoder().encode(raw).buffer,
      'email-1',
      '2026-03-18T00:00:00.000Z'
    )

    expect(parsed.subject).toBe('Invoice')
    expect(parsed.bodyText.trim()).toBe('Email body')
    expect(parsed.messageId).toContain('msg-42')
    expect(parsed.attachmentCount).toBe(1)
    expect(parsed.attachmentNames).toBe('invoice.txt')
    expect(parsed.attachmentSearchText).toContain('invoice number 42')
    expect(parsed.attachments[0]).toMatchObject({
      email_id: 'email-1',
      filename: 'invoice.txt',
      content_type: 'text/plain',
      content_disposition: 'attachment',
      text_extraction_status: 'done',
      text_content: 'invoice number 42',
      downloadable: false,
    })
  })

  test('marks unsupported binary attachments without failing the email parse', async () => {
    const pdf = Buffer.from('%PDF-1.4 fake').toString('base64')
    const raw = [
      'Subject: PDF',
      'Content-Type: multipart/mixed; boundary="boundary"',
      '',
      '--boundary',
      'Content-Type: text/plain',
      '',
      'Body',
      '--boundary',
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdf,
      '--boundary--',
      '',
    ].join('\r\n')

    const parsed = await parseIncomingEmail(
      new TextEncoder().encode(raw).buffer,
      'email-2',
      '2026-03-18T00:00:00.000Z'
    )

    expect(parsed.bodyText.trim()).toBe('Body')
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0]!.filename).toBe('invoice.pdf')
    expect(parsed.attachments[0]!.text_extraction_status).toBe('unsupported')
    expect(parsed.attachments[0]!.text_content).toBe('')
  })

  test('falls back to html content when text body is missing', async () => {
    const raw = [
      'Subject: OTP Code',
      'Content-Type: text/html; charset="utf-8"',
      '',
      '<p>OTP Code:<strong>114669</strong></p>',
      '',
    ].join('\r\n')

    const parsed = await parseIncomingEmail(
      new TextEncoder().encode(raw).buffer,
      'email-3',
      '2026-03-18T00:00:00.000Z'
    )

    expect(parsed.bodyHtml).toContain('<strong>114669</strong>')
    expect(parsed.bodyText).toContain('OTP Code:')
    expect(parsed.bodyText).toContain('114669')
  })
})

describe('worker: reply parsing projection', () => {
  test('strips French reply attribution using the library-backed parser', () => {
    const projection = buildMailChatProjection({
      bodyText: 'Bonjour\n\nLe 18 mai 2026 à 10:00, Alice <alice@example.com> a écrit :\n> Ancien message',
    })

    expect(projection.text).toBe('Bonjour')
  })

  test('keeps forwarded body intact when it contains quoted legacy context', () => {
    const projection = buildMailChatProjection({
      bodyText: 'FYI\n\nBegin forwarded message:\nFrom: Alice <alice@example.com>\nSubject: Reply thread\n\nOn Mon, Bob wrote:\n> Please keep this context.\n> It belongs to the forwarded email.',
    })

    expect(projection.text).toBe(
      'FYI\n\nOn Mon, Bob wrote:\n> Please keep this context.\n> It belongs to the forwarded email.'
    )
  })

  test('strips 163 attribution after html-ish markdown body text normalization', () => {
    const projection = buildMailChatProjection({
      bodyText:
        '&gt; ## This is a header.<br/>&gt;<br/>&gt; 1.   This is the first list item.<br/>&gt; 2.   This is the second list item.<br/>&gt;<br/>&gt; Here\'s some example code:<br/>&gt;<br/>&gt;     return shell_exec("echo $input | $markdown_script");\nAt 2026-05-17 23:54:18, xjfeng-kfsy@canyin.uk wrote:\n>Hello 2\n',
    })

    expect(projection.text).toBe(
      '> ## This is a header.\n>\n> 1. This is the first list item.\n> 2. This is the second list item.\n>\n> Here\'s some example code:\n>\n> return shell_exec("echo $input | $markdown_script");'
    )
  })
})

// --- POST /api/send tests ---

function createMockD1() {
  const boundValues: unknown[] = []
  const runMock = mock(() => Promise.resolve({ success: true }))
  const allMock = mock(() => Promise.resolve({ results: [] }))
  const firstMock = mock(() => Promise.resolve(null))
  const bindMock = mock((...args: unknown[]) => {
    boundValues.push(...args)
    return { run: runMock, all: allMock, first: firstMock }
  })
  const prepareMock = mock((_sql: string) => ({
    bind: bindMock,
  }))
  return {
    db: { prepare: prepareMock } as unknown as D1Database,
    prepareMock,
    bindMock,
    runMock,
    allMock,
    firstMock,
    boundValues,
  }
}

function decodeOutboundEmailInsertArgs(boundArgs: unknown[]) {
  return {
    id: String(boundArgs[0] ?? ''),
    mailbox: String(boundArgs[1] ?? ''),
    fromAddress: String(boundArgs[2] ?? ''),
    fromName: String(boundArgs[3] ?? ''),
    toAddress: String(boundArgs[4] ?? ''),
    peerAddress: String(boundArgs[5] ?? ''),
    subject: String(boundArgs[6] ?? ''),
    bodyText: String(boundArgs[7] ?? ''),
    bodyHtml: String(boundArgs[8] ?? ''),
    headers: String(boundArgs[9] ?? ''),
    messageId: boundArgs[10] === null ? null : String(boundArgs[10] ?? ''),
    hasAttachments: Number(boundArgs[11] ?? 0),
    attachmentCount: Number(boundArgs[12] ?? 0),
    provider: String(boundArgs[13] ?? ''),
  }
}

interface RealtimeRoutingFixtures {
  localUsers?: string[]
  deletedMailboxes?: string[]
  directUsersByMailbox?: Record<string, string>
  groupsByMailbox?: Record<string, { id: string; mailbox: string; sync_mode?: 'mail' | 'fast_chat' }>
  groupMembersByGroupID?: Record<string, Array<{ user_id: string; member_mailbox: string; display_name?: string | null }>>
  externalMembersByGroupID?: Record<string, Array<{ email: string; display_name?: string | null }>>
}

function createRealtimeRoutingMockD1(fixtures: RealtimeRoutingFixtures = {}) {
  const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase()
  const localUsers = new Set((fixtures.localUsers ?? []).map(normalize))
  const deletedMailboxes = new Set((fixtures.deletedMailboxes ?? []).map(normalize))
  const directUsersByMailbox = Object.fromEntries(
    Object.entries(fixtures.directUsersByMailbox ?? {}).map(([mailbox, userID]) => [normalize(mailbox), userID]),
  )
  const groupsByMailbox = Object.fromEntries(
    Object.entries(fixtures.groupsByMailbox ?? {}).map(([mailbox, group]) => [normalize(mailbox), group]),
  )
  const groupMembersByGroupID = fixtures.groupMembersByGroupID ?? {}
  const externalMembersByGroupID = fixtures.externalMembersByGroupID ?? {}
  const chatGroupMessageIndexRows: Array<Record<string, unknown>> = []
  const defaultResult = {
    run: async () => ({ success: true }),
    all: async () => ({ results: [] as Array<Record<string, unknown>> }),
    first: async () => null as Record<string, unknown> | null,
  }

  const prepareMock = mock((sql: string) => ({
    bind: (...args: unknown[]) => {
      if (sql.includes('SELECT mailbox FROM users WHERE mailbox IN')) {
        return {
          ...defaultResult,
          all: async () => ({
            results: args
              .map((arg) => normalize(arg))
              .filter((mailbox) => localUsers.has(mailbox))
              .map((mailbox) => ({ mailbox })),
          }),
        }
      }

      if (sql.includes('FROM deleted_mailboxes') && sql.includes('WHERE mailbox IN')) {
        return {
          ...defaultResult,
          all: async () => ({
            results: args
              .map((arg) => normalize(arg))
              .filter((mailbox) => deletedMailboxes.has(mailbox))
              .map((mailbox) => ({ mailbox })),
          }),
        }
      }

      if (sql.includes('FROM deleted_mailboxes') && sql.includes('WHERE mailbox = ?')) {
        return {
          ...defaultResult,
          first: async () => {
            const mailbox = normalize(args[0])
            return deletedMailboxes.has(mailbox) ? { mailbox } : null
          },
        }
      }

      if (sql.includes('FROM chat_groups') && sql.includes("WHERE mailbox = ? AND status = 'active'")) {
        return {
          ...defaultResult,
          first: async () => {
            const mailbox = normalize(args[0])
            const group = groupsByMailbox[mailbox]
            return group ? { id: group.id, mailbox: group.mailbox, sync_mode: group.sync_mode ?? 'mail' } : null
          },
        }
      }

      if (sql.includes('FROM chat_group_members m') && sql.includes('INNER JOIN users u')) {
        if (sql.includes('WHERE m.group_id = ?') && sql.includes('m.member_mailbox = ?')) {
          return {
            ...defaultResult,
            first: async () => {
              const groupID = String(args[0] ?? '')
              const mailbox = normalize(args[1])
              const member = (groupMembersByGroupID[groupID] ?? []).find((item) => normalize(item.member_mailbox) == mailbox)
              return member ? {
                member_mailbox: member.member_mailbox,
                display_name: member.display_name ?? null,
              } : null
            },
          }
        }
        return {
          ...defaultResult,
          all: async () => ({
            results: groupMembersByGroupID[String(args[0] ?? '')] ?? [],
          }),
        }
      }

      if (sql.includes('FROM chat_group_external_members')) {
        return {
          ...defaultResult,
          first: async () => {
            const groupID = String(args[0] ?? '')
            const email = normalize(args[1])
            const member = (externalMembersByGroupID[groupID] ?? []).find((item) => normalize(item.email) == email)
            return member ? {
              email: member.email,
              display_name: member.display_name ?? null,
            } : null
          },
        }
      }

      if (sql.includes('FROM users u') && sql.includes('LEFT JOIN chat_groups g')) {
        return {
          ...defaultResult,
          first: async () => {
            const mailbox = normalize(args[0])
            const userID = directUsersByMailbox[mailbox]
            return userID ? { id: userID } : null
          },
        }
      }

      if (sql.includes('INSERT INTO chat_group_message_index')) {
        return {
          ...defaultResult,
          run: async () => {
            chatGroupMessageIndexRows.push({
              id: String(args[0] ?? ''),
              group_id: String(args[1] ?? ''),
              group_mailbox: String(args[2] ?? ''),
              email_id: String(args[3] ?? ''),
              sender_email: String(args[4] ?? ''),
              sender_name: args[5] === null ? null : String(args[5] ?? ''),
              sender_source: String(args[6] ?? ''),
              text: String(args[7] ?? ''),
              render_text: args[8] === null ? null : String(args[8] ?? ''),
              provider: args[9] === null ? null : String(args[9] ?? ''),
              received_at: String(args[10] ?? ''),
              created_at: String(args[11] ?? ''),
            })
            return { success: true }
          },
        }
      }

      return defaultResult
    },
  }))

  const batchMock = mock(async (_statements: unknown[]) => [])
  return {
    db: {
      prepare: prepareMock,
      batch: batchMock,
    } as unknown as D1Database,
    prepareMock,
    batchMock,
    chatGroupMessageIndexRows,
  }
}

function createMailboxDeletionMockD1(options: {
  mailbox: string
  emailRows?: Array<{ id: string; mailbox: string }>
  attachmentRows?: Array<{ id: string; email_id: string }>
}) {
  const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase()
  const deletedMailboxes = new Set<string>()
  const emailRows = [...(options.emailRows ?? [])]
  const attachmentRows = [...(options.attachmentRows ?? [])]
  let deletedChatGroupIndexRuns = 0

  const prepareMock = mock((sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        if (sql.includes('INSERT INTO deleted_mailboxes')) {
          deletedMailboxes.add(normalize(args[0]))
          return { success: true }
        }
        if (sql.includes('DELETE FROM chat_group_message_index')) {
          deletedChatGroupIndexRuns += 1
          return { success: true }
        }
        if (sql.includes('DELETE FROM attachments WHERE email_id IN')) {
          const mailbox = normalize(args[0])
          const emailIDs = new Set(emailRows.filter((row) => normalize(row.mailbox) === mailbox).map((row) => row.id))
          for (let index = attachmentRows.length - 1; index >= 0; index -= 1) {
            if (emailIDs.has(String(attachmentRows[index]!.email_id))) {
              attachmentRows.splice(index, 1)
            }
          }
          return { success: true }
        }
        if (sql.includes('DELETE FROM emails WHERE mailbox = ?')) {
          const mailbox = normalize(args[0])
          for (let index = emailRows.length - 1; index >= 0; index -= 1) {
            if (normalize(emailRows[index]!.mailbox) === mailbox) {
              emailRows.splice(index, 1)
            }
          }
          return { success: true }
        }
        return { success: true }
      },
      all: async () => ({ results: [] as Array<Record<string, unknown>> }),
      first: async () => {
        if (sql.includes('SELECT COUNT(*) as count FROM attachments')) {
          const mailbox = normalize(args[0])
          const emailIDs = new Set(emailRows.filter((row) => normalize(row.mailbox) === mailbox).map((row) => row.id))
          return { count: attachmentRows.filter((row) => emailIDs.has(String(row.email_id))).length }
        }
        if (sql.includes('SELECT COUNT(*) as count FROM emails WHERE mailbox = ?')) {
          const mailbox = normalize(args[0])
          return { count: emailRows.filter((row) => normalize(row.mailbox) === mailbox).length }
        }
        if (sql.includes('FROM deleted_mailboxes') && sql.includes('WHERE mailbox = ?')) {
          const mailbox = normalize(args[0])
          return deletedMailboxes.has(mailbox) ? { mailbox } : null
        }
        return null
      },
    }),
  }))

  const batchMock = mock(async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())))
  return {
    db: {
      prepare: prepareMock,
      batch: batchMock,
    } as unknown as D1Database,
    prepareMock,
    batchMock,
    deletedMailboxes,
    emailRows,
    attachmentRows,
    getDeletedChatGroupIndexRuns() {
      return deletedChatGroupIndexRuns
    },
  }
}

function createExecutionContextHarness() {
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise)
    },
  } as unknown as ExecutionContext
  return {
    ctx,
    async flush() {
      await Promise.all(pending)
    },
  }
}

const SEND_BODY = {
  from: 'me@example.com',
  to: ['you@example.com'],
  subject: 'Hello',
  text: 'World',
}

describe('worker: POST /api/send', () => {
  const originalFetch = globalThis.fetch
  let fetchMock: ReturnType<typeof mock>

  beforeEach(() => {
    fetchMock = mock(() =>
      Promise.resolve(
        Response.json({ id: 'resend-id-123' }, { status: 200 })
      )
    )
    globalThis.fetch = fetchMock as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('sends email via Resend and records outbound', async () => {
    const { db, prepareMock, bindMock } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { id: string; from: string; provider: string }

    expect(response.status).toBe(200)
    expect(json.id).toBe('resend-id-123')
    expect(json.from).toBe('me@example.com')
    expect(json.provider).toBe('resend')

    // Verify Resend API was called correctly
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [resendUrl, resendInit] = (fetchMock as any).mock.calls[0]
    expect(resendUrl).toBe('https://api.resend.com/emails')
    expect(resendInit.method).toBe('POST')
    expect(resendInit.headers['Authorization']).toBe('Bearer re_test_key')
    const resendBody = JSON.parse(resendInit.body)
    expect(resendBody.from).toBe('me@example.com')
    expect(resendBody.to).toEqual(['you@example.com'])
    expect(resendBody.subject).toBe('Hello')
    expect(resendBody.text).toBe('World')

    // Verify D1 insert was called after the local-recipient and deleted-mailbox lookups
    expect(prepareMock).toHaveBeenCalledTimes(3)
    expect(bindMock).toHaveBeenCalledTimes(3)
    const outboundInsert = decodeOutboundEmailInsertArgs((bindMock as any).mock.calls.at(-1) ?? [])
    expect(outboundInsert.id).toBe('resend-id-123')
    expect(outboundInsert.mailbox).toBe('me@example.com')
    expect(outboundInsert.fromAddress).toBe('me@example.com')
    expect(outboundInsert.fromName).toBe('')
    expect(outboundInsert.toAddress).toBe('you@example.com')
    expect(outboundInsert.peerAddress).toBe('you@example.com')
    expect(outboundInsert.subject).toBe('Hello')
    expect(outboundInsert.bodyText).toBe('World')
    expect(outboundInsert.bodyHtml).toBe('')
    expect(outboundInsert.headers).toBe('{}')
    expect(outboundInsert.messageId).toBeNull()
    expect(outboundInsert.hasAttachments).toBe(0)
    expect(outboundInsert.attachmentCount).toBe(0)
    expect(outboundInsert.provider).toBe('resend')
  })

  test('returns 400 for missing fields', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    // Missing subject
    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'me@example.com', to: ['you@example.com'], text: 'hi' }),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(400)
    expect(json.error).toContain('Missing required fields')

    // Missing text and html
    const request2 = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'me@example.com', to: ['you@example.com'], subject: 'Hi' }),
    })

    const response2 = await worker.fetch(request2, env)
    const json2 = await response2.json() as { error: string }

    expect(response2.status).toBe(400)
    expect(json2.error).toContain('text or html')

    // Resend should not have been called
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('returns 503 when no provider configured', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db }) // no RESEND_API_KEY, no EMAIL binding

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(503)
    expect(json.error).toContain('No email provider configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('returns 503 when AUTH_TOKEN is not configured', async () => {
    const { db } = createMockD1()
    const env: Env = { DB: db, RESEND_API_KEY: 're_test_key', MAILBOX: 'me@example.com' }

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    }, 'unused-token')

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(503)
    expect(json.error).toBe('AUTH_TOKEN not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('requires auth when AUTH_TOKEN set', async () => {
    const { db } = createMockD1()
    const env: Env = { DB: db, RESEND_API_KEY: 're_test_key', AUTH_TOKEN: 'secret123', MAILBOX: 'me@example.com' }

    // No auth header
    const request = new Request('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(401)
    expect(json.error).toBe('Unauthorized')

    // With correct auth header
    const request2 = new Request('http://localhost/api/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer secret123',
      },
      body: JSON.stringify(SEND_BODY),
    })

    const response2 = await worker.fetch(request2, env)
    const json2 = await response2.json() as { id: string }

    expect(response2.status).toBe(200)
    expect(json2.id).toBe('resend-id-123')
  })

  test('sends email with attachments', async () => {
    const { db, bindMock } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    const bodyWithAttachments = {
      ...SEND_BODY,
      attachments: [
        { filename: 'report.pdf', content: 'base64data', content_type: 'application/pdf' },
        { filename: 'notes.txt', content: 'dGV4dA==' },
      ],
    }

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyWithAttachments),
    })

    const response = await worker.fetch(request, env)
    expect(response.status).toBe(200)

    // Verify Resend body includes attachments
    const [, resendInit] = (fetchMock as any).mock.calls[0]
    const resendBody = JSON.parse(resendInit.body)
    expect(resendBody.attachments).toHaveLength(2)
    expect(resendBody.attachments[0].filename).toBe('report.pdf')
    expect(resendBody.attachments[0].content_type).toBe('application/pdf')
    expect(resendBody.attachments[1].filename).toBe('notes.txt')
    expect(resendBody.attachments[1].content_type).toBeUndefined()

    // Verify D1 records has_attachments on the outbound insert
    const outboundInsert = decodeOutboundEmailInsertArgs((bindMock as any).mock.calls.at(-1) ?? [])
    expect(outboundInsert.hasAttachments).toBe(1)
    expect(outboundInsert.attachmentCount).toBe(2)
  })

  test('returns 502 when all providers fail', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json({ message: 'Invalid API key' }, { status: 403 }))
    ) as typeof fetch

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string; attempts: Array<{ provider: string; error: string }> }

    expect(response.status).toBe(502)
    expect(json.error).toContain('All providers failed')
    expect(json.attempts[0]?.provider).toBe('resend')
    expect(json.attempts[0]?.error).toContain('Invalid API key')
  })

  test('sends via SES when selected explicitly', async () => {
    const { db, bindMock } = createMockD1()
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      AWS_SES_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'secret',
      EMAIL_PROVIDERS: 'ses',
    })

    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json({ MessageId: 'ses-id-42' }, { status: 200 })),
    ) as typeof fetch

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { id: string; provider: string }

    expect(response.status).toBe(200)
    expect(json.id).toBe('ses-id-42')
    expect(json.provider).toBe('ses')

    const [sesUrl, sesInit] = (globalThis.fetch as any).mock.calls[0]
    expect(sesUrl).toBe('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails')
    expect(sesInit.headers.authorization).toContain('Credential=akid/')

    const outboundInsert = decodeOutboundEmailInsertArgs((bindMock as any).mock.calls.at(-1) ?? [])
    expect(outboundInsert.provider).toBe('ses')
  })

  test('falls back to Resend when SES fails', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      AWS_SES_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'secret',
      RESEND_API_KEY: 're_test_key',
      EMAIL_PROVIDERS: 'ses,resend',
    })

    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('amazonaws.com')) {
        return Promise.resolve(Response.json({ message: 'SignatureDoesNotMatch' }, { status: 403 }))
      }
      return Promise.resolve(Response.json({ id: 'resend-after-ses' }, { status: 200 }))
    }) as typeof fetch

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { provider: string; id: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('resend')
    expect(json.id).toBe('resend-after-ses')
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2)
  })

  test('falls back to Resend when SES does not support attachments', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      AWS_SES_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'secret',
      RESEND_API_KEY: 're_test_key',
      EMAIL_PROVIDERS: 'ses,resend',
    })

    const fetch = mock((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('amazonaws.com')) {
        return Promise.resolve(Response.json({ MessageId: 'unexpected-ses' }, { status: 200 }))
      }
      return Promise.resolve(Response.json({ id: 'resend-attachment' }, { status: 200 }))
    })
    globalThis.fetch = fetch as typeof globalThis.fetch

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...SEND_BODY,
        attachments: [{ filename: 'report.pdf', content: 'base64data', content_type: 'application/pdf' }],
      }),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { provider: string; id: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('resend')
    expect(json.id).toBe('resend-attachment')
    expect((fetch as any).mock.calls).toHaveLength(1)
    expect(String((fetch as any).mock.calls[0][0])).toBe('https://api.resend.com/emails')
  })

  test('sends via Cloudflare EMAIL binding when configured', async () => {
    const { db, bindMock } = createMockD1()
    const emailSend = mock(() => Promise.resolve({ messageId: 'cf-id-42' }))
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      EMAIL: { send: emailSend } as any,
      EMAIL_PROVIDERS: 'cloudflare',
    })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { id: string; provider: string }

    expect(response.status).toBe(200)
    expect(json.id).toBe('cf-id-42')
    expect(json.provider).toBe('cloudflare')
    expect(emailSend).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    const outboundInsert = decodeOutboundEmailInsertArgs((bindMock as any).mock.calls.at(-1) ?? [])
    expect(outboundInsert.provider).toBe('cloudflare')
  })

  test('Cloudflare provider handles attachments/cc/bcc natively', async () => {
    const { db } = createMockD1()
    const emailSend = mock(() => Promise.resolve({ messageId: 'cf-attach' }))
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      EMAIL: { send: emailSend } as any,
      RESEND_API_KEY: 're_test_key',
      EMAIL_PROVIDERS: 'cloudflare,resend',
    })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...SEND_BODY,
        cc: ['cc@x.com'],
        bcc: ['bcc@x.com'],
        attachments: [{ filename: 'r.pdf', content: 'base64data', content_type: 'application/pdf' }],
      }),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { provider: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('cloudflare')
    expect(emailSend).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    const [msg] = (emailSend as any).mock.calls[0]
    expect(msg.cc).toEqual(['cc@x.com'])
    expect(msg.bcc).toEqual(['bcc@x.com'])
    expect(msg.attachments[0].type).toBe('application/pdf')
    expect(msg.attachments[0].disposition).toBe('attachment')
  })

  test('falls back to Resend when Cloudflare binding throws', async () => {
    const { db } = createMockD1()
    const emailSend = mock(() => Promise.reject(new Error('cf binding down')))
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      EMAIL: { send: emailSend } as any,
      RESEND_API_KEY: 're_test_key',
      EMAIL_PROVIDERS: 'cloudflare,resend',
    })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { provider: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('resend')
    expect(emailSend).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('EMAIL_PROVIDERS=resend forces Resend even with EMAIL binding', async () => {
    const { db } = createMockD1()
    const emailSend = mock(() => Promise.resolve({ id: 'cf-id' }))
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      EMAIL: { send: emailSend } as any,
      RESEND_API_KEY: 're_test_key',
      EMAIL_PROVIDERS: 'resend',
    })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { provider: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('resend')
    expect(emailSend).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('local direct send emits inbound and outbound realtime conversation updates', async () => {
    const { db } = createRealtimeRoutingMockD1({
      localUsers: ['you@example.com'],
      directUsersByMailbox: {
        'me@example.com': 'user-me',
        'you@example.com': 'user-you',
      },
    })
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      OUTBOUND_FROM_EMAIL: 'chat@example.com',
      REALTIME_NOTIFY_BASE_URL: 'https://realtime.example.com',
      REALTIME_INTERNAL_TOKEN: 'rt-internal',
    })
    const realtimeNotifyBodies: Array<Record<string, any>> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://realtime.example.com/internal/notify') {
        realtimeNotifyBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url === 'https://realtime.example.com/internal/notify-batch') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        realtimeNotifyBodies.push(...(body.events ?? []))
        return new Response(JSON.stringify({ ok: true, count: (body.events ?? []).length }), { status: 200 })
      }
      throw new Error(`unexpected fetch url ${url}`)
    }) as typeof fetch

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })
    const harness = createExecutionContextHarness()
    const response = await worker.fetch(request, env, harness.ctx)
    await harness.flush()

    expect(response.status).toBe(200)
    expect(realtimeNotifyBodies).toHaveLength(2)
    const updateEvents = realtimeNotifyBodies.filter((body) => body.type === 'conversation_updated')
    expect(updateEvents).toHaveLength(2)
    const byTarget = Object.fromEntries(
      updateEvents.map((body) => [body.target.user_id as string, body]),
    )
    expect(byTarget['user-you']).toBeTruthy()
    expect(byTarget['user-you'].data).toMatchObject({
      peer: 'me@example.com',
      conversation_type: 'direct',
      group_mailbox: null,
      sync_mode: 'mail',
      conversation: {
        peer: 'me@example.com',
        conversation_type: 'direct',
        group_mailbox: null,
        sync_mode: 'mail',
        last_message: 'World',
        last_direction: 'inbound',
        last_sender_email: 'me@example.com',
        last_sender_name: null,
      },
      message: {
        peer: 'me@example.com',
        conversation_type: 'direct',
        group_mailbox: null,
        sync_mode: 'mail',
        direction: 'inbound',
        text: 'World',
        status: 'received',
        sender_email: 'me@example.com',
        sender_name: null,
      },
    })
    expect((byTarget['user-you'].data.message as Record<string, unknown>).topic).toBeUndefined()
    expect(byTarget['user-me']).toBeTruthy()
    expect(byTarget['user-me'].data).toMatchObject({
      peer: 'you@example.com',
      conversation_type: 'direct',
      group_mailbox: null,
      sync_mode: 'mail',
      conversation: {
        peer: 'you@example.com',
        conversation_type: 'direct',
        group_mailbox: null,
        sync_mode: 'mail',
        last_message: 'World',
        last_direction: 'outbound',
        last_sender_email: 'me@example.com',
        last_sender_name: null,
      },
      message: {
        peer: 'you@example.com',
        conversation_type: 'direct',
        group_mailbox: null,
        sync_mode: 'mail',
        direction: 'outbound',
        text: 'World',
        status: 'sent',
        sender_email: 'me@example.com',
        sender_name: null,
      },
    })
    expect((byTarget['user-me'].data.message as Record<string, unknown>).topic).toBeUndefined()
  })

  test('local direct send can skip outbound sender realtime ack', async () => {
    const { db } = createRealtimeRoutingMockD1({
      localUsers: ['you@example.com'],
      directUsersByMailbox: {
        'me@example.com': 'user-me',
        'you@example.com': 'user-you',
      },
    })
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      OUTBOUND_FROM_EMAIL: 'chat@example.com',
      REALTIME_NOTIFY_BASE_URL: 'https://realtime.example.com',
      REALTIME_INTERNAL_TOKEN: 'rt-internal',
    })
    const realtimeNotifyBodies: Array<Record<string, any>> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://realtime.example.com/internal/notify') {
        realtimeNotifyBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url === 'https://realtime.example.com/internal/notify-batch') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        realtimeNotifyBodies.push(...(body.events ?? []))
        return new Response(JSON.stringify({ ok: true, count: (body.events ?? []).length }), { status: 200 })
      }
      throw new Error(`unexpected fetch url ${url}`)
    }) as typeof fetch

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...SEND_BODY,
        skip_sender_realtime_ack: true,
      }),
    })
    const harness = createExecutionContextHarness()
    const response = await worker.fetch(request, env, harness.ctx)
    await harness.flush()

    expect(response.status).toBe(200)
    expect(realtimeNotifyBodies).toHaveLength(1)
    expect(realtimeNotifyBodies[0]?.type).toBe('conversation_updated')
    expect(realtimeNotifyBodies[0]?.target?.user_id).toBe('user-you')
    expect(realtimeNotifyBodies[0]?.data).toMatchObject({
      peer: 'me@example.com',
      conversation_type: 'direct',
      message: {
        direction: 'inbound',
        text: 'World',
        status: 'received',
      },
    })
  })

  test('mixed local to plus external bcc stays as one outbound email', async () => {
    const { db } = createRealtimeRoutingMockD1({
      localUsers: ['you@example.com'],
    })
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      RESEND_API_KEY: 're_test_key',
    })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...SEND_BODY,
        to: ['you@example.com'],
        bcc: ['friend@outside.com'],
      }),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { provider: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('resend')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [resendUrl, resendInit] = (fetchMock as any).mock.calls[0]
    expect(resendUrl).toBe('https://api.resend.com/emails')
    const resendBody = JSON.parse(resendInit.body)
    expect(resendBody.to).toEqual(['you@example.com'])
    expect(resendBody.bcc).toEqual(['friend@outside.com'])
  })

  test('all-local recipients across to cc bcc stay on local delivery path', async () => {
    const { db } = createRealtimeRoutingMockD1({
      localUsers: ['you@example.com', 'copy@example.com', 'hidden@example.com'],
    })
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      RESEND_API_KEY: 're_test_key',
    })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...SEND_BODY,
        to: ['you@example.com'],
        cc: ['copy@example.com'],
        bcc: ['hidden@example.com'],
      }),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { provider: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('local')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('local group send fans out realtime conversation updates to active group members', async () => {
    const { db, chatGroupMessageIndexRows } = createRealtimeRoutingMockD1({
      localUsers: ['group@example.com'],
      groupsByMailbox: {
        'group@example.com': { id: 'group-1', mailbox: 'group@example.com', sync_mode: 'mail' },
      },
      groupMembersByGroupID: {
        'group-1': [
          { user_id: 'user-me', member_mailbox: 'me@example.com', display_name: 'Me' },
          { user_id: 'user-member', member_mailbox: 'member@example.com', display_name: 'Member' },
        ],
      },
    })
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      OUTBOUND_FROM_EMAIL: 'chat@example.com',
      REALTIME_NOTIFY_BASE_URL: 'https://realtime.example.com',
      REALTIME_INTERNAL_TOKEN: 'rt-internal',
    })
    const realtimeNotifyBodies: Array<Record<string, any>> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://realtime.example.com/internal/notify-batch') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        realtimeNotifyBodies.push(...(body.events ?? []))
        return new Response(JSON.stringify({ ok: true, count: (body.events ?? []).length }), { status: 200 })
      }
      throw new Error(`unexpected fetch url ${url}`)
    }) as typeof fetch

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...SEND_BODY,
        to: ['group@example.com'],
      }),
    })
    const harness = createExecutionContextHarness()
    const response = await worker.fetch(request, env, harness.ctx)
    await harness.flush()

    expect(response.status).toBe(200)
    expect(realtimeNotifyBodies).toHaveLength(2)
    const updateEvents = realtimeNotifyBodies.filter((body) => body.type === 'conversation_updated')
    expect(updateEvents).toHaveLength(2)
    const byTarget = Object.fromEntries(
      updateEvents.map((body) => [body.target.user_id as string, body]),
    )
    expect(byTarget['user-me']).toBeTruthy()
    expect(byTarget['user-me'].data).toMatchObject({
      peer: 'group@example.com',
      conversation_type: 'group',
      group_mailbox: 'group@example.com',
      sync_mode: 'mail',
      conversation: {
        peer: 'group@example.com',
        conversation_type: 'group',
        group_mailbox: 'group@example.com',
        sync_mode: 'mail',
        last_message: 'World',
        last_direction: 'outbound',
        last_sender_email: 'me@example.com',
        last_sender_name: 'Me',
      },
      message: {
        peer: 'group@example.com',
        conversation_type: 'group',
        group_mailbox: 'group@example.com',
        sync_mode: 'mail',
        direction: 'outbound',
        text: 'World',
        status: 'sent',
        sender_email: 'me@example.com',
        sender_name: 'Me',
      },
    })
    expect(byTarget['user-member']).toBeTruthy()
    expect(byTarget['user-member'].data).toMatchObject({
      peer: 'group@example.com',
      conversation_type: 'group',
      group_mailbox: 'group@example.com',
      sync_mode: 'mail',
      conversation: {
        peer: 'group@example.com',
        conversation_type: 'group',
        group_mailbox: 'group@example.com',
        sync_mode: 'mail',
        last_message: 'World',
        last_direction: 'inbound',
        last_sender_email: 'me@example.com',
        last_sender_name: 'Me',
      },
      message: {
        peer: 'group@example.com',
        conversation_type: 'group',
        group_mailbox: 'group@example.com',
        sync_mode: 'mail',
        direction: 'inbound',
        text: 'World',
        status: 'received',
        sender_email: 'me@example.com',
        sender_name: 'Me',
      },
    })
    expect(chatGroupMessageIndexRows).toHaveLength(1)
    expect(chatGroupMessageIndexRows[0]).toMatchObject({
      group_id: 'group-1',
      group_mailbox: 'group@example.com',
      email_id: expect.any(String),
      sender_email: 'me@example.com',
      sender_name: 'Me',
      sender_source: 'internal',
      text: 'World',
      provider: 'local',
    })
  })

  test('local direct send skips realtime notify when realtime is not configured', async () => {
    const { db } = createRealtimeRoutingMockD1({
      localUsers: ['you@example.com'],
      directUsersByMailbox: {
        'me@example.com': 'user-me',
        'you@example.com': 'user-you',
      },
    })
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      OUTBOUND_FROM_EMAIL: 'chat@example.com',
    })
    globalThis.fetch = mock(async () => {
      throw new Error('realtime notify should not be called')
    }) as typeof fetch

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEND_BODY),
    })
    const response = await worker.fetch(request, env)

    expect(response.status).toBe(200)
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0)
  })

  test('returns 405 for non-POST methods', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    const request = authedRequest('http://localhost/api/send', { method: 'GET' })
    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(405)
    expect(json.error).toBe('Method not allowed')
  })

  test('rejects sends for a different mailbox', async () => {
    const { db } = createMockD1()
    const env = singleMailboxEnv('me@example.com', { DB: db, RESEND_API_KEY: 're_test_key' })

    const request = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SEND_BODY, from: 'other@example.com' }),
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(403)
    expect(json.error).toBe('Forbidden')
  })
})

describe('worker: mailbox deletion', () => {
  test('internal mailbox delete removes inbox data and marks mailbox deleted', async () => {
    const { db, deletedMailboxes, emailRows, attachmentRows, getDeletedChatGroupIndexRuns } = createMailboxDeletionMockD1({
      mailbox: 'user@example.com',
      emailRows: [
        { id: 'email-1', mailbox: 'user@example.com' },
        { id: 'email-2', mailbox: 'user@example.com' },
        { id: 'email-3', mailbox: 'other@example.com' },
      ],
      attachmentRows: [
        { id: 'att-1', email_id: 'email-1' },
        { id: 'att-2', email_id: 'email-2' },
        { id: 'att-3', email_id: 'email-3' },
      ],
    })
    const env = {
      DB: db,
      INTERNAL_API_TOKEN: 'internal-token',
    } as Env

    const request = new Request('http://localhost/internal/mailbox/delete', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer internal-token',
        'X-Mailbox': 'user@example.com',
      },
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { ok: boolean; deleted: { emails: number; attachments: number } }

    expect(response.status).toBe(200)
    expect(json).toEqual({
      ok: true,
      deleted: {
        emails: 2,
        attachments: 2,
      },
    })
    expect(deletedMailboxes.has('user@example.com')).toBe(true)
    expect(emailRows).toEqual([{ id: 'email-3', mailbox: 'other@example.com' }])
    expect(attachmentRows).toEqual([{ id: 'att-3', email_id: 'email-3' }])
    expect(getDeletedChatGroupIndexRuns()).toBe(1)
  })

  test('mailbox delete requires internal auth', async () => {
    const { db } = createMailboxDeletionMockD1({
      mailbox: 'user@example.com',
    })
    const env = singleMailboxEnv('user@example.com', {
      DB: db,
      INTERNAL_API_TOKEN: 'internal-token',
    })

    const request = authedRequest('http://localhost/internal/mailbox/delete', {
      method: 'POST',
      headers: {
        'X-Mailbox': 'user@example.com',
      },
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(403)
    expect(json.error).toBe('Forbidden')
  })

  test('deleted mailbox drops future inbound email and local delivery', async () => {
    const { db, prepareMock } = createRealtimeRoutingMockD1({
      deletedMailboxes: ['deleted@example.com'],
    })
    const env = singleMailboxEnv('me@example.com', {
      DB: db,
      OUTBOUND_FROM_EMAIL: 'chat@example.com',
    })

    const inboundMessage = makeForwardableEmailMessage({
      to: 'deleted@example.com',
      from: 'sender@example.com',
      subject: 'Hello',
      bodyText: 'World',
    })

    await worker.email(inboundMessage, env)

    const inboxInsertSql = (prepareMock as any).mock.calls.find(([sql]: [string]) =>
      String(sql).includes('INSERT INTO emails')
    )
    expect(inboxInsertSql).toBeUndefined()

    const sendRequest = authedRequest('http://localhost/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'me@example.com',
        to: ['deleted@example.com'],
        subject: 'Hi deleted',
        text: 'Still stored outbound only',
      }),
    })

    const response = await worker.fetch(sendRequest, env)
    const json = await response.json() as { provider: string }

    expect(response.status).toBe(200)
    expect(json.provider).toBe('local')

    const insertCalls = (prepareMock as any).mock.calls
      .map(([sql]: [string]) => String(sql))
      .filter((sql) => sql.includes('INSERT INTO emails'))
    expect(insertCalls).toHaveLength(1)
  })
})

function makeForwardableEmailMessage(input: {
  to: string
  from: string
  subject: string
  bodyText?: string
  bodyHtml?: string
  messageId?: string
  references?: string
  inReplyTo?: string
}): ForwardableEmailMessage {
  const contentType = input.bodyHtml ? 'text/html; charset="utf-8"' : 'text/plain; charset="utf-8"'
  const body = input.bodyHtml ?? input.bodyText ?? ''
  const raw = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    ...(input.messageId ? [`Message-ID: ${input.messageId}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    `Content-Type: ${contentType}`,
    '',
    body,
    '',
  ].join('\r\n')
  const bytes = new TextEncoder().encode(raw)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return {
    from: input.from,
    to: input.to,
    headers: new Headers({
      from: input.from,
      to: input.to,
      subject: input.subject,
      'content-type': contentType,
    }),
    raw: stream,
  } as unknown as ForwardableEmailMessage
}

describe('worker: inbound email realtime notify', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('direct inbound email emits direct inbound realtime conversation update', async () => {
    const { db, prepareMock } = createRealtimeRoutingMockD1({
      directUsersByMailbox: {
        'recipient@example.com': 'user-recipient',
      },
    })
    const env = {
      DB: db,
      REALTIME_NOTIFY_BASE_URL: 'https://realtime.example.com',
      REALTIME_INTERNAL_TOKEN: 'rt-internal',
    } as Env
    const realtimeNotifyBodies: Array<Record<string, any>> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://realtime.example.com/internal/notify') {
        realtimeNotifyBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (url === 'https://realtime.example.com/internal/notify-batch') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        realtimeNotifyBodies.push(...(body.events ?? []))
        return new Response(JSON.stringify({ ok: true, count: (body.events ?? []).length }), { status: 200 })
      }
      throw new Error(`unexpected fetch url ${url}`)
    }) as typeof fetch

    const message = makeForwardableEmailMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      bodyText: 'Hello',
    })
    const harness = createExecutionContextHarness()
    await worker.email(message, env, harness.ctx)
    await harness.flush()

    expect(realtimeNotifyBodies).toHaveLength(1)
    expect(realtimeNotifyBodies[0]!.target.user_id).toBe('user-recipient')
    expect(realtimeNotifyBodies[0]!.type).toBe('conversation_updated')
    expect(realtimeNotifyBodies[0]!.data).toMatchObject({
      peer: 'sender@example.com',
      conversation_type: 'direct',
      group_mailbox: null,
      sync_mode: 'mail',
      conversation: {
        peer: 'sender@example.com',
        conversation_type: 'direct',
        group_mailbox: null,
        sync_mode: 'mail',
        last_message: 'Hello',
        last_direction: 'inbound',
        last_sender_email: 'sender@example.com',
        last_sender_name: null,
      },
      message: {
        peer: 'sender@example.com',
        conversation_type: 'direct',
        group_mailbox: null,
        sync_mode: 'mail',
        direction: 'inbound',
        text: 'Hello',
        status: 'received',
        sender_email: 'sender@example.com',
        sender_name: null,
      },
    })
    const preparedSQL = (prepareMock as any).mock.calls.map(([sql]: [string]) => String(sql))
    expect(preparedSQL.some((sql: string) => sql.includes('FROM emails') && sql.includes('peer_address = ?'))).toBe(false)
  })

  test('direct inbound html email includes cleaned text and render_text in realtime payload', async () => {
    const { db } = createRealtimeRoutingMockD1({
      directUsersByMailbox: {
        'recipient@example.com': 'user-recipient',
      },
    })
    const env = {
      DB: db,
      REALTIME_NOTIFY_BASE_URL: 'https://realtime.example.com',
      REALTIME_INTERNAL_TOKEN: 'rt-internal',
    } as Env
    const realtimeNotifyBodies: Array<Record<string, any>> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://realtime.example.com/internal/notify') {
        realtimeNotifyBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      throw new Error(`unexpected fetch url ${url}`)
    }) as typeof fetch

    const message = makeForwardableEmailMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'FYI',
      bodyHtml: [
        '<div>帮我看下</div>',
        '<div>- - - - - 原 始 邮 件 - - - - -</div>',
        '<div>发件人：Alice &lt;alice@example.com&gt;</div>',
        '<div>发送时间：2026年5月18日 10:00</div>',
        '<div>收件人：Team &lt;team@example.com&gt;</div>',
        '<div>主 题：Roadmap</div>',
        '<div><br></div>',
        '<div>请看这个计划。</div>',
      ].join(''),
    })
    const harness = createExecutionContextHarness()
    await worker.email(message, env, harness.ctx)
    await harness.flush()

    expect(realtimeNotifyBodies).toHaveLength(1)
    expect(realtimeNotifyBodies[0]!.type).toBe('conversation_updated')
    expect(realtimeNotifyBodies[0]!.data).toMatchObject({
      peer: 'sender@example.com',
      conversation_type: 'direct',
      group_mailbox: null,
      sync_mode: 'mail',
      message: {
        render_text: expect.stringContaining('<div>帮我看下</div>'),
      },
    })
    const conversation = realtimeNotifyBodies[0]!.data.conversation as Record<string, unknown>
    const payloadMessage = realtimeNotifyBodies[0]!.data.message as Record<string, unknown>
    expect(String(conversation.last_message ?? '')).toContain('帮我看下')
    expect(String(conversation.last_message ?? '')).toContain('请看这个计划。')
    expect(String(conversation.last_message ?? '')).not.toContain('原 始 邮 件')
    expect(String(conversation.last_message ?? '')).not.toContain('发件人：')
    expect(String(payloadMessage.text ?? '')).toContain('帮我看下')
    expect(String(payloadMessage.text ?? '')).toContain('请看这个计划。')
    expect(String(payloadMessage.text ?? '')).not.toContain('原 始 邮 件')
    expect(String(payloadMessage.text ?? '')).not.toContain('发件人：')
  })

  test('group inbound email fans out realtime conversation updates to active members', async () => {
    const { db, chatGroupMessageIndexRows, prepareMock } = createRealtimeRoutingMockD1({
      groupsByMailbox: {
        'group@example.com': { id: 'group-1', mailbox: 'group@example.com', sync_mode: 'mail' },
      },
      groupMembersByGroupID: {
        'group-1': [
          { user_id: 'user-sender', member_mailbox: 'sender@example.com', display_name: 'Sender' },
          { user_id: 'user-member', member_mailbox: 'member@example.com', display_name: 'Member' },
        ],
      },
    })
    const env = {
      DB: db,
      REALTIME_NOTIFY_BASE_URL: 'https://realtime.example.com',
      REALTIME_INTERNAL_TOKEN: 'rt-internal',
    } as Env
    const realtimeNotifyBodies: Array<Record<string, any>> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://realtime.example.com/internal/notify-batch') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        realtimeNotifyBodies.push(...(body.events ?? []))
        return new Response(JSON.stringify({ ok: true, count: (body.events ?? []).length }), { status: 200 })
      }
      throw new Error(`unexpected fetch url ${url}`)
    }) as typeof fetch

    const message = makeForwardableEmailMessage({
      from: 'sender@example.com',
      to: 'group@example.com',
      subject: 'Group',
      bodyText: 'Hello group',
    })
    const harness = createExecutionContextHarness()
    await worker.email(message, env, harness.ctx)
    await harness.flush()

    expect(realtimeNotifyBodies).toHaveLength(2)
    const updateEvents = realtimeNotifyBodies.filter((body) => body.type === 'conversation_updated')
    const byTarget = Object.fromEntries(
      updateEvents.map((body) => [body.target.user_id as string, body]),
    )
    expect(byTarget['user-sender'].data).toMatchObject({
      peer: 'group@example.com',
      conversation_type: 'group',
      group_mailbox: 'group@example.com',
      sync_mode: 'mail',
      conversation: {
        peer: 'group@example.com',
        conversation_type: 'group',
        group_mailbox: 'group@example.com',
        sync_mode: 'mail',
        last_message: 'Hello group',
        last_direction: 'outbound',
        last_sender_email: 'sender@example.com',
        last_sender_name: 'Sender',
      },
      message: {
        peer: 'group@example.com',
        conversation_type: 'group',
        group_mailbox: 'group@example.com',
        sync_mode: 'mail',
        direction: 'outbound',
        text: 'Hello group',
        status: 'sent',
        sender_email: 'sender@example.com',
        sender_name: 'Sender',
      },
    })
    expect(byTarget['user-member'].data).toMatchObject({
      peer: 'group@example.com',
      conversation_type: 'group',
      group_mailbox: 'group@example.com',
      sync_mode: 'mail',
      conversation: {
        peer: 'group@example.com',
        conversation_type: 'group',
        group_mailbox: 'group@example.com',
        sync_mode: 'mail',
        last_message: 'Hello group',
        last_direction: 'inbound',
        last_sender_email: 'sender@example.com',
        last_sender_name: 'Sender',
      },
      message: {
        peer: 'group@example.com',
        conversation_type: 'group',
        group_mailbox: 'group@example.com',
        sync_mode: 'mail',
        direction: 'inbound',
        text: 'Hello group',
        status: 'received',
        sender_email: 'sender@example.com',
        sender_name: 'Sender',
      },
    })
    expect(chatGroupMessageIndexRows).toHaveLength(1)
    expect(chatGroupMessageIndexRows[0]).toMatchObject({
      group_id: 'group-1',
      group_mailbox: 'group@example.com',
      email_id: expect.any(String),
      sender_email: 'sender@example.com',
      sender_name: 'Sender',
      sender_source: 'internal',
      text: 'Hello group',
      provider: null,
    })
    const preparedSQL = (prepareMock as any).mock.calls.map(([sql]: [string]) => String(sql))
    expect(preparedSQL.some((sql: string) => sql.includes('FROM chat_group_message_index') && sql.includes('ORDER BY received_at DESC'))).toBe(false)
  })

  test('group inbound html email includes cleaned text and render_text in realtime payload', async () => {
    const { db } = createRealtimeRoutingMockD1({
      groupsByMailbox: {
        'group@example.com': { id: 'group-1', mailbox: 'group@example.com', sync_mode: 'mail' },
      },
      groupMembersByGroupID: {
        'group-1': [
          { user_id: 'user-sender', member_mailbox: 'sender@example.com', display_name: 'Sender' },
          { user_id: 'user-member', member_mailbox: 'member@example.com', display_name: 'Member' },
        ],
      },
    })
    const env = {
      DB: db,
      REALTIME_NOTIFY_BASE_URL: 'https://realtime.example.com',
      REALTIME_INTERNAL_TOKEN: 'rt-internal',
    } as Env
    const realtimeNotifyBodies: Array<Record<string, any>> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://realtime.example.com/internal/notify-batch') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        realtimeNotifyBodies.push(...(body.events ?? []))
        return new Response(JSON.stringify({ ok: true, count: (body.events ?? []).length }), { status: 200 })
      }
      throw new Error(`unexpected fetch url ${url}`)
    }) as typeof fetch

    const message = makeForwardableEmailMessage({
      from: 'sender@example.com',
      to: 'group@example.com',
      subject: 'FYI',
      bodyHtml: [
        '<div>帮我看下</div>',
        '<div>- - - - - 原 始 邮 件 - - - - -</div>',
        '<div>发件人：Alice &lt;alice@example.com&gt;</div>',
        '<div>发送时间：2026年5月18日 10:00</div>',
        '<div>收件人：Team &lt;team@example.com&gt;</div>',
        '<div>主 题：Roadmap</div>',
        '<div><br></div>',
        '<div>请看这个计划。</div>',
      ].join(''),
    })
    const harness = createExecutionContextHarness()
    await worker.email(message, env, harness.ctx)
    await harness.flush()

    expect(realtimeNotifyBodies).toHaveLength(2)
    const updateEvents = realtimeNotifyBodies.filter((body) => body.type === 'conversation_updated')
    expect(updateEvents).toHaveLength(2)
    for (const event of updateEvents) {
      expect(event.data).toMatchObject({
        peer: 'group@example.com',
        conversation_type: 'group',
        group_mailbox: 'group@example.com',
        sync_mode: 'mail',
        message: {
          render_text: expect.stringContaining('<div>帮我看下</div>'),
        },
      })
      const conversation = event.data.conversation as Record<string, unknown>
      const payloadMessage = event.data.message as Record<string, unknown>
      expect(String(conversation.last_message ?? '')).toContain('帮我看下')
      expect(String(conversation.last_message ?? '')).toContain('请看这个计划。')
      expect(String(conversation.last_message ?? '')).not.toContain('原 始 邮 件')
      expect(String(payloadMessage.text ?? '')).toContain('帮我看下')
      expect(String(payloadMessage.text ?? '')).toContain('请看这个计划。')
      expect(String(payloadMessage.text ?? '')).not.toContain('原 始 邮 件')
      expect(String(payloadMessage.sender_name ?? '')).toBe('Sender')
    }
  })

  test('fast_chat group inbound email is ignored', async () => {
    const { db, chatGroupMessageIndexRows } = createRealtimeRoutingMockD1({
      groupsByMailbox: {
        'group@example.com': { id: 'group-1', mailbox: 'group@example.com', sync_mode: 'fast_chat' },
      },
      groupMembersByGroupID: {
        'group-1': [
          { user_id: 'user-member', member_mailbox: 'member@example.com', display_name: 'Member' },
        ],
      },
    })
    const env = {
      DB: db,
      REALTIME_NOTIFY_BASE_URL: 'https://realtime.example.com',
      REALTIME_INTERNAL_TOKEN: 'rt-internal',
    } as Env
    globalThis.fetch = mock(async () => {
      throw new Error('fast_chat group inbound email should not trigger realtime notify')
    }) as typeof fetch

    const message = makeForwardableEmailMessage({
      from: 'sender@example.com',
      to: 'group@example.com',
      subject: 'Group',
      bodyText: 'Hello fast group',
    })
    const harness = createExecutionContextHarness()
    await worker.email(message, env, harness.ctx)
    await harness.flush()

    expect(chatGroupMessageIndexRows).toHaveLength(0)
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0)
  })
})

function createDirectExternalThreadTrackingMockD1(directExternalEmailThreads: DirectExternalEmailThreadRow[]) {
  return {
    prepare: mock((sql: string) => ({
      bind: mock((...params: unknown[]) => {
        if (sql.includes('FROM deleted_mailboxes')) {
          return {
            first: mock(() => Promise.resolve(null)),
            all: mock(() => Promise.resolve({ results: [] })),
            run: mock(() => Promise.resolve({ success: true })),
          }
        }
        if (sql.includes('FROM chat_groups')) {
          return {
            first: mock(() => Promise.resolve(null)),
            all: mock(() => Promise.resolve({ results: [] })),
            run: mock(() => Promise.resolve({ success: true })),
          }
        }
        if (sql.includes('INSERT INTO emails') || sql.includes('INSERT INTO attachments')) {
          return {
            first: mock(() => Promise.resolve(null)),
            all: mock(() => Promise.resolve({ results: [] })),
            run: mock(() => Promise.resolve({ success: true })),
          }
        }
        if (sql.includes('FROM direct_external_email_threads') && sql.includes('WHERE owner_mailbox = ? AND peer_email = ?')) {
          return {
            first: mock(() => Promise.resolve(null)),
            all: mock(() => Promise.resolve({
              results: directExternalEmailThreads
                .filter((row) =>
                  row.owner_mailbox === String(params[0]) && row.peer_email === String(params[1])
                )
                .sort((lhs, rhs) => {
                  const updatedOrder = String(rhs.updated_at).localeCompare(String(lhs.updated_at))
                  return updatedOrder !== 0 ? updatedOrder : String(rhs.id).localeCompare(String(lhs.id))
                }),
            })),
            run: mock(() => Promise.resolve({ success: true })),
          }
        }
        if (sql.includes('UPDATE direct_external_email_threads')) {
          return {
            first: mock(() => Promise.resolve(null)),
            all: mock(() => Promise.resolve({ results: [] })),
            run: mock(() => {
              const existing = directExternalEmailThreads.find((row) => row.id === String(params[5]))
              if (existing) {
                existing.topic_label = params[0] === null ? null : String(params[0])
                existing.anchor_message_id = String(params[1])
                existing.references_chain = String(params[2])
                existing.reply_subject = params[3] === null ? null : String(params[3])
                existing.updated_at = String(params[4])
              }
              return Promise.resolve({ success: true })
            }),
          }
        }
        if (sql.includes('INSERT INTO direct_external_email_threads')) {
          return {
            first: mock(() => Promise.resolve(null)),
            all: mock(() => Promise.resolve({ results: [] })),
            run: mock(() => {
              directExternalEmailThreads.push({
                id: String(params[0]),
                owner_mailbox: String(params[1]),
                peer_email: String(params[2]),
                topic_key: String(params[3]),
                topic_label: params[4] === null ? null : String(params[4]),
                anchor_message_id: String(params[5]),
                references_chain: String(params[6]),
                reply_subject: params[7] === null ? null : String(params[7]),
                created_at: String(params[8]),
                updated_at: String(params[9]),
              })
              return Promise.resolve({ success: true })
            }),
          }
        }
        return {
          first: mock(() => Promise.resolve(null)),
          all: mock(() => Promise.resolve({ results: [] })),
          run: mock(() => Promise.resolve({ success: true })),
        }
      }),
    })),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())),
  } as unknown as D1Database
}

describe('worker: inbound direct external thread tracking', () => {
  test('inbound external reply updates direct_external_email_threads with merged chain', async () => {
    const directExternalEmailThreads: DirectExternalEmailThreadRow[] = [{
      id: 'thread-existing-1',
      owner_mailbox: 'recipient@example.com',
      peer_email: 'sender@example.com',
      anchor_message_id: '<chat-anchor-original@canyin.uk>',
      references_chain: '<chat-root@canyin.uk> <chat-before@canyin.uk>',
      reply_subject: 'Chat',
      created_at: '2026-05-15T00:00:00.000Z',
      updated_at: '2026-05-15T00:00:00.000Z',
    }]
    const env = {
      DB: createDirectExternalThreadTrackingMockD1(directExternalEmailThreads),
      MAILBOX: 'worker@canyin.uk',
    } as Env

    const message = makeForwardableEmailMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Re: Project Alpha',
      bodyText: 'Reply from external',
      messageId: '<external-reply@example.com>',
      references: '<chat-root@canyin.uk> <chat-anchor-original@canyin.uk>',
    })

    await worker.email(message, env)

    expect(directExternalEmailThreads).toHaveLength(1)
    expect(directExternalEmailThreads[0]).toMatchObject({
      owner_mailbox: 'recipient@example.com',
      peer_email: 'sender@example.com',
      anchor_message_id: '<external-reply@example.com>',
      references_chain: '<chat-root@canyin.uk> <chat-before@canyin.uk> <chat-anchor-original@canyin.uk> <external-reply@example.com>',
      reply_subject: 'Re: Project Alpha',
    })
  })

  test('inbound external new compose switches direct_external_email_threads to a new chain', async () => {
    const directExternalEmailThreads: DirectExternalEmailThreadRow[] = [{
      id: 'thread-existing-2',
      owner_mailbox: 'recipient@example.com',
      peer_email: 'sender@example.com',
      anchor_message_id: '<chat-current-anchor@canyin.uk>',
      references_chain: '<chat-current-root@canyin.uk>',
      reply_subject: 'Chat',
      created_at: '2026-05-15T00:00:00.000Z',
      updated_at: '2026-05-15T00:00:00.000Z',
    }]
    const env = {
      DB: createDirectExternalThreadTrackingMockD1(directExternalEmailThreads),
      MAILBOX: 'worker@canyin.uk',
    } as Env

    const message = makeForwardableEmailMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'A different note',
      bodyText: 'New compose from external',
      messageId: '<external-new-compose@example.com>',
    })

    await worker.email(message, env)

    expect(directExternalEmailThreads).toHaveLength(2)
    expect(directExternalEmailThreads[1]).toMatchObject({
      owner_mailbox: 'recipient@example.com',
      peer_email: 'sender@example.com',
      topic_key: 'a-different-note',
      topic_label: 'A different note',
      anchor_message_id: '<external-new-compose@example.com>',
      references_chain: '<external-new-compose@example.com>',
      reply_subject: 'A different note',
    })
  })

  test('inbound external reply chooses the matching topic by ancestry over subject recency', async () => {
    const directExternalEmailThreads: DirectExternalEmailThreadRow[] = [
      {
        id: 'thread-topic-1',
        owner_mailbox: 'recipient@example.com',
        peer_email: 'sender@example.com',
        topic_key: 'project-alpha',
        topic_label: 'Project Alpha',
        anchor_message_id: '<alpha-anchor@canyin.uk>',
        references_chain: '<alpha-root@canyin.uk>',
        reply_subject: 'Project Alpha',
        created_at: '2026-05-15T00:00:00.000Z',
        updated_at: '2026-05-15T00:00:00.000Z',
      },
      {
        id: 'thread-topic-2',
        owner_mailbox: 'recipient@example.com',
        peer_email: 'sender@example.com',
        topic_key: 'project-beta',
        topic_label: 'Project Beta',
        anchor_message_id: '<beta-anchor@canyin.uk>',
        references_chain: '<beta-root@canyin.uk>',
        reply_subject: 'Project Beta',
        created_at: '2026-05-15T00:00:00.000Z',
        updated_at: '2026-05-15T00:30:00.000Z',
      },
    ]
    const env = {
      DB: createDirectExternalThreadTrackingMockD1(directExternalEmailThreads),
      MAILBOX: 'worker@canyin.uk',
    } as Env

    const message = makeForwardableEmailMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Re: Project Alpha',
      bodyText: 'Reply to alpha thread',
      messageId: '<alpha-reply@example.com>',
      references: '<alpha-root@canyin.uk> <alpha-anchor@canyin.uk>',
    })

    await worker.email(message, env)

    expect(directExternalEmailThreads).toHaveLength(2)
    expect(directExternalEmailThreads[0]).toMatchObject({
      id: 'thread-topic-1',
      topic_key: 'project-alpha',
      anchor_message_id: '<alpha-reply@example.com>',
      references_chain: '<alpha-root@canyin.uk> <alpha-anchor@canyin.uk> <alpha-reply@example.com>',
      reply_subject: 'Re: Project Alpha',
    })
    expect(directExternalEmailThreads[1]).toMatchObject({
      id: 'thread-topic-2',
      topic_key: 'project-beta',
      anchor_message_id: '<beta-anchor@canyin.uk>',
    })
  })

  test('inbound external reply strips repeated reply prefixes when deriving topic labels', async () => {
    const directExternalEmailThreads: DirectExternalEmailThreadRow[] = [{
      id: 'thread-topic-work-1',
      owner_mailbox: 'recipient@example.com',
      peer_email: 'sender@example.com',
      topic_key: 'work',
      topic_label: 'work',
      anchor_message_id: '<work-anchor@canyin.uk>',
      references_chain: '<work-root@canyin.uk>',
      reply_subject: 'work',
      created_at: '2026-05-15T00:00:00.000Z',
      updated_at: '2026-05-15T00:00:00.000Z',
    }]
    const env = {
      DB: createDirectExternalThreadTrackingMockD1(directExternalEmailThreads),
      MAILBOX: 'worker@canyin.uk',
    } as Env

    const message = makeForwardableEmailMessage({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Re: Re: work',
      bodyText: 'Reply to existing work thread',
      messageId: '<work-reply@example.com>',
      references: '<work-root@canyin.uk> <work-anchor@canyin.uk>',
    })

    await worker.email(message, env)

    expect(directExternalEmailThreads).toHaveLength(1)
    expect(directExternalEmailThreads[0]).toMatchObject({
      id: 'thread-topic-work-1',
      topic_key: 'work',
      topic_label: 'work',
      anchor_message_id: '<work-reply@example.com>',
      references_chain: '<work-root@canyin.uk> <work-anchor@canyin.uk> <work-reply@example.com>',
      reply_subject: 'Re: Re: work',
    })
  })

  test('inbound local-domain sender does not update direct_external_email_threads', async () => {
    const directExternalEmailThreads: DirectExternalEmailThreadRow[] = []
    const env = {
      DB: createDirectExternalThreadTrackingMockD1(directExternalEmailThreads),
      MAILBOX: 'worker@canyin.uk',
    } as Env

    const message = makeForwardableEmailMessage({
      from: 'peer@canyin.uk',
      to: 'recipient@example.com',
      subject: 'Internal mail',
      bodyText: 'This should not touch direct_external_email_threads',
      messageId: '<internal-mail@canyin.uk>',
    })

    await worker.email(message, env)

    expect(directExternalEmailThreads).toHaveLength(0)
  })
})

// --- GET /api/sync tests ---

function makeSyncEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sync-e1',
    mailbox: 'user@test.com',
    from_address: 'sender@test.com',
    from_name: 'Sender',
    to_address: 'user@test.com',
    subject: 'Test email',
    body_text: 'Hello world',
    body_html: '<p>Hello world</p>',
    code: '123456',
    headers: '{"x-test":"1"}',
    metadata: '{"source":"test"}',
    message_id: '<msg-1@test.com>',
    has_attachments: 0,
    attachment_count: 0,
    attachment_names: '',
    attachment_search_text: '',
    raw_storage_key: null,
    direction: 'inbound',
    status: 'received',
    received_at: '2026-03-19T10:00:00Z',
    created_at: '2026-03-19T10:00:00Z',
    ...overrides,
  }
}

function makeSyncAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    email_id: 'sync-e1',
    filename: 'report.txt',
    content_type: 'text/plain',
    size_bytes: 42,
    content_disposition: 'attachment',
    content_id: null,
    mime_part_index: 0,
    text_content: 'report content',
    text_extraction_status: 'done',
    storage_key: 's3://bucket/key',
    created_at: '2026-03-19T10:00:00Z',
    ...overrides,
  }
}

function createSyncMockD1(options: {
  total?: number
  emailRows?: Record<string, unknown>[]
  attachmentRows?: Record<string, unknown>[][]
} = {}) {
  const { total = 1, emailRows, attachmentRows } = options
  const defaultEmails = emailRows ?? [makeSyncEmail()]
  const defaultAttachments = attachmentRows ?? defaultEmails.map(() => [])

  let callIndex = 0
  const prepareMock = mock((_sql: string) => {
    const currentCall = callIndex++
    return {
      bind: mock((..._args: unknown[]) => ({
        first: mock(() => {
          // First call is the COUNT query
          return Promise.resolve({ total })
        }),
        all: mock(() => {
          if (currentCall === 1) {
            // Second call: SELECT * FROM emails
            return Promise.resolve({ results: defaultEmails })
          }
          // Subsequent calls: SELECT * FROM attachments for each email
          const attachmentIndex = currentCall - 2
          return Promise.resolve({ results: defaultAttachments[attachmentIndex] ?? [] })
        }),
      })),
    }
  })

  return { db: { prepare: prepareMock } as unknown as D1Database, prepareMock }
}

describe('worker: GET /api/inbox and /api/code', () => {
  test('escapes LIKE wildcards in inbox search', async () => {
    let capturedSql = ''
    let capturedArgs: unknown[] = []
    const db = {
      prepare: mock((sql: string) => {
        capturedSql = sql
        return {
          bind: mock((...args: unknown[]) => {
            capturedArgs = args
            return {
              all: mock(() => Promise.resolve({ results: [] })),
            }
          }),
        }
      }),
    } as unknown as D1Database

    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/inbox?to=user@test.com&query=100%_done'),
      env,
    )

    expect(response.status).toBe(200)
    expect(capturedSql).toContain("subject LIKE ? ESCAPE '\\'")
    expect(capturedArgs[1]).toBe('%100\\%\\_done%')
  })

  test('recomputes inbox code from html-only body instead of stale stored code', async () => {
    const db = {
      prepare: mock(() => ({
        bind: mock(() => ({
          all: mock(() => Promise.resolve({
            results: [
              makeSyncEmail({
                subject: 'OTP Code',
                body_text: '',
                body_html: '<p>OTP Code:<strong>114669</strong></p>',
                code: 'Code',
              }),
            ],
          })),
        })),
      })),
    } as unknown as D1Database

    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/inbox?to=user@test.com'),
      env,
    )
    const json = await response.json() as { emails: Array<{ code: string | null }> }

    expect(response.status).toBe(200)
    expect(json.emails[0]!.code).toBe('114669')
  })

  test('recomputes polled code from html-only body when stored code is stale', async () => {
    const db = {
      prepare: mock(() => ({
        bind: mock(() => ({
          all: mock(() => Promise.resolve({
            results: [
              {
                id: 'sync-e1',
                from_address: 'sender@test.com',
                subject: 'OTP Code',
                body_text: '',
                body_html: '<p>OTP Code:<strong>114669</strong></p>',
                code: 'Code',
                received_at: '2026-03-19T10:00:00Z',
              },
            ],
          })),
        })),
      })),
    } as unknown as D1Database

    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/code?to=user@test.com&timeout=1'),
      env,
    )
    const json = await response.json() as { code: string | null }

    expect(response.status).toBe(200)
    expect(json.code).toBe('114669')
  })

  test('rejects code polling for another mailbox', async () => {
    const db = {
      prepare: mock(() => ({
        bind: mock(() => ({
          first: mock(() => Promise.resolve(null)),
        })),
      })),
    } as unknown as D1Database

    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/code?to=other@test.com&timeout=1'),
      env,
    )
    const json = await response.json() as { error: string }

    expect(response.status).toBe(403)
    expect(json.error).toBe('Forbidden')
  })

  test('rejects internal token from polling a direct-user mailbox without matching user access token', async () => {
    const db = {
      prepare: mock((sql: string) => ({
        bind: mock((...args: unknown[]) => {
          if (sql.includes('FROM users u') && sql.includes('LEFT JOIN chat_groups g')) {
            return {
              first: mock(() => Promise.resolve({ id: 'user-1' })),
              all: mock(() => Promise.resolve({ results: [] })),
              run: mock(() => Promise.resolve({ success: true })),
            }
          }
          return {
            first: mock(() => Promise.resolve(null)),
            all: mock(() => Promise.resolve({ results: [] })),
            run: mock(() => Promise.resolve({ success: true })),
          }
        }),
      })),
    } as unknown as D1Database

    const env = {
      DB: db,
      INTERNAL_API_TOKEN: 'internal-token',
      ACCESS_TOKEN_SECRET: 'test-auth-secret',
    } as Env

    const request = new Request('http://localhost/internal/code?to=user@test.com&timeout=1', {
      headers: {
        Authorization: 'Bearer internal-token',
        'X-Mailbox': 'user@test.com',
      },
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(403)
    expect(json.error).toBe('Forbidden')
  })

  test('allows internal token to read a direct-user mailbox only with the matching user access token', async () => {
    const db = {
      prepare: mock((sql: string) => ({
        bind: mock((...args: unknown[]) => {
          if (sql.includes('FROM users u') && sql.includes('LEFT JOIN chat_groups g')) {
            return {
              first: mock(() => Promise.resolve({ id: 'user-1' })),
              all: mock(() => Promise.resolve({ results: [] })),
              run: mock(() => Promise.resolve({ success: true })),
            }
          }
          return {
            first: mock(() => Promise.resolve(null)),
            all: mock(() => Promise.resolve({
              results: [{
                id: 'sync-e1',
                from_address: 'sender@test.com',
                subject: 'OTP Code',
                body_text: 'Your verification code is 114669',
                body_html: '',
                code: null,
                received_at: '2026-03-19T10:00:00Z',
              }],
            })),
            run: mock(() => Promise.resolve({ success: true })),
          }
        }),
      })),
    } as unknown as D1Database

    const env = {
      DB: db,
      INTERNAL_API_TOKEN: 'internal-token',
      ACCESS_TOKEN_SECRET: 'test-auth-secret',
    } as Env

    const request = new Request('http://localhost/internal/code?to=user@test.com&timeout=1', {
      headers: {
        Authorization: 'Bearer internal-token',
        'X-Mailbox': 'user@test.com',
        'X-User-Authorization': `Bearer ${createAccessToken({
          sub: 'user-1',
          email: 'user@test.com',
          mailbox: 'user@test.com',
        })}`,
      },
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { code: string | null }

    expect(response.status).toBe(200)
    expect(json.code).toBe('114669')
  })

  test('public mailbox routes do not accept the internal token', async () => {
    const db = {
      prepare: mock(() => ({
        bind: mock(() => ({
          first: mock(() => Promise.resolve(null)),
          all: mock(() => Promise.resolve({ results: [] })),
          run: mock(() => Promise.resolve({ success: true })),
        })),
      })),
    } as unknown as D1Database

    const env = {
      DB: db,
      AUTH_TOKEN: 'public-token',
      MAILBOX: 'user@test.com',
      INTERNAL_API_TOKEN: 'internal-token',
    } as Env

    const request = new Request('http://localhost/api/code?to=user@test.com&timeout=1', {
      headers: {
        Authorization: 'Bearer internal-token',
      },
    })

    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(401)
    expect(json.error).toBe('Unauthorized')
  })
})

describe('worker: GET /api/email', () => {
  test('returns email for a unique short id prefix', async () => {
    let callIndex = 0
    const prepareMock = mock((_sql: string) => {
      const currentCall = callIndex++
      return {
        bind: mock((..._args: unknown[]) => ({
          first: mock(() => {
            if (currentCall === 0) return Promise.resolve(null)
            return Promise.resolve(null)
          }),
          all: mock(() => {
            if (currentCall === 1) return Promise.resolve({ results: [makeSyncEmail({ id: 'sync-e1-full' })] })
            if (currentCall === 2) return Promise.resolve({ results: [] })
            return Promise.resolve({ results: [] })
          }),
        })),
      }
    })

    const env = singleMailboxEnv('user@test.com', { DB: { prepare: prepareMock } as unknown as D1Database })
    const response = await worker.fetch(authedRequest('http://localhost/api/email?id=sync-e1'), env)
    const json = await response.json() as { id: string }

    expect(response.status).toBe(200)
    expect(json.id).toBe('sync-e1-full')
  })

  test('returns 409 for ambiguous short id prefix', async () => {
    let callIndex = 0
    const prepareMock = mock((_sql: string) => {
      const currentCall = callIndex++
      return {
        bind: mock((..._args: unknown[]) => ({
          first: mock(() => Promise.resolve(null)),
          all: mock(() => {
            if (currentCall === 1) {
              return Promise.resolve({ results: [makeSyncEmail({ id: 'sync-e1' }), makeSyncEmail({ id: 'sync-e2' })] })
            }
            return Promise.resolve({ results: [] })
          }),
        })),
      }
    })

    const env = singleMailboxEnv('user@test.com', { DB: { prepare: prepareMock } as unknown as D1Database })
    const response = await worker.fetch(authedRequest('http://localhost/api/email?id=sync-e'), env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(409)
    expect(json.error).toContain('Ambiguous email id: sync-e')
  })
})

describe('worker: GET /api/sync', () => {
  test('returns emails since timestamp', async () => {
    const email1 = makeSyncEmail({ id: 'e1', received_at: '2026-03-19T10:00:00Z' })
    const email2 = makeSyncEmail({ id: 'e2', received_at: '2026-03-19T11:00:00Z', subject: 'Second' })

    const { db } = createSyncMockD1({
      total: 2,
      emailRows: [email1, email2],
      attachmentRows: [[], []],
    })
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const request = authedRequest('http://localhost/api/sync?to=user@test.com&since=2026-03-19T00:00:00Z')
    const response = await worker.fetch(request, env)
    const json = await response.json() as { emails: any[]; total: number; has_more: boolean }

    expect(response.status).toBe(200)
    expect(json.total).toBe(2)
    expect(json.emails).toHaveLength(2)
    expect(json.has_more).toBe(false)
    // headers/metadata should be parsed from JSON strings
    expect(json.emails[0].headers).toEqual({ 'x-test': '1' })
    expect(json.emails[0].metadata).toEqual({ source: 'test' })
    expect(json.emails[0].has_attachments).toBe(false)
  })

  test('returns 400 without ?to=', async () => {
    const { db } = createSyncMockD1()
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const request = authedRequest('http://localhost/api/sync')
    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(400)
    expect(json.error).toContain('Missing ?to=')
  })

  test('returns attachments with emails', async () => {
    const email = makeSyncEmail({ has_attachments: 1, attachment_count: 1 })
    const attachment = makeSyncAttachment()

    const { db } = createSyncMockD1({
      total: 1,
      emailRows: [email],
      attachmentRows: [[attachment]],
    })
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const request = authedRequest('http://localhost/api/sync?to=user@test.com')
    const response = await worker.fetch(request, env)
    const json = await response.json() as { emails: any[] }

    expect(response.status).toBe(200)
    expect(json.emails).toHaveLength(1)
    expect(json.emails[0].has_attachments).toBe(true)
    expect(json.emails[0].attachment_count).toBe(1)
    expect(json.emails[0].attachments).toHaveLength(1)
    expect(json.emails[0].attachments[0].filename).toBe('report.txt')
    expect(json.emails[0].attachments[0].downloadable).toBe(true)
  })

  test('supports pagination', async () => {
    const email = makeSyncEmail()

    const { db } = createSyncMockD1({
      total: 150,
      emailRows: [email],
      attachmentRows: [[]],
    })
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const request = authedRequest('http://localhost/api/sync?to=user@test.com&limit=50&offset=0')
    const response = await worker.fetch(request, env)
    const json = await response.json() as { emails: any[]; total: number; has_more: boolean }

    expect(response.status).toBe(200)
    expect(json.total).toBe(150)
    expect(json.has_more).toBe(true)
  })

  test('falls back to from/to matching when peer_address is null', async () => {
    const capturedSqls: string[] = []
    const capturedBinds: Array<{ sql: string; args: unknown[] }> = []
    const db = {
      prepare: mock((sql: string) => {
        capturedSqls.push(sql)
        return {
          bind: mock((...args: unknown[]) => {
            capturedBinds.push({ sql, args })
            return {
              first: mock(() => Promise.resolve({ total: 1 })),
              all: mock(() => Promise.resolve({ results: [makeSyncEmail({ peer_address: null, from_address: 'friend@example.com' })] })),
            }
          }),
        }
      }),
    } as unknown as D1Database

    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/sync?to=user@test.com&peer=friend@example.com&since=1970-01-01T00:00:00Z&limit=1'),
      env,
    )
    const json = await response.json() as { emails: any[] }

    expect(response.status).toBe(200)
    expect(json.emails).toHaveLength(1)
    const messageQuery = capturedSqls.find((sql) => sql.includes('SELECT * FROM emails'))
    expect(messageQuery).toBeTruthy()
    expect(messageQuery!).toContain('peer_address = ?')
    expect(messageQuery!).toContain("peer_address IS NULL AND direction = 'inbound'")
    expect(messageQuery!).toContain("peer_address IS NULL AND direction = 'outbound'")
    const messageBind = capturedBinds.find((entry) => entry.sql.includes('SELECT * FROM emails'))
    expect(messageBind).toBeTruthy()
    expect(messageBind!.args.slice(2, 5)).toEqual(['friend@example.com', 'friend@example.com', 'friend@example.com'])
  })

  test('sync applies direction filter when requested', async () => {
    const capturedSqls: string[] = []
    const capturedBinds: Array<{ sql: string; args: unknown[] }> = []
    const db = {
      prepare: mock((sql: string) => {
        capturedSqls.push(sql)
        return {
          bind: mock((...args: unknown[]) => {
            capturedBinds.push({ sql, args })
            return {
              first: mock(() => Promise.resolve({ total: 1 })),
              all: mock(() => Promise.resolve({ results: [makeSyncEmail({ direction: 'inbound' })] })),
            }
          }),
        }
      }),
    } as unknown as D1Database

    const env = singleMailboxEnv('user@test.com', { DB: db })
    const response = await worker.fetch(
      authedRequest('http://localhost/api/sync?to=user@test.com&peer=friend@example.com&direction=inbound&since=1970-01-01T00:00:00Z&limit=3'),
      env,
    )

    expect(response.status).toBe(200)
    const messageQuery = capturedSqls.find((sql) => sql.includes('SELECT * FROM emails'))
    expect(messageQuery).toBeTruthy()
    expect(messageQuery!).toContain('direction = ?')
    const messageBind = capturedBinds.find((entry) => entry.sql.includes('SELECT * FROM emails'))
    expect(messageBind).toBeTruthy()
    expect(messageBind!.args).toContain('inbound')
  })

  test('latest inbound thread returns lightweight inbound thread rows without count or attachment queries', async () => {
    const capturedSqls: string[] = []
    const db = {
      prepare: mock((sql: string) => {
        capturedSqls.push(sql)
        return {
          bind: mock(() => {
            if (sql.includes('FROM users u') && sql.includes('LEFT JOIN chat_groups g')) {
              return {
                first: mock(() => Promise.resolve({ id: 'user-1' })),
                all: mock(() => Promise.resolve({ results: [] })),
                run: mock(() => Promise.resolve({ success: true })),
              }
            }
            return {
              first: mock(() => Promise.resolve(null)),
              all: mock(() => Promise.resolve({
                results: [
                  makeSyncEmail({
                    from_address: 'friend@example.com',
                    peer_address: 'friend@example.com',
                    subject: 'Fresh topic',
                    message_id: '<fresh-topic@test.com>',
                    headers: '{"references":"<older@test.com>"}',
                    direction: 'inbound',
                  }),
                ],
              })),
              run: mock(() => Promise.resolve({ success: true })),
            }
          }),
        }
      }),
    } as unknown as D1Database

    const env = {
      DB: db,
      INTERNAL_API_TOKEN: 'internal-token',
      ACCESS_TOKEN_SECRET: 'test-auth-secret',
    } as Env
    const accessToken = createAccessToken({ sub: 'user-1', email: 'user@test.com', mailbox: 'user@test.com' })
    const response = await worker.fetch(
      new Request('http://localhost/internal/thread-latest-inbound?to=user@test.com&peer=friend@example.com&limit=3', {
        headers: {
          Authorization: 'Bearer internal-token',
          'X-Mailbox': 'user@test.com',
          'X-User-Authorization': `Bearer ${accessToken}`,
        },
      }),
      env,
    )
    const json = await response.json() as {
      emails: Array<{
        subject: string
        message_id: string
        headers: Record<string, string>
        body_text?: string
      }>
    }

    expect(response.status).toBe(200)
    expect(json.emails).toHaveLength(1)
    expect(json.emails[0]?.subject).toBe('Fresh topic')
    expect(json.emails[0]?.message_id).toBe('<fresh-topic@test.com>')
    expect(json.emails[0]?.headers).toEqual({ references: '<older@test.com>' })
    expect(json.emails[0]?.body_text).toBeUndefined()
    expect(capturedSqls.some((sql) => sql.includes('COUNT(*)'))).toBe(false)
    expect(capturedSqls.some((sql) => sql.includes('FROM attachments'))).toBe(false)
  })

  test('latest inbound thread requires peer parameter', async () => {
    const { db } = createSyncMockD1()
    const env = {
      DB: db,
      INTERNAL_API_TOKEN: 'internal-token',
      ACCESS_TOKEN_SECRET: 'test-auth-secret',
    } as Env
    const accessToken = createAccessToken({ sub: 'user-1', email: 'user@test.com', mailbox: 'user@test.com' })

    const response = await worker.fetch(
      new Request('http://localhost/internal/thread-latest-inbound?to=user@test.com', {
        headers: {
          Authorization: 'Bearer internal-token',
          'X-Mailbox': 'user@test.com',
          'X-User-Authorization': `Bearer ${accessToken}`,
        },
      }),
      env,
    )
    const json = await response.json() as { error: string }

    expect(response.status).toBe(400)
    expect(json.error).toBe('Missing ?peer= parameter')
  })

  test('requires auth when AUTH_TOKEN set', async () => {
    const { db } = createSyncMockD1()
    const env: Env = { DB: db, AUTH_TOKEN: 'secret123', MAILBOX: 'user@test.com' }

    // No auth header
    const request = new Request('http://localhost/api/sync?to=user@test.com')
    const response = await worker.fetch(request, env)
    const json = await response.json() as { error: string }

    expect(response.status).toBe(401)
    expect(json.error).toBe('Unauthorized')

    // With correct auth header
    const request2 = new Request('http://localhost/api/sync?to=user@test.com', {
      headers: { Authorization: 'Bearer secret123' },
    })
    const response2 = await worker.fetch(request2, env)
    expect(response2.status).toBe(200)
  })

  test('rejects sync for a different mailbox', async () => {
    const { db } = createSyncMockD1()
    const env = singleMailboxEnv('user@test.com', { DB: db })

    const response = await worker.fetch(
      authedRequest('http://localhost/api/sync?to=other@test.com'),
      env,
    )
    const json = await response.json() as { error: string }

    expect(response.status).toBe(403)
    expect(json.error).toBe('Forbidden')
  })
})
