import { describe, expect, test, mock } from 'bun:test'
import { CloudflareProvider } from '../../worker/src/providers/cloudflare'
import { ResendProvider } from '../../worker/src/providers/resend'
import { ZeptoMailProvider } from '../../worker/src/providers/zeptomail'
import { SESProvider } from '../../worker/src/providers/ses'
import {
  buildProviderChain,
  sendWithChain,
} from '../../worker/src/providers/chain'
import {
  AllProvidersFailedError,
  UnsupportedFeatureError,
  type EmailProvider,
  type ProviderName,
  type SendRequest,
  type SendResult,
} from '../../worker/src/providers/types'

const baseReq = (overrides: Partial<SendRequest> = {}): SendRequest => ({
  from: 'me@example.com',
  to: ['you@example.com'],
  subject: 'Hi',
  text: 'Hello',
  ...overrides,
})

describe('CloudflareProvider.supports', () => {
  const cf = new CloudflareProvider({ send: async () => ({ messageId: 'x' }) })

  test('supports every request (public beta covers all features)', () => {
    expect(cf.supports(baseReq())).toBe(true)
    expect(cf.supports(baseReq({ html: '<p>hi</p>' }))).toBe(true)
    expect(cf.supports(baseReq({ reply_to: 'a@b.com' }))).toBe(true)
    expect(cf.supports(baseReq({ cc: ['c@d.com'], bcc: ['e@f.com'] }))).toBe(true)
    expect(cf.supports(baseReq({ attachments: [{ filename: 'f', content: 'x' }] }))).toBe(true)
  })
})

describe('CloudflareProvider.send', () => {
  test('maps SendRequest to the Cloudflare binding shape', async () => {
    const sendMock = mock(() => Promise.resolve({ messageId: 'cf-42' }))
    const cf = new CloudflareProvider({ send: sendMock })

    const res = await cf.send(baseReq({
      html: '<p>hi</p>',
      reply_to: 'a@b.com',
      cc: ['c@d.com'],
      bcc: ['e@f.com'],
      attachments: [{ filename: 'note.pdf', content: 'AAA', content_type: 'application/pdf' }],
    }))
    expect(res).toEqual({ id: 'cf-42', provider: 'cloudflare' })

    const [msg] = (sendMock as any).mock.calls[0]
    expect(msg.from).toBe('me@example.com')
    expect(msg.to).toBe('you@example.com')
    expect(msg.subject).toBe('Hi')
    expect(msg.text).toBe('Hello')
    expect(msg.html).toBe('<p>hi</p>')
    expect(msg.replyTo).toBe('a@b.com')       // camelCase per CF API
    expect(msg.cc).toEqual(['c@d.com'])
    expect(msg.bcc).toEqual(['e@f.com'])
    expect(msg.attachments).toEqual([{
      content: 'AAA',
      filename: 'note.pdf',
      type: 'application/pdf',               // `type`, not `content_type`
      disposition: 'attachment',
    }])
    expect(msg.reply_to).toBeUndefined()     // must not leak snake_case
  })

  test('passes array when multiple recipients', async () => {
    const sendMock = mock(() => Promise.resolve({ messageId: 'x' }))
    const cf = new CloudflareProvider({ send: sendMock })
    await cf.send(baseReq({ to: ['a@b.com', 'c@d.com'] }))
    const [msg] = (sendMock as any).mock.calls[0]
    expect(msg.to).toEqual(['a@b.com', 'c@d.com'])
  })

  test('defaults attachment type to application/octet-stream when unset', async () => {
    const sendMock = mock(() => Promise.resolve({ messageId: 'x' }))
    const cf = new CloudflareProvider({ send: sendMock })
    await cf.send(baseReq({ attachments: [{ filename: 'bin', content: 'x' }] }))
    const [msg] = (sendMock as any).mock.calls[0]
    expect(msg.attachments[0].type).toBe('application/octet-stream')
  })

  test('accepts legacy `id` field from binding response', async () => {
    const cf = new CloudflareProvider({ send: async () => ({ id: 'legacy-42' }) as any })
    const res = await cf.send(baseReq())
    expect(res.id).toBe('legacy-42')
  })

  test('assigns uuid when binding returns no messageId', async () => {
    const cf = new CloudflareProvider({ send: async () => undefined })
    const res = await cf.send(baseReq())
    expect(res.provider).toBe('cloudflare')
    expect(res.id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('ResendProvider', () => {
  test('supports all requests', () => {
    const r = new ResendProvider('k')
    expect(r.supports(baseReq())).toBe(true)
    expect(r.supports(baseReq({ attachments: [{ filename: 'f', content: 'x' }] }))).toBe(true)
    expect(r.supports(baseReq({ cc: ['c@d.com'], bcc: ['e@f.com'] }))).toBe(true)
  })

  test('posts to Resend API with full body', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(Response.json({ id: 'resend-99' }, { status: 200 })),
    )
    const r = new ResendProvider('kk', fetchMock as unknown as typeof fetch)
    const res = await r.send(baseReq({
      html: '<p>h</p>',
      reply_to: 'a@b.com',
      cc: ['c@d.com'],
      bcc: ['e@f.com'],
      attachments: [{ filename: 'f.pdf', content: 'AAAA', content_type: 'application/pdf' }],
    }))

    expect(res).toEqual({ id: 'resend-99', provider: 'resend' })

    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect((init as RequestInit).method).toBe('POST')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.from).toBe('me@example.com')
    expect(body.to).toEqual(['you@example.com'])
    expect(body.html).toBe('<p>h</p>')
    expect(body.cc).toEqual(['c@d.com'])
    expect(body.bcc).toEqual(['e@f.com'])
    expect(body.attachments[0]).toMatchObject({
      filename: 'f.pdf',
      content: 'AAAA',
      content_type: 'application/pdf',
    })
  })

  test('throws on non-2xx response', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(Response.json({ message: 'domain not verified' }, { status: 403 })),
    )
    const r = new ResendProvider('kk', fetchMock as unknown as typeof fetch)
    await expect(r.send(baseReq())).rejects.toThrow('Resend: domain not verified')
  })
})

describe('ZeptoMailProvider', () => {
  test('supports all requests', () => {
    const z = new ZeptoMailProvider('k')
    expect(z.supports(baseReq())).toBe(true)
    expect(z.supports(baseReq({ attachments: [{ filename: 'f', content: 'x' }] }))).toBe(true)
    expect(z.supports(baseReq({ cc: ['c@d.com'], bcc: ['e@f.com'] }))).toBe(true)
  })

  test('posts to ZeptoMail API with mapped body', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(Response.json({ request_id: 'zepto-99' }, { status: 200 })),
    )
    const z = new ZeptoMailProvider('zk', fetchMock as unknown as typeof fetch)
    const res = await z.send(baseReq({
      html: '<p>h</p>',
      reply_to: 'reply@example.com',
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      headers: { 'In-Reply-To': '<msg@test.com>' },
      attachments: [{ filename: 'f.pdf', content: 'AAAA', content_type: 'application/pdf' }],
    }))

    expect(res).toEqual({ id: 'zepto-99', provider: 'zeptomail' })

    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(url).toBe('https://api.zeptomail.com/v1.1/email')
    expect((init as RequestInit).method).toBe('POST')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.from).toEqual({ address: 'me@example.com' })
    expect(body.to).toEqual([{ email_address: { address: 'you@example.com' } }])
    expect(body.htmlbody).toBe('<p>h</p>')
    expect(body.textbody).toBeUndefined()
    expect(body.reply_to).toEqual([{ address: 'reply@example.com' }])
    expect(body.cc).toEqual([{ email_address: { address: 'cc@example.com' } }])
    expect(body.bcc).toEqual([{ email_address: { address: 'bcc@example.com' } }])
    expect(body.mime_headers).toEqual({ 'In-Reply-To': '<msg@test.com>' })
    expect(body.attachments).toEqual([{
      name: 'f.pdf',
      content: 'AAAA',
      mime_type: 'application/pdf',
    }])
  })

  test('rewrites ZeptoMail from/reply_to when provider-specific sender is configured', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(Response.json({ request_id: 'zepto-fixed-from' }, { status: 200 })),
    )
    const [provider] = buildProviderChain({
      ZEPTOMAIL_API_KEY: 'zk',
      ZEPTOMAIL_FROM_EMAIL: 'chat@yepage.net',
      EMAIL_PROVIDERS: 'zeptomail',
    }, fetchMock as unknown as typeof fetch)

    const res = await sendWithChain([provider!], baseReq({
      from: 'Agent <me@canyin.uk>',
    }))

    expect(res).toEqual({ id: 'zepto-fixed-from', provider: 'zeptomail' })

    const [, init] = (fetchMock as any).mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.from).toEqual({ address: 'chat@yepage.net', name: 'Agent' })
    expect(body.reply_to).toEqual([{ address: 'me@canyin.uk' }])
  })

  test('throws on non-2xx response', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(Response.json({
        error: {
          message: 'sender not verified',
          details: [{ target: 'from.address', message: 'domain mismatch' }],
        },
      }, { status: 403 })),
    )
    const z = new ZeptoMailProvider('zk', fetchMock as unknown as typeof fetch)
    await expect(z.send(baseReq())).rejects.toThrow('ZeptoMail: sender not verified (from.address: domain mismatch)')
  })
})

describe('SESProvider', () => {
  test('supports standard text/html requests but not attachments', () => {
    const ses = new SESProvider({ accessKeyId: 'akid', secretAccessKey: 'secret' }, { region: 'us-east-1' })
    expect(ses.supports(baseReq())).toBe(true)
    expect(ses.supports(baseReq({ html: '<p>hi</p>', cc: ['c@d.com'], bcc: ['e@f.com'] }))).toBe(true)
    expect(ses.supports(baseReq({ attachments: [{ filename: 'f', content: 'x' }] }))).toBe(false)
  })

  test('posts signed request to SES v2 API', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(Response.json({ MessageId: 'ses-123' }, { status: 200 })),
    )
    const ses = new SESProvider({
      accessKeyId: 'akid',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    }, {
      region: 'us-east-1',
      endpoint: 'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails',
    }, fetchMock as unknown as typeof fetch)

    const res = await ses.send(baseReq({
      html: '<p>h</p>',
      reply_to: 'reply@example.com',
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
    }))

    expect(res).toEqual({ id: 'ses-123', provider: 'ses' })

    const [url, init] = (fetchMock as any).mock.calls[0]
    expect(url).toBe('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).headers['x-amz-date']).toBeDefined()
    expect((init as RequestInit).headers['x-amz-content-sha256']).toBeDefined()
    expect((init as RequestInit).headers['x-amz-security-token']).toBe('token')
    expect((init as RequestInit).headers.authorization).toContain('Credential=akid/')
    expect((init as RequestInit).headers.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token')

    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.FromEmailAddress).toBe('me@example.com')
    expect(body.Destination.ToAddresses).toEqual(['you@example.com'])
    expect(body.Destination.CcAddresses).toEqual(['cc@example.com'])
    expect(body.Destination.BccAddresses).toEqual(['bcc@example.com'])
    expect(body.ReplyToAddresses).toEqual(['reply@example.com'])
    expect(body.Content.Simple.Subject.Data).toBe('Hi')
    expect(body.Content.Simple.Body.Text.Data).toBe('Hello')
    expect(body.Content.Simple.Body.Html.Data).toBe('<p>h</p>')
  })

  test('throws on non-2xx response', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(Response.json({ message: 'SignatureDoesNotMatch' }, { status: 403 })),
    )
    const ses = new SESProvider({ accessKeyId: 'akid', secretAccessKey: 'secret' }, { region: 'us-east-1' }, fetchMock as unknown as typeof fetch)
    await expect(ses.send(baseReq())).rejects.toThrow('SES: SignatureDoesNotMatch')
  })
})

describe('buildProviderChain', () => {
  test('defaults to cloudflare,zeptomail,resend,ses order with configured providers only', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({ id: 'x' }) },
      RESEND_API_KEY: 'k',
      ZEPTOMAIL_API_KEY: 'z',
      AWS_SES_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'secret',
    })
    expect(chain.map(p => p.name)).toEqual(['cloudflare', 'zeptomail', 'resend', 'ses'])
  })

  test('includes ses when configured explicitly', () => {
    const chain = buildProviderChain({
      AWS_SES_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'secret',
      EMAIL_PROVIDERS: 'ses',
    })
    expect(chain.map(p => p.name)).toEqual(['ses'])
  })

  test('skips ses when credentials are incomplete', () => {
    const chain = buildProviderChain({
      AWS_SES_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'akid',
      EMAIL_PROVIDERS: 'ses,resend',
      RESEND_API_KEY: 'k',
    })
    expect(chain.map(p => p.name)).toEqual(['resend'])
  })

  test('skips cloudflare when no binding', () => {
    const chain = buildProviderChain({ RESEND_API_KEY: 'k' })
    expect(chain.map(p => p.name)).toEqual(['resend'])
  })

  test('includes zeptomail when it is the only configured provider', () => {
    const chain = buildProviderChain({ ZEPTOMAIL_API_KEY: 'z' })
    expect(chain.map(p => p.name)).toEqual(['zeptomail'])
  })

  test('skips resend when no api key but still uses later configured defaults', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({}) },
      AWS_SES_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'secret',
    })
    expect(chain.map(p => p.name)).toEqual(['cloudflare', 'ses'])
  })

  test('empty chain when nothing configured', () => {
    const chain = buildProviderChain({})
    expect(chain).toEqual([])
  })

  test('EMAIL_PROVIDERS=resend forces single provider', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({}) },
      RESEND_API_KEY: 'k',
      EMAIL_PROVIDERS: 'resend',
    })
    expect(chain.map(p => p.name)).toEqual(['resend'])
  })

  test('EMAIL_PROVIDERS reverses order', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({}) },
      RESEND_API_KEY: 'k',
      ZEPTOMAIL_API_KEY: 'z',
      AWS_SES_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'secret',
      EMAIL_PROVIDERS: 'ses,zeptomail,resend,cloudflare',
    })
    expect(chain.map(p => p.name)).toEqual(['ses', 'zeptomail', 'resend', 'cloudflare'])
  })

  test('EMAIL_PROVIDERS dedupes and ignores unknown', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({}) },
      RESEND_API_KEY: 'k',
      ZEPTOMAIL_API_KEY: 'z',
      AWS_SES_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'secret',
      EMAIL_PROVIDERS: 'ses,zeptomail,resend,zeptomail, bogus, cloudflare, ses',
    })
    expect(chain.map(p => p.name)).toEqual(['ses', 'zeptomail', 'resend', 'cloudflare'])
  })

  test('EMAIL_PROVIDERS empty string falls back to default', () => {
    const chain = buildProviderChain({
      EMAIL: { send: async () => ({}) },
      RESEND_API_KEY: 'k',
      ZEPTOMAIL_API_KEY: 'z',
      AWS_SES_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'akid',
      AWS_SECRET_ACCESS_KEY: 'secret',
      EMAIL_PROVIDERS: '',
    })
    expect(chain.map(p => p.name)).toEqual(['cloudflare', 'zeptomail', 'resend', 'ses'])
  })
})

describe('sendWithChain', () => {
  const makeProvider = (
    name: ProviderName,
    opts: { supports?: boolean; send?: () => Promise<SendResult> } = {},
  ): EmailProvider => ({
    name,
    supports: () => opts.supports ?? true,
    send: opts.send ?? (() => Promise.resolve({ id: `${name}-ok`, provider: name })),
  })

  test('throws when chain empty', async () => {
    await expect(sendWithChain([], baseReq())).rejects.toThrow('No email provider configured')
  })

  test('returns first successful provider', async () => {
    const cf = makeProvider('cloudflare')
    const rs = makeProvider('resend')
    const res = await sendWithChain([cf, rs], baseReq())
    expect(res).toEqual({ id: 'cloudflare-ok', provider: 'cloudflare' })
  })

  test('skips providers that do not support the request', async () => {
    const cf = makeProvider('cloudflare', { supports: false })
    const rs = makeProvider('resend')
    const res = await sendWithChain([cf, rs], baseReq({ attachments: [{ filename: 'x', content: 'y' }] }))
    expect(res.provider).toBe('resend')
  })

  test('falls back when primary throws', async () => {
    const originalWarn = console.warn
    const warnMock = mock(() => {})
    console.warn = warnMock as typeof console.warn

    const cf = makeProvider('cloudflare', {
      send: () => Promise.reject(new Error('binding exploded')),
    })
    const rs = makeProvider('resend')
    try {
      const res = await sendWithChain([cf, rs], baseReq())
      expect(res.provider).toBe('resend')
      expect(warnMock).toHaveBeenCalledTimes(1)
      expect(String((warnMock as any).mock.calls[0][0])).toContain('"event":"outbound_provider_failed"')
      expect(String((warnMock as any).mock.calls[0][0])).toContain('"provider":"cloudflare"')
      expect(String((warnMock as any).mock.calls[0][0])).toContain('binding exploded')
    } finally {
      console.warn = originalWarn
    }
  })

  test('throws UnsupportedFeatureError when no provider supports request', async () => {
    const cf = makeProvider('cloudflare', { supports: false })
    await expect(
      sendWithChain([cf], baseReq({ attachments: [{ filename: 'x', content: 'y' }] })),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError)
  })

  test('throws AllProvidersFailedError with attempts when all fail', async () => {
    const cf = makeProvider('cloudflare', { send: () => Promise.reject(new Error('cf down')) })
    const rs = makeProvider('resend', { send: () => Promise.reject(new Error('resend down')) })
    try {
      await sendWithChain([cf, rs], baseReq())
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(AllProvidersFailedError)
      const e = err as AllProvidersFailedError
      expect(e.attempts).toHaveLength(2)
      expect(e.attempts[0]).toEqual({ provider: 'cloudflare', error: 'cf down' })
      expect(e.attempts[1]).toEqual({ provider: 'resend', error: 'resend down' })
    }
  })
})
