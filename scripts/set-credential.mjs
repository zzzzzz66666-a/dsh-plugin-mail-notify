#!/usr/bin/env node
/**
 * Store the mailbox authorization code in the harness credential store.
 *
 * This is a separate step from `configure.mjs` on purpose: the authorization
 * code is a secret, and the person who owns it should type it themselves. The
 * value is read from the terminal (or from a pipe), written straight into the
 * credential document, and never echoed — not in the confirmation, not in the
 * error messages, not in the authentication report.
 *
 * @module scripts/set-credential
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ImapMailReceiver } from '../lib/mail/imap.js'
import { SmtpMailSender } from '../lib/mail/smtp.js'
import { AUTH_CODE_REF, readCredentialRef, readPluginRowConfig, upsertCredentialRef } from './lib/profile-edit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=')
    if (name.startsWith('no-')) {
      flags[name.slice(3)] = false
      continue
    }
    const next = argv[index + 1]
    if (inline !== undefined) flags[name] = inline
    else if (next === undefined || next.startsWith('--')) flags[name] = true
    else {
      flags[name] = next
      index += 1
    }
  }
  return flags
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

/** Read the code from a terminal prompt, or the first line of a pipe. */
async function readCode() {
  if (process.stdin.isTTY) {
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = await new Promise((resolve) => rl.question('Mailbox authorization code: ', resolve))
      return String(answer ?? '').trim()
    } finally {
      rl.close()
    }
  }
  try {
    return readFileSync(0, 'utf8').split(/\r?\n/)[0].trim()
  } catch {
    return ''
  }
}

/** Strip anything that looks like the code out of text that is about to be printed. */
function redact(text, code) {
  let result = String(text ?? '')
  if (code) result = result.split(code).join('[REDACTED]')
  return result
}

/** Authenticate against SMTP and IMAP using the installed configuration. */
async function checkAuthentication(config, code) {
  const results = []
  const smtp = new SmtpMailSender({
    host: config.smtpHost,
    port: Number(config.smtpPort),
    security: config.smtpSecurity,
    username: config.senderEmail,
    password: code,
  })
  try {
    await smtp.test()
    results.push({ channel: 'SMTP', ok: true })
  } catch (error) {
    results.push({ channel: 'SMTP', ok: false, category: error?.category ?? 'mail_error', detail: error?.message })
  }

  const imap = new ImapMailReceiver({
    host: config.imapHost,
    port: Number(config.imapPort),
    security: config.imapSecurity,
    username: config.senderEmail,
    password: code,
    mailbox: config.imapMailbox || 'INBOX',
  })
  try {
    await imap.testConnection()
    results.push({ channel: 'IMAP', ok: true })
  } catch (error) {
    results.push({ channel: 'IMAP', ok: false, category: error?.category ?? 'mail_error', detail: error?.message })
  }
  return results
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const home = flags.home || process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = resolve(flags.profile || join(home, 'profiles', 'desktop'))
  const credentialsPath = resolve(flags.credentials || join(home, '.credentials.yaml'))
  const shouldCheck = flags.check !== false

  if (flags.help) {
    process.stdout.write(
      [
        'Usage: node scripts/set-credential.mjs [options]',
        '',
        '  Reads the mailbox authorization code from the terminal (or stdin) and',
        `  stores it as the credential reference ${AUTH_CODE_REF}.`,
        '',
        '  --check-only              re-test the already stored code; store nothing',
        '  --no-check                skip the SMTP/IMAP authentication check',
        '  --profile <dir>           profile holding the plugin row',
        '  --home <dir>              harness home (default: $DSH_HOME or ~/.dsh)',
        '  --credentials <file>      credential store file',
        '',
        '  PowerShell, from a file:  Get-Content .\\code.txt | node scripts\\set-credential.mjs',
        '',
      ].join('\n'),
    )
    return
  }

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) fail(`profile patch not found: ${patchPath}`)
  const config = readPluginRowConfig(readFileSync(patchPath, 'utf8'))
  if (!config || !config.senderEmail) {
    fail(`the plugin row in ${patchPath} carries no mailbox configuration yet;\n` +
      '       run: node scripts/configure.mjs --sender <your address> --no-credential')
  }

  const storedText = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : ''

  // `--check-only` re-tests whatever is already stored, so a mail failure later
  // can be told apart from a wrong or revoked authorization code without
  // re-typing the secret.
  if (flags['check-only']) {
    const stored = readCredentialRef(storedText, AUTH_CODE_REF)
    if (!stored) fail(`no stored value for ${AUTH_CODE_REF} in ${credentialsPath}`)
    const failed = await report(config, stored)
    process.exit(failed ? 1 : 0)
  }

  const code = await readCode()
  if (!code) fail('no authorization code supplied')
  if (/[\r\n]/.test(code)) fail('the authorization code must be a single line')

  const alreadyStored = new RegExp(`^\\s+${AUTH_CODE_REF}\\s*:`, 'm').test(storedText)
  const next = upsertCredentialRef(storedText, AUTH_CODE_REF, code)

  if (flags['dry-run']) {
    process.stdout.write(
      `${alreadyStored ? 'would replace' : 'would add'} refs.${AUTH_CODE_REF} in ${credentialsPath}\n` +
        '(the file itself is not printed: it holds every stored credential)\n',
    )
    return
  }

  if (existsSync(credentialsPath)) {
    const backup = `${credentialsPath}.mail-notify-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(credentialsPath, backup)
    process.stdout.write(`backup   ${backup}\n`)
  }
  writeFileSync(credentialsPath, next, 'utf8')
  process.stdout.write(`${alreadyStored ? 'replaced' : 'stored'} ${AUTH_CODE_REF} in ${credentialsPath}\n`)

  if (!shouldCheck) return

  const failed = await report(config, code)
  if (failed) {
    process.stdout.write(
      '\nThe credential is stored, but at least one login failed.\n' +
        'For QQ mail: enable SMTP/IMAP in 设置 → 账户, then use the generated 授权码 (not your account password).\n' +
        'Fix it and run this script again, or clear it with: node scripts/uninstall.mjs --remove-credential\n',
    )
    process.exit(1)
  }
  process.stdout.write('\nBoth logins succeeded. Restart DeepSeek Harness to load the plugin.\n')
}

/**
 * Authenticate both channels and print only pass/fail per channel.
 *
 * @returns {Promise<boolean>} whether either channel failed.
 */
async function report(config, code) {
  process.stdout.write(`\nchecking ${config.senderEmail} against ${config.smtpHost} and ${config.imapHost}...\n`)
  const results = await checkAuthentication(config, code)
  let failed = false
  for (const result of results) {
    if (result.ok) {
      process.stdout.write(`ok    ${result.channel} login\n`)
      continue
    }
    failed = true
    const detail =
      result.category === 'authentication' ? 'the authorization code was rejected' : redact(result.detail, code)
    process.stdout.write(`FAIL  ${result.channel} login — ${result.category}: ${detail}\n`)
  }
  return failed
}

main().catch((error) => fail(error?.stack ?? String(error)))
