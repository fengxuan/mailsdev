import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { send } from '../../src/core/send'
import { saveConfig } from '../../src/core/config'
import type { MailsConfig } from '../../src/core/types'

const BASE_CONFIG: MailsConfig = {
  mode: 'hosted',
  domain: 'mails.dev',
  mailbox: '',
  send_provider: 'zeptomail',
  storage_provider: 'sqlite',
  resend_api_key: 're_test',
  default_from: 'Bot <bot@test.com>',
}

describe('send', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    saveConfig({ ...BASE_CONFIG })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    saveConfig({ ...BASE_CONFIG })
  })

  test('sends email using config', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: 'msg_1' }))
    }) as typeof fetch

    const result = await send({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'World',
    })

    expect(result.id).toBe('msg_1')
    expect(result.provider).toBe('resend')
  })

  test('uses explicit from over default_from', async () => {
    let sentFrom = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      sentFrom = body.from
      return new Response(JSON.stringify({ id: 'msg_2' }))
    }) as typeof fetch

    await send({
      from: 'Custom <custom@test.com>',
      to: 'user@example.com',
      subject: 'Test',
      text: 'body',
    })

    expect(sentFrom).toBe('Custom <custom@test.com>')
  })

  test('throws when no resend_api_key', async () => {
    saveConfig({ ...BASE_CONFIG, resend_api_key: undefined, send_provider: 'resend' })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('resend_api_key not configured')
  })

  test('uses zeptomail when only zeptomail_api_key is configured', async () => {
    saveConfig({
      ...BASE_CONFIG,
      resend_api_key: undefined,
      zeptomail_api_key: 'zt_test_key',
    })

    let sentBody: Record<string, unknown> = {}
    let sentHeaders: Record<string, string> = {}
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>
      sentBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ request_id: 'zepto_1' }))
    }) as typeof fetch

    const result = await send({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'World',
    })

    expect(sentHeaders['Authorization']).toBe('Zoho-enczapikey zt_test_key')
    expect(sentBody.from).toEqual({
      address: 'bot@test.com',
      name: 'Bot',
    })
    expect(sentBody.to).toEqual([
      { email_address: { address: 'user@example.com' } },
    ])
    expect(sentBody.textbody).toBe('World')
    expect(result).toEqual({ id: 'zepto_1', provider: 'zeptomail' })
  })

  test('prefers zeptomail by default when both provider keys are configured', async () => {
    saveConfig({
      ...BASE_CONFIG,
      resend_api_key: 're_should_not_use',
      zeptomail_api_key: 'zt_default_priority',
    })

    let authHeader = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      authHeader = (init.headers as Record<string, string>)['Authorization']
      return new Response(JSON.stringify({ request_id: 'zepto_default' }))
    }) as typeof fetch

    const result = await send({ to: 'user@example.com', subject: 'Default priority', text: 'test' })
    expect(authHeader).toBe('Zoho-enczapikey zt_default_priority')
    expect(result.provider).toBe('zeptomail')
  })

  test('throws when no from address', async () => {
    saveConfig({ ...BASE_CONFIG, default_from: undefined })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('No "from" address')
  })

  test('throws when no body', async () => {
    expect(
      send({ to: 'a@b.com', subject: 'Test' })
    ).rejects.toThrow('Either text or html body is required')
  })

  test('accepts string or array for to', async () => {
    let sentTo: string[] = []
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      sentTo = body.to
      return new Response(JSON.stringify({ id: 'msg_3' }))
    }) as typeof fetch

    await send({ to: 'single@test.com', subject: 'Test', text: 'hi' })
    expect(sentTo).toEqual(['single@test.com'])

    await send({ to: ['a@test.com', 'b@test.com'], subject: 'Test', text: 'hi' })
    expect(sentTo).toEqual(['a@test.com', 'b@test.com'])
  })

  test('throws when no provider configured', async () => {
    saveConfig({ ...BASE_CONFIG, send_provider: 'unknown', resend_api_key: undefined, api_key: undefined })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('No send provider configured')
  })

  test('uses hosted provider when api_key set and no resend_api_key', async () => {
    saveConfig({
      ...BASE_CONFIG,
      resend_api_key: undefined,
      api_key: 'mk_hosted_test',
      default_from: 'agent@mails.dev',
    })

    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)['Authorization']
      expect(auth).toBe('Bearer mk_hosted_test')
      return new Response(JSON.stringify({ id: 'hosted_1', sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const result = await send({ to: 'user@example.com', subject: 'Hosted', text: 'test' })
    expect(result.id).toBe('hosted_1')
    expect(result.provider).toBe('mails.dev')
  })

  test('api_key takes priority over resend_api_key', async () => {
    saveConfig({
      ...BASE_CONFIG,
      resend_api_key: 're_should_not_use',
      api_key: 'mk_priority',
      default_from: 'agent@mails.dev',
    })

    let usedUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      usedUrl = url
      return new Response(JSON.stringify({ id: 'hosted_priority', sends_this_month: 1, monthly_limit: 100 }))
    }) as typeof fetch

    const result = await send({ to: 'user@example.com', subject: 'Priority', text: 'test' })
    expect(usedUrl).toContain('/v1/send')
    expect(result.provider).toBe('mails.dev')
  })

  test('throws resend_api_key error when explicitly set as provider without key', async () => {
    saveConfig({ ...BASE_CONFIG, resend_api_key: undefined, api_key: undefined, send_provider: 'resend' })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('resend_api_key not configured')
  })

  test('prefers zeptomail when send_provider=zeptomail', async () => {
    saveConfig({
      ...BASE_CONFIG,
      resend_api_key: 're_should_not_use',
      zeptomail_api_key: 'zt_preferred',
      send_provider: 'zeptomail',
    })

    let authHeader = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      authHeader = (init.headers as Record<string, string>)['Authorization']
      return new Response(JSON.stringify({ request_id: 'zepto_preferred' }))
    }) as typeof fetch

    const result = await send({ to: 'user@example.com', subject: 'Preferred', text: 'test' })
    expect(authHeader).toBe('Zoho-enczapikey zt_preferred')
    expect(result.provider).toBe('zeptomail')
  })

  test('throws zeptomail_api_key error when explicitly set as provider without key', async () => {
    saveConfig({
      ...BASE_CONFIG,
      resend_api_key: undefined,
      zeptomail_api_key: undefined,
      api_key: undefined,
      send_provider: 'zeptomail',
    })

    expect(
      send({ to: 'a@b.com', subject: 'Test', text: 'hi' })
    ).rejects.toThrow('zeptomail_api_key not configured')
  })

  test('uses OSS provider when worker_url is configured', async () => {
    saveConfig({ ...BASE_CONFIG, resend_api_key: undefined, worker_url: 'https://my-worker.example.com', worker_token: 'tok123' })

    let requestUrl = ''
    let authHeader = ''
    let requestBody: Record<string, unknown> = {}

    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      requestUrl = url
      authHeader = (init.headers as Record<string, string>)['Authorization']
      requestBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ id: 'oss_msg_1' }))
    }) as typeof fetch

    const result = await send({ to: 'user@example.com', subject: 'OSS Test', text: 'hello from oss' })

    expect(result.id).toBe('oss_msg_1')
    expect(result.provider).toBe('oss')
    expect(requestUrl).toBe('https://my-worker.example.com/api/send')
    expect(authHeader).toBe('Bearer tok123')
    expect(requestBody.from).toBe('Bot <bot@test.com>')
    expect(requestBody.to).toEqual(['user@example.com'])
    expect(requestBody.subject).toBe('OSS Test')
    expect(requestBody.text).toBe('hello from oss')
  })

  test('worker_url takes priority over resend_api_key', async () => {
    saveConfig({
      ...BASE_CONFIG,
      resend_api_key: 're_should_not_use',
      worker_url: 'https://my-worker.example.com',
      worker_token: 'tok_priority',
    })

    let requestUrl = ''
    globalThis.fetch = mock(async (url: string) => {
      requestUrl = url
      return new Response(JSON.stringify({ id: 'oss_priority' }))
    }) as typeof fetch

    const result = await send({ to: 'user@example.com', subject: 'Priority', text: 'test' })
    expect(requestUrl).toContain('/api/send')
    expect(result.provider).toBe('oss')
  })

  test('throws when worker_url is configured without worker_token', async () => {
    saveConfig({ ...BASE_CONFIG, resend_api_key: undefined, worker_url: 'https://my-worker.example.com' })

    expect(
      send({ to: 'user@example.com', subject: 'Missing token', text: 'test' })
    ).rejects.toThrow('worker_token not configured')
  })
})
