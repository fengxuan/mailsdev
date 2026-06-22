import { describe, expect, test, beforeEach } from 'bun:test'
import { rmSync, existsSync } from 'node:fs'
import { loadConfig, saveConfig, getConfigValue, setConfigValue, CONFIG_FILE } from '../../src/core/config'

describe('config', () => {
  beforeEach(() => {
    // Reset config to defaults before each test
    saveConfig({
      mode: 'hosted',
      domain: 'mails.dev',
      mailbox: '',
      send_provider: 'zeptomail',
      storage_provider: 'sqlite',
    })
  })

  test('loadConfig returns defaults', () => {
    const config = loadConfig()
    expect(config.mode).toBe('hosted')
    expect(config.domain).toBe('mails.dev')
    expect(config.send_provider).toBe('zeptomail')
    expect(config.storage_provider).toBe('sqlite')
    expect(config.mailbox).toBe('')
  })

  test('saveConfig and loadConfig roundtrip', () => {
    const config = loadConfig()
    config.resend_api_key = 'test_key_abc'
    config.domain = 'example.com'
    saveConfig(config)

    const loaded = loadConfig()
    expect(loaded.resend_api_key).toBe('test_key_abc')
    expect(loaded.domain).toBe('example.com')
  })

  test('getConfigValue returns undefined for unset key', () => {
    const val = getConfigValue('nonexistent_key')
    expect(val).toBeUndefined()
  })

  test('setConfigValue and getConfigValue', () => {
    setConfigValue('resend_api_key', 're_test123')
    expect(getConfigValue('resend_api_key')).toBe('re_test123')
  })

  test('setConfigValue preserves existing values', () => {
    setConfigValue('domain', 'test.com')
    setConfigValue('resend_api_key', 'key123')

    expect(getConfigValue('domain')).toBe('test.com')
    expect(getConfigValue('resend_api_key')).toBe('key123')
    expect(loadConfig().mode).toBe('hosted')
  })

  test('loadConfig returns defaults when config file does not exist', () => {
    // Remove config file to trigger default branch
    if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE)

    const config = loadConfig()
    expect(config.mode).toBe('hosted')
    expect(config.domain).toBe('mails.dev')
    expect(config.storage_provider).toBe('sqlite')
  })
})
