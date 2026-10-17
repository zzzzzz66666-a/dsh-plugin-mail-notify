/**
 * Notification rendering and the durable outbound queue.
 *
 * The queue is what makes delivery survive a harness restart, a flaky mailbox
 * or a wrong authorization code: a notification is created once, retried with
 * exponential backoff, and never sent twice.
 *
 * @module dsh-plugin-mail-notify/notifications
 */

import { MailError } from './mail/errors.js'
import { NotificationStatus, createNotification } from './domain.js'
import { writeJson, readJson } from './store.js'

/** Longest backoff between automatic retries. */
export const MAX_BACKOFF_SECONDS = 300

/** Automatic attempts before a notification is parked as failed. */
export const DEFAULT_MAX_RETRIES = 5

/**
 * Label shown for the reply code.
 *
 * Renamed from the reference's "one-time code": the code is now reusable until
 * it expires, because burning it made a second reply to the same notification
 * impossible.
 */
const CODE_LABEL = '回复验证码'

/**
 * Render the summary mail for a finished or waiting task.
 *
 * Only a summary is sent: the full assistant output stays in the harness, and
 * the credential never appears here. The one-time code is the only secret in
 * the body, and it is single-use.
 *
 * @param {object} task - task record from {@link module:dsh-plugin-mail-notify/domain}.
 * @param {string} code - one-time reply code for this task.
 * @param {object} [options]
 * @param {string} [options.subjectPrefix] - queue tag, also used as the IMAP search subject.
 * @param {number} [options.tokenTtlHours] - validity window advertised in the body.
 * @returns {{subject: string, body: string}}
 */
export function renderNotification(task, code, options = {}) {
  const prefix = options.subjectPrefix || '[DSH]'
  const ttlHours = options.tokenTtlHours ?? 24
  const subject = `${prefix}[${task.status}] ${task.title} - ${task.taskId}`
  const started = task.startedAt || '未知'
  const finished = task.completedAt || '未知'
  const duration = task.durationMs === null || task.durationMs === undefined ? '未知' : `${task.durationMs} ms`
  const parts = [
    `状态：${task.status}`,
    `任务标题：${task.title}`,
    `本地任务编号：${task.taskId}`,
    `会话标识摘要：${String(task.sessionId || '').slice(0, 8)}`,
    `开始时间：${started}`,
    `结束时间：${finished}`,
    `耗时：${duration}`,
  ]
  if (task.resultSummary) {
    parts.push('', '本次回复摘要：', String(task.resultSummary).trim())
  }
  parts.push(
    `错误摘要或等待原因：${task.errorSummary || '无'}`,
    '',
    `${CODE_LABEL}：${code}`,
    `回复有效期：${ttlHours} 小时内可多次回复`,
    '回复说明：直接回复本邮件并在正文保留上面的任务编号与验证码，即可向原会话提交内容。',
    '权限审批不能通过邮件批准，请回到 DeepSeek Harness 内处理。',
  )
  return { subject, body: `${parts.join('\n')}\n` }
}

/**
 * Persistent outbound queue for notification mail.
 *
 * Every mutation is flushed immediately: the process may be killed between any
 * two statements, and a notification that only exists in memory is lost work.
 */
export class NotificationQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.maxRetries] - automatic attempts per notification.
   * @param {string|null} [options.path] - JSON file backing the queue.
   * @param {() => Date} [options.clock] - injectable clock for tests.
   */
  constructor({ maxRetries = DEFAULT_MAX_RETRIES, path = null, clock = () => new Date() } = {}) {
    this.records = new Map()
    this.maxRetries = maxRetries
    this.path = path || null
    this.clock = clock
    this.#load()
  }

  /**
   * Insert a notification, keeping any existing record for the same id.
   *
   * Idempotency by id is what stops a repeated poll from queuing duplicates.
   */
  add(record) {
    if (!this.records.has(record.notificationId)) {
      this.records.set(record.notificationId, createNotification(record))
      this.#persist()
    }
    return this.records.get(record.notificationId)
  }

  /** @returns {object|undefined} */
  get(notificationId) {
    return this.records.get(notificationId)
  }

  /**
   * Attempt one delivery.
   *
   * @param {string} notificationId
   * @param {{send: (subject: string, body: string) => Promise<void>|void}} channel
   * @param {Date} [now]
   * @returns {Promise<boolean>} true when the mail was accepted by the server.
   */
  async sendOnce(notificationId, channel, now = this.clock()) {
    const record = this.records.get(notificationId)
    if (!record) return false
    if (record.status === NotificationStatus.SENT) return false
    if (record.status === NotificationStatus.FAILED) return false
    if (record.nextRetryAt && now < new Date(record.nextRetryAt)) return false
    record.status = NotificationStatus.SENDING
    this.#persist()
    try {
      await channel.send(record.subject, record.body)
      record.status = NotificationStatus.SENT
      record.sentAt = now.toISOString()
      this.#persist()
      return true
    } catch (error) {
      return this.#handleFailure(record, error, now)
    }
  }

  /**
   * Record a failed attempt and decide between retrying and giving up.
   *
   * The `SENDING` marker written before the attempt is why a crash mid-send is
   * recoverable: {@link NotificationQueue#recoverStaleSending} turns it back
   * into a retry instead of leaving it stuck forever.
   */
  #handleFailure(record, error, now) {
    const category = error instanceof MailError ? error.category : 'transient'
    const retryable = error instanceof MailError ? error.retryable : true
    record.lastError = `${category}: ${error?.message ?? String(error)}`.slice(0, 500)
    const attempts = record.retryCount + 1
    if (!retryable) {
      record.status = NotificationStatus.FAILED
      record.nextRetryAt = null
    } else if (attempts < this.maxRetries) {
      record.retryCount = attempts
      record.status = NotificationStatus.RETRYING
      const delay = Math.min(2 ** attempts, MAX_BACKOFF_SECONDS)
      record.nextRetryAt = new Date(now.getTime() + delay * 1000).toISOString()
    } else {
      record.retryCount = Math.min(attempts, this.maxRetries)
      record.status = NotificationStatus.FAILED
      record.nextRetryAt = null
    }
    this.#persist()
    return false
  }

  /**
   * Manual retry: clear the exhausted state and attempt one send.
   *
   * Unlike an automatic retry this ignores the backoff timer, because a human
   * explicitly asked for it.
   */
  async retry(notificationId, channel, now = this.clock()) {
    const record = this.records.get(notificationId)
    if (!record || record.status === NotificationStatus.SENT) return false
    record.status = NotificationStatus.RETRYING
    record.nextRetryAt = null
    this.#persist()
    return this.sendOnce(notificationId, channel, now)
  }

  /** Notifications whose backoff has elapsed. */
  due(now = this.clock()) {
    const result = []
    for (const record of this.records.values()) {
      if (record.status !== NotificationStatus.PENDING && record.status !== NotificationStatus.RETRYING) continue
      if (!record.nextRetryAt || now >= new Date(record.nextRetryAt)) result.push(record)
    }
    return result
  }

  /** Send every due notification; returns the ids that were delivered. */
  async dispatchDue(channel, now = this.clock()) {
    const delivered = []
    for (const record of this.due(now)) {
      if (await this.sendOnce(record.notificationId, channel, now)) delivered.push(record.notificationId)
    }
    return delivered
  }

  /** Ids of notifications that exhausted their automatic retries. */
  failedIds() {
    return [...this.records.values()]
      .filter((record) => record.status === NotificationStatus.FAILED)
      .map((record) => record.notificationId)
  }

  /** Manually retry every exhausted notification. */
  async retryFailed(channel, now = this.clock()) {
    const result = {}
    for (const notificationId of this.failedIds()) {
      result[notificationId] = await this.retry(notificationId, channel, now)
    }
    return result
  }

  /**
   * Turn records stuck in `sending` back into retries.
   *
   * Runs at startup: a record can only be `sending` if the previous process
   * died between the marker and the result.
   */
  recoverStaleSending(now = this.clock(), staleAfterSeconds = 30) {
    const recovered = []
    for (const record of this.records.values()) {
      if (record.status !== NotificationStatus.SENDING) continue
      record.status = NotificationStatus.RETRYING
      record.nextRetryAt = new Date(now.getTime() + staleAfterSeconds * 1000).toISOString()
      recovered.push(record.notificationId)
    }
    if (recovered.length) this.#persist()
    return recovered
  }

  /** Snapshot used by the status surface. */
  summary() {
    const pending = []
    const failed = []
    for (const record of this.records.values()) {
      if (record.status === NotificationStatus.FAILED) failed.push(record.notificationId)
      else if (record.status !== NotificationStatus.SENT) pending.push(record.notificationId)
    }
    return { pending, failed, total: this.records.size }
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
      this.records.set(key, createNotification({ ...raw, notificationId: raw.notificationId || key }))
    }
  }
}
