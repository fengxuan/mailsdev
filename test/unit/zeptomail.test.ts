import { describe, expect, test, mock, afterEach } from 'bun:test'
import { createZeptoMailProvider } from '../../src/providers/send/zeptomail'

describe('ZeptoMail provider', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('sends email successfully', async () => {
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.zeptomail.eu/v1.1/email')
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({
        Accept: 'application/json',
        Authorization: 'Zoho-enczapikey zt_test_key',
        'Content-Type': 'application/json',
      })

      const body = JSON.parse(init.body as string)
      expect(body.from).toEqual({
        address: 'agent@test.com',
        name: 'Agent',
      })
      expect(body.to).toEqual([
        { email_address: { address: 'user@example.com' } },
      ])
      expect(body.subject).toBe('Test')
      expect(body.textbody).toBe('Hello')

      return new Response(JSON.stringify({ request_id: 'zepto_req_123' }), { status: 200 })
    }) as typeof fetch

    const provider = createZeptoMailProvider('zt_test_key', 'https://api.zeptomail.eu')
    const result = await provider.send({
      from: 'Agent <agent@test.com>',
      to: ['user@example.com'],
      subject: 'Test',
      text: 'Hello',
    })

    expect(result).toEqual({ id: 'zepto_req_123', provider: 'zeptomail' })
  })

  test('maps html, replyTo, headers, attachments, and inline images', async () => {
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      expect(body.htmlbody).toBe('<h1>Hi</h1>')
      expect(body.textbody).toBeUndefined()
      expect(body.reply_to).toEqual([
        { address: 'reply@test.com', name: 'Reply' },
      ])
      expect(body.mime_headers).toEqual({
        'In-Reply-To': '<msg-123@test.com>',
      })
      expect(body.attachments).toEqual([
        {
          name: 'invoice.txt',
          content: Buffer.from('invoice-42').toString('base64'),
          mime_type: 'text/plain',
        },
      ])
      expect(body.inline_images).toEqual([
        {
          name: 'logo.png',
          content: Buffer.from('png-data').toString('base64'),
          mime_type: 'image/png',
          cid: 'logo-cid',
        },
      ])
      return new Response(JSON.stringify({ request_id: 'zepto_req_inline' }), { status: 200 })
    }) as typeof fetch

    const provider = createZeptoMailProvider('zt_key')
    await provider.send({
      from: 'a@b.com',
      to: ['c@d.com'],
      subject: 'HTML',
      text: 'plain fallback',
      html: '<h1>Hi</h1>',
      replyTo: 'Reply <reply@test.com>',
      headers: {
        'In-Reply-To': '<msg-123@test.com>',
      },
      attachments: [
        {
          filename: 'invoice.txt',
          content: Buffer.from('invoice-42').toString('base64'),
          contentType: 'text/plain',
        },
        {
          filename: 'logo.png',
          content: Buffer.from('png-data').toString('base64'),
          contentType: 'image/png',
          contentId: 'logo-cid',
        },
      ],
    })
  })

  test('throws on API error', async () => {
    globalThis.fetch = mock(async () => (
      new Response(JSON.stringify({
        error: {
          message: 'Invalid input',
          details: [
            { target: 'from.address', message: 'sender not verified' },
          ],
        },
      }), { status: 400 })
    )) as typeof fetch

    const provider = createZeptoMailProvider('bad_key')
    expect(
      provider.send({ from: 'a@b.com', to: ['c@d.com'], subject: 'Test', text: 'hi' }),
    ).rejects.toThrow('ZeptoMail error: Invalid input (from.address: sender not verified)')
  })
})
