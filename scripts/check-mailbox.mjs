#!/usr/bin/env node
/**
 * Read-only mailbox diagnostic: what does the plugin actually see?
 *
 * Answers the question that is otherwise invisible: *is my reply even being
 * found?* It runs the same search and the same validator the plugin uses, then
 * reports the verdict — **without consuming the one-time code, without marking
 * anything read, and without sending or submitting anything**. Message bodies
 * are never printed; only the verdict, the task id and the token's state.
 *
 * Two failures it was written to catch, both of which are silent in the audit
 * log: a search that cannot see the message at all (it arrived already read, so
 * an unseen-only search misses it), and a body whose task id or code the
 * validator cannot parse.
 *
 * @module scripts/check-mailbox
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { ImapMailReceiver, buildSearchCriteria } from '../lib/mail/imap.js'
import { ReplyValidator, TokenStore } from '../lib/replies.js'
import { credentialsFilePath } from '../lib/secrets.js'
import { AUTH_CODE_REF, readCredentialRef, readPluginRowConfig } from './lib/profile-edit.mjs'

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=')
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

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const home = flags.home || process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = resolve(flags.profile || join(home, 'profiles', 'desktop'))
  const dataDir = resolve(flags['data-dir'] || join(home, 'mail-notify'))
  const credentialsPath = resolve(flags.credentials || credentialsFilePath({ DSH_HOME: home }))

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) fail(`profile patch not found: ${patchPath}`)
  const config = readPluginRowConfig(readFileSync(patchPath, 'utf8'))
  if (!config?.senderEmail) fail(`the plugin row in ${patchPath} carries no mailbox configuration`)

  if (!existsSync(credentialsPath)) fail(`credentials file not found: ${credentialsPath}`)
  const code = readCredentialRef(readFileSync(credentialsPath, 'utf8'), AUTH_CODE_REF)
  if (!code) fail(`no stored value for ${AUTH_CODE_REF} in ${credentialsPath}`)

  const tokensPath = join(dataDir, 'tokens.json')
  const tokens = new TokenStore({ path: existsSync(tokensPath) ? tokensPath : null })

  const criteria = buildSearchCriteria({ subjectTag: config.subjectPrefix, lookbackDays: 3 })
  console.log(`邮箱      : ${config.senderEmail}`)
  console.log(`IMAP      : ${config.imapHost}:${config.imapPort} (${config.imapSecurity}), 邮箱夹 ${config.imapMailbox || 'INBOX'}`)
  console.log(`搜索条件  : ${criteria.join(' ')}`)
  console.log(`允许回复  : ${config.allowedReplyEmail}`)
  console.log('')

  const receiver = new ImapMailReceiver({
    host: config.imapHost,
    port: Number(config.imapPort),
    security: config.imapSecurity,
    username: config.senderEmail,
    password: code,
    mailbox: config.imapMailbox || 'INBOX',
    searchCriteria: criteria,
    maxPerPoll: Number(flags.limit) || 50,
  })

  const messages = await receiver.receive()
  const ours = messages.filter((message) => message.isNotification)
  const replies = messages.filter((message) => !message.isNotification)

  console.log(`匹配到 ${messages.length} 封：其中我们自己的通知 ${ours.length} 封，其余 ${replies.length} 封`)
  console.log('')

  if (replies.length === 0) {
    console.log('没有找到任何回复邮件。')
    console.log('如果你确实回复过，最可能的原因是搜索条件看不到它——')
    console.log('例如它早于 3 天窗口，或者主题里没有队列标签。')
    return
  }

  // A fresh seen-set: this is a diagnostic, not the live pipeline, and a
  // message the plugin already handled should still be reported on its merits.
  const validator = new ReplyValidator({
    allowedSender: config.allowedReplyEmail,
    tokenStore: tokens,
    seenMessageIds: new Set(),
    maxLength: Number(config.maxReplyLength) || 8000,
  })

  console.log('逐封判定（不会消耗验证码，不会标记已读）：')
  for (const message of replies) {
    const verdict = validator.validate(
      {
        messageId: message.messageId,
        sender: message.sender,
        subject: message.subject,
        text: message.text,
        html: message.html,
        hasAttachments: message.hasAttachments,
        receivedAt: message.receivedAt,
      },
      { dryRun: true },
    )
    const accepted = verdict.verificationStatus === 'accepted'
    console.log('')
    console.log(`  ${accepted ? '✅ 会被接受' : `❌ 会被拒绝（${verdict.rejectionReason}）`}`)
    console.log(`  主题    : ${message.subject}`)
    console.log(`  发件人  : ${message.sender}`)
    console.log(`  时间    : ${message.receivedAt.toISOString()}`)
    console.log(`  清理后正文长度: ${verdict.body.length} 字符`)
    if (accepted) {
      const record = tokens.records.get(verdict.taskId)
      console.log(`  任务编号: ${verdict.taskId}`)
      console.log(`  验证码  : 有效，将于 ${record?.expiresAt ?? '(未知)'} 过期`)
    }
  }

  console.log('')
  console.log('提示：被拒绝的邮件会一直留在收件箱里且保持未读状态，因此每轮都会重新取出——')
  console.log('      已检查过的会静默跳过，不会再刷审计日志。')
}

main().catch((error) => fail(error?.stack ?? String(error)))
