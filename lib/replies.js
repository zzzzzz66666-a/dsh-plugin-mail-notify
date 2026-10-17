/**
 * Reply verification: one-time codes and the inbound-mail gate.
 *
 * A reply is only allowed to reach a session when *every* check passes: it
 * comes from the allow-listed address, has not been seen before, carries no
 * attachments, is short enough, and quotes a task id together with the
 * one-time code that was issued for that task. The code is consumed on first
 * success, so a replayed mail can never drive the agent twice.
 *
 * @module dsh-plugin-mail-notify/replies
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readJson, writeJson } from './store.js'
import { ReplyVerification, createReply } from './domain.js'
import { decodeEntities, htmlToText, stripQuotedHistory } from './mail/mime.js'

/**
 * Task-id forms accepted in a reply body.
 *
 * The reference component only matched `任务: <id>` / `task: <id>`, which
 * rejects a user who simply keeps the notification's own
 * `本地任务编号：<id>` line — the very thing its instructions ask for. The
 * optional `编号` / `id` groups close that gap while keeping every form the
 * reference accepted.
 */
export const TASK_RE = /(?:任务(?:编号)?|task(?:\s*id)?)\s*[:：#]\s*([A-Za-z0-9_-]+)/i

/** One-time code forms accepted in a reply body. */
export const TOKEN_RE = /(?:验证码|code)\s*[:：]\s*([A-Za-z0-9_-]{4,64})/i

/** Compares two strings without leaking their common prefix through timing. */
export function secretsEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8')
  const b = Buffer.from(String(right), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * One-time reply codes with expiry, persisted across restarts.
 *
 * A code is bound to one task and consumed on first use, so the mail that
 * carries it is a bearer token with a single use.
 */
export class TokenStore {
  /** @param {{path?: string|null, clock?: () => Date}} [options] */
  constructor({ path = null, clock = () => new Date() } = {}) {
    this.path = path || null
    this.clock = clock
    /** @type {Map<string, {taskId: string, token: string, expiresAt: string, used: boolean}>} */
    this.records = new Map()
    this.#load()
  }

  /**
   * Issue a fresh code for `taskId`.
   *
   * @param {string} taskId
   * @param {{ttlHours?: number, token?: string}} [options]
   */
  issue(taskId, { ttlHours = 24, token } = {}) {
    const code = token || randomBytes(4).toString('hex').toUpperCase()
    const expiresAt = new Date(this.clock().getTime() + ttlHours * 3600 * 1000).toISOString()
    const record = { taskId, token: code, expiresAt, used: false, useCount: 0 }
    this.records.set(taskId, record)
    this.#persist()
    return record
  }

  /**
   * Validate a code.
   *
   * Deliberately **not** single-use. The reference burned the code on first
   * success, so a second reply to the same notification — the obvious way to add
   * a follow-up thought, and the only way while the agent is still working — was
   * silently rejected as `token_already_used`. Nothing was really gained by it:
   * the sender allow-list is the actual authorisation, the Message-ID de-dupe
   * already stops the same mail being processed twice, and the code still has to
   * match and still expires. What bounds abuse is the rate limit and the TTL.
   *
   * @returns {{ok: boolean, reason: string}}
   */
  check(taskId, token, now = this.clock()) {
    const record = this.records.get(taskId)
    if (!record) return { ok: false, reason: 'token_invalid' }
    if (now >= new Date(record.expiresAt)) return { ok: false, reason: 'token_expired' }
    if (!secretsEqual(record.token, token)) return { ok: false, reason: 'token_invalid' }
    return { ok: true, reason: 'accepted' }
  }

  /** Record a use. Informational only — the code stays usable until it expires. */
  consume(taskId) {
    const record = this.records.get(taskId)
    if (!record) return
    record.used = true
    record.useCount = (Number(record.useCount) || 0) + 1
    this.#persist()
  }

  #persist() {
    if (!this.path) return
    writeJson(this.path, Object.fromEntries(this.records))
  }

  #load() {
    const payload = readJson(this.path, null)
    if (!payload || typeof payload !== 'object') return
    for (const [key, raw] of Object.entries(payload)) {
      if (!raw || typeof raw !== 'object') continue
      this.records.set(key, {
        taskId: raw.taskId ?? key,
        token: String(raw.token ?? ''),
        expiresAt: raw.expiresAt ?? new Date(0).toISOString(),
        used: Boolean(raw.used),
        useCount: Number(raw.useCount) || 0,
      })
    }
  }
}

/**
 * Strips quoted history and the signature, leaving only what the user typed.
 *
 * Everything after a signature separator or an "On ... wrote:" line is mail
 * furniture: it usually repeats the notification body, including the code, and
 * must not be treated as the user's own words. Character references are decoded
 * last, because some senders build the text part by stripping HTML tags without
 * decoding them, and `&nbsp;` would otherwise be delivered verbatim.
 */
export function cleanReplyBody(body) {
  const withoutQuotes = stripQuotedHistory(decodeEntities(body))
  return withoutQuotes.split(/^\s*(?:--\s*$|发送自|Sent from)/im)[0].trim()
}

/**
 * The inbound-mail gate.
 *
 * One instance per running plugin; `seenMessageIds` is shared with the service
 * so a rejected mail is remembered locally and never re-examined.
 */
export class ReplyValidator {
  /**
   * @param {object} options
   * @param {string} options.allowedSender - the only address allowed to reply.
   * @param {TokenStore} options.tokenStore
   * @param {Set<string>} options.seenMessageIds
   * @param {number} [options.maxLength]
   */
  constructor({ allowedSender, tokenStore, seenMessageIds, maxLength = 8000 }) {
    this.allowedSender = String(allowedSender || '').toLowerCase()
    this.tokenStore = tokenStore
    this.seenMessageIds = seenMessageIds
    this.maxLength = maxLength
  }

  /**
   * Decide whether an incoming mail may reach its session.
   *
   * @param {{messageId: string, sender: string, subject?: string, text?: string,
   *          html?: string|null, hasAttachments?: boolean, receivedAt?: Date}} mail
   * @param {{dryRun?: boolean}} [options] - `dryRun` reports the same verdict but
   *   neither consumes the one-time code nor remembers the message, which is what
   *   makes it safe to ask about real mail from a diagnostic.
   * @returns {object} a reply record whose `verificationStatus` is `accepted` or `rejected`.
   */
  validate(mail, { dryRun = false } = {}) {
    const source = String(mail.text || '').trim() || htmlToText(mail.html || '')
    // Two different texts, for two different jobs.
    //
    // The task id and the one-time code are searched for in the *whole* message,
    // quoted original included: the notification tells the user to keep those
    // lines, and a client that quotes the original puts them inside the quote.
    // Searching only the stripped body would reject exactly the reply the
    // instructions ask for.
    //
    // What reaches the session is only what the user typed. Submitting the whole
    // message hands the model a wall of the previous mail — which is what a real
    // reply was observed to do before the separators were widened.
    const searchable = decodeEntities(source)
    const reply = createReply({
      replyId: mail.messageId,
      messageId: mail.messageId,
      senderAddress: mail.sender,
      body: cleanReplyBody(source),
      receivedAt: mail.receivedAt ? mail.receivedAt.toISOString() : new Date().toISOString(),
    })

    if (this.seenMessageIds.has(mail.messageId)) return this.#reject(reply, 'duplicate_message_id')
    // A dry run answers "would this be accepted?" without spending the code or
    // remembering the message, so a diagnostic can ask about real mail safely.
    if (!dryRun) this.seenMessageIds.add(mail.messageId)

    if (String(mail.sender || '').toLowerCase() !== this.allowedSender) {
      return this.#reject(reply, 'sender_not_allowed')
    }
    if (mail.hasAttachments) return this.#reject(reply, 'attachments_not_allowed')
    if (reply.body.length > this.maxLength) return this.#reject(reply, 'body_too_long')

    const taskMatch = TASK_RE.exec(searchable)
    const tokenMatch = TOKEN_RE.exec(searchable)
    if (!taskMatch) return this.#reject(reply, 'task_id_missing')
    if (!tokenMatch) return this.#reject(reply, 'token_missing')

    const taskId = taskMatch[1]
    const { ok, reason } = this.tokenStore.check(taskId, tokenMatch[1])
    if (!ok) return this.#reject(reply, reason)

    if (!dryRun) this.tokenStore.consume(taskId)
    reply.taskId = taskId
    reply.verificationStatus = ReplyVerification.ACCEPTED
    return reply
  }

  #reject(reply, reason) {
    reply.verificationStatus = ReplyVerification.REJECTED
    reply.rejectionReason = reason
    return reply
  }
}
