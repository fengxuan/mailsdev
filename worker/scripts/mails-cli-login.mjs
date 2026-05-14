#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const DEFAULT_API_BASE_URL = 'https://mails-chat-api.lineme.workers.dev'
const DEFAULT_WORKER_URL = 'https://mails-worker.lineme.workers.dev'
const CONFIG_DIR = join(homedir(), '.mails')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const email = required(args.email, '--email is required')
  const apiBaseUrl = (args['api-base-url'] ?? DEFAULT_API_BASE_URL).trim().replace(/\/$/, '')
  const workerUrl = (args['worker-url'] ?? DEFAULT_WORKER_URL).trim().replace(/\/$/, '')
  const label = (args.label ?? 'mails-cli').trim()

  let code = trimToNull(args.code)
  let mailboxHint = null

  if (!code) {
    const registerResponse = await postJson(`${apiBaseUrl}/api/auth/register`, { email })
    mailboxHint = trimToNull(registerResponse.mailbox)
    console.log(`Verification code sent to ${email}`)
    if (mailboxHint) {
      console.log(`Assigned mailbox = ${mailboxHint}`)
    }
    code = await promptForCode()
  }

  const verify = await postJson(`${apiBaseUrl}/api/auth/verify`, {
    email,
    code,
    device_name: label,
  })
  const accessToken = required(verify.access_token, 'verify response missing access_token')

  const cliTokenResponse = await postJson(
    `${apiBaseUrl}/api/auth/cli-token`,
    { label },
    { Authorization: `Bearer ${accessToken}` },
  )

  const mailbox = required(cliTokenResponse.mailbox, 'cli-token response missing mailbox')
  const workerToken = required(cliTokenResponse.token, 'cli-token response missing token')
  const expiresAt = required(cliTokenResponse.expires_at, 'cli-token response missing expires_at')

  const config = loadConfig()
  config.worker_url = workerUrl
  config.worker_token = workerToken
  config.mailbox = mailbox
  config.default_from = mailbox
  delete config.api_key
  delete config.token

  saveConfig(config)

  console.log(`Configured mails CLI for ${mailbox}`)
  console.log(`worker_url = ${workerUrl}`)
  console.log(`worker_token = ${mask(workerToken)}`)
  console.log(`expires_at = ${expiresAt}`)
  console.log(`config = ${CONFIG_PATH}`)
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg?.startsWith('--')) continue
    const key = arg.slice(2)
    const value = argv[index + 1]
    if (value && !value.startsWith('--')) {
      args[key] = value
      index += 1
    } else {
      args[key] = 'true'
    }
  }
  return args
}

function required(value, message) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new Error(message)
  }
  return normalized
}

function trimToNull(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

async function promptForCode() {
  const rl = readline.createInterface({ input, output })
  try {
    const value = await rl.question('Enter verification code: ')
    return required(value, 'verification code is required')
  } finally {
    rl.close()
  }
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.error ?? response.statusText
    throw new Error(`${url} failed (${response.status}): ${message}`)
  }

  return payload ?? {}
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {
      mode: 'hosted',
      domain: 'mails.dev',
      send_provider: 'resend',
      storage_provider: 'remote',
    }
  }
}

function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

function mask(value) {
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
