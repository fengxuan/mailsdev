import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { parseIncomingEmail } from '../../worker/src/mime'
import type { Env } from '../../worker/src/index'
import worker from '../../worker/src/index'

const DEFAULT_AUTH_TOKEN = 'unit_test_auth_token'

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

interface RealtimeRoutingFixtures {
  localUsers?: string[]
  directUsersByMailbox?: Record<string, string>
  groupsByMailbox?: Record<string, { id: string; mailbox: string }>
  groupMembersByGroupID?: Record<string, Array<{ user_id: string; member_mailbox: string }>>
}

function createRealtimeRoutingMockD1(fixtures: RealtimeRoutingFixtures = {}) {
  const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase()
  const localUsers = new Set((fixtures.localUsers ?? []).map(normalize))
  const directUsersByMailbox = Object.fromEntries(
    Object.entries(fixtures.directUsersByMailbox ?? {}).map(([mailbox, userID]) => [normalize(mailbox), userID]),
  )
  const groupsByMailbox = Object.fromEntries(
    Object.entries(fixtures.groupsByMailbox ?? {}).map(([mailbox, group]) => [normalize(mailbox), group]),
  )
  const groupMembersByGroupID = fixtures.groupMembersByGroupID ?? {}
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

      if (sql.includes('FROM chat_groups') && sql.includes("WHERE mailbox = ? AND status = 'active'")) {
        return {
          ...defaultResult,
          first: async () => {
            const mailbox = normalize(args[0])
            const group = groupsByMailbox[mailbox]
            return group ? { id: group.id, mailbox: group.mailbox } : null
          },
        }
      }

      if (sql.includes('FROM chat_group_members m') && sql.includes('INNER JOIN users u')) {
        return {
          ...defaultResult,
          all: async () => ({
            results: groupMembersByGroupID[String(args[0] ?? '')] ?? [],
          }),
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

    // Verify D1 insert was called after the local-recipient lookup
    expect(prepareMock).toHaveBeenCalledTimes(2)
    expect(bindMock).toHaveBeenCalledTimes(2)
    const boundArgs = (bindMock as any).mock.calls.at(-1)
    expect(boundArgs[0]).toBe('resend-id-123') // id
    expect(boundArgs[1]).toBe('me@example.com') // mailbox
    expect(boundArgs[2]).toBe('me@example.com') // from_address
    expect(boundArgs[3]).toBe('') // from_name
    expect(boundArgs[4]).toBe('you@example.com') // to_address
    expect(boundArgs[5]).toBe('you@example.com') // peer_address
    expect(boundArgs[6]).toBe('Hello') // subject
    expect(boundArgs[7]).toBe('World') // body_text
    expect(boundArgs[8]).toBe('') // body_html
    expect(boundArgs[9]).toBe(0) // has_attachments
    expect(boundArgs[10]).toBe(0) // attachment_count
    expect(boundArgs[11]).toBe('resend') // provider
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
    const boundArgs = (bindMock as any).mock.calls.at(-1)
    expect(boundArgs[9]).toBe(1) // has_attachments
    expect(boundArgs[10]).toBe(2) // attachment_count
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

    const boundArgs = (bindMock as any).mock.calls.at(-1)
    expect(boundArgs[11]).toBe('ses')
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

    const boundArgs = (bindMock as any).mock.calls.at(-1)
    expect(boundArgs[11]).toBe('cloudflare')
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

  test('local direct send emits inbound and outbound realtime dirty events', async () => {
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
    const byTarget = Object.fromEntries(
      realtimeNotifyBodies.map((body) => [body.target.user_id as string, body]),
    )
    expect(byTarget['user-you']).toBeTruthy()
    expect(byTarget['user-you'].data).toEqual({
      scope: 'direct',
      peer: 'me@example.com',
      direction: 'inbound',
    })
    expect(byTarget['user-me']).toBeTruthy()
    expect(byTarget['user-me'].data).toEqual({
      scope: 'direct',
      peer: 'you@example.com',
      direction: 'outbound',
    })
  })

  test('local group send fans out realtime dirty events to active group members', async () => {
    const { db } = createRealtimeRoutingMockD1({
      localUsers: ['group@example.com'],
      groupsByMailbox: {
        'group@example.com': { id: 'group-1', mailbox: 'group@example.com' },
      },
      groupMembersByGroupID: {
        'group-1': [
          { user_id: 'user-me', member_mailbox: 'me@example.com' },
          { user_id: 'user-member', member_mailbox: 'member@example.com' },
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
      if (url === 'https://realtime.example.com/internal/notify') {
        realtimeNotifyBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
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
    const byTarget = Object.fromEntries(
      realtimeNotifyBodies.map((body) => [body.target.user_id as string, body]),
    )
    expect(byTarget['user-me']).toBeTruthy()
    expect(byTarget['user-me'].data).toEqual({
      scope: 'group',
      peer: 'group@example.com',
      direction: 'outbound',
    })
    expect(byTarget['user-member']).toBeTruthy()
    expect(byTarget['user-member'].data).toEqual({
      scope: 'group',
      peer: 'group@example.com',
      direction: 'inbound',
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

function makeForwardableEmailMessage(input: {
  to: string
  from: string
  subject: string
  bodyText: string
}): ForwardableEmailMessage {
  const raw = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    '',
    input.bodyText,
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
    }),
    raw: stream,
  } as unknown as ForwardableEmailMessage
}

describe('worker: inbound email realtime notify', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('direct inbound email emits direct inbound realtime dirty event', async () => {
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
      subject: 'Hi',
      bodyText: 'Hello',
    })
    const harness = createExecutionContextHarness()
    await worker.email(message, env, harness.ctx)
    await harness.flush()

    expect(realtimeNotifyBodies).toHaveLength(1)
    expect(realtimeNotifyBodies[0]!.target.user_id).toBe('user-recipient')
    expect(realtimeNotifyBodies[0]!.data).toEqual({
      scope: 'direct',
      peer: 'sender@example.com',
      direction: 'inbound',
    })
  })

  test('group inbound email fans out realtime dirty events to active members', async () => {
    const { db } = createRealtimeRoutingMockD1({
      groupsByMailbox: {
        'group@example.com': { id: 'group-1', mailbox: 'group@example.com' },
      },
      groupMembersByGroupID: {
        'group-1': [
          { user_id: 'user-sender', member_mailbox: 'sender@example.com' },
          { user_id: 'user-member', member_mailbox: 'member@example.com' },
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
      if (url === 'https://realtime.example.com/internal/notify') {
        realtimeNotifyBodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
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
    const byTarget = Object.fromEntries(
      realtimeNotifyBodies.map((body) => [body.target.user_id as string, body]),
    )
    expect(byTarget['user-sender'].data).toEqual({
      scope: 'group',
      peer: 'group@example.com',
      direction: 'outbound',
    })
    expect(byTarget['user-member'].data).toEqual({
      scope: 'group',
      peer: 'group@example.com',
      direction: 'inbound',
    })
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
