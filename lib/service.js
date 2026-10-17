/**
 * The running component: observes sessions, emails summaries, routes replies.
 *
 * Every entry point is defensive. This code runs inside the harness process,
 * where an unhandled rejection would take down the GUI's backend, so a mail
 * server that is down, a malformed message or a vanished session must degrade
 * into an audit entry and a retry — never into a thrown error that escapes.
 *
 * @module dsh-plugin-mail-notify/service
 */

import { AuditLog } from './audit.js'
import { DEFAULT_CONFIG, isConfigured, publicConfig, validateConfig } from './config.js'
import {
  TaskStatus,
  createNotification,
  nowIso,
} from './domain.js'
import { MailError } from './mail/errors.js'
import { ImapMailReceiver, buildSearchCriteria } from './mail/imap.js'
import { SmtpMailSender } from './mail/smtp.js'
import { NotificationQueue, renderNotification } from './notifications.js'
import { ReplyValidator, TokenStore } from './replies.js'
import { ReplyRouter } from './routing.js'
import { AUTH_CODE_REF, createSecretStore, probeCredentialsService } from './secrets.js'
import { JsonDocument, defaultDataDir } from './store.js'

/** Statuses that are worth an email, keyed by the task status. */
const NOTIFIABLE = new Set([TaskStatus.COMPLETED, TaskStatus.FAILED])

/**
 * Wires the bridge, the mail transports and the local stores together.
 */
export class MailNotifyService {
  /**
   * @param {object} options
   * @param {object} options.ctx - Cordis context.
   * @param {object} options.config - raw plugin configuration from the profile row.
   * @param {object} options.bridge - a {@link module:dsh-plugin-mail-notify/bridge.HarnessBridge}.
   * @param {object|null} [options.logger]
   * @param {() => Date} [options.clock]
   * @param {string|null} [options.dataDir]
   */
  constructor({ ctx, config, bridge, logger = null, clock = () => new Date(), dataDir = null,
    secretStore = null, senderFactory = null, receiverFactory = null }) {
    this.ctx = ctx
    this.bridge = bridge
    this.logger = logger
    this.clock = clock
    this.secretStoreOverride = secretStore
    this.senderFactory = senderFactory
    this.receiverFactory = receiverFactory
    this.config = null
    this.configError = null
    this.running = false
    this.lastError = null
    this.timer = null
    this.lastPollAt = null
    this.lastPollSummary = null
    this.authorizationCode = null
    this.credentialConfigured = false

    this.dataDir = dataDir || config?.dataDir || defaultDataDir()
    try {
      this.config = validateConfig(config ?? DEFAULT_CONFIG)
    } catch (error) {
      // An incomplete row is a normal first-run state, not a crash: the plugin
      // still loads, reports `configured: false`, and starts once filled in.
      this.configError = error.message
      this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) }
    }
  }

  /** Whether the plugin has everything it needs to do any work. */
  get configured() {
    return this.configError === null && isConfigured(this.config) && this.credentialConfigured
  }

  #path(name) {
    return `${this.dataDir}/${name}`
  }

  /**
   * Load persisted state, resolve the credential and start the poll timer.
   *
   * Nothing here throws: a failure is recorded and leaves the service
   * `running: false`, which the status surface reports.
   */
  async start() {
    try {
      this.audit = new AuditLog({ path: this.#path('audit.json') })
      this.queue = new NotificationQueue({ maxRetries: 5, path: this.#path('notifications.json'), clock: this.clock })
      this.tokens = new TokenStore({ path: this.#path('tokens.json'), clock: this.clock })
      this.state = new JsonDocument(this.#path('state.json'))
      this.secretStore = this.secretStoreOverride ?? createSecretStore({
        credentials: this.#credentials(),
        env: process.env,
        // A read that had to bypass the seam means the seam and its own
        // document disagree. That deserves an audit entry, not silence.
        onFallback: (message) =>
          this.audit?.record('credential.fallback', message, { errorCategory: 'credential' }),
      })
      this.router = new ReplyRouter(this.bridge, {
        maxRepliesPerMinute: this.config.maxRepliesPerMinute,
        clock: this.clock,
      })
      this.validator = new ReplyValidator({
        allowedSender: this.config.allowedReplyEmail,
        tokenStore: this.tokens,
        seenMessageIds: this.state.listAsSet('seen_message_ids'),
        maxLength: this.config.maxReplyLength,
      })

      const recovered = this.queue.recoverStaleSending(this.clock())
      if (recovered.length) {
        this.audit.record('queue.recover', `recovered ${recovered.length} sending records`)
      }

      await this.refreshCredential()
      this.router.setPaused(!this.bridge.continuationAvailable)

      if (this.configError) {
        this.audit.record('config.invalid', this.configError, { errorCategory: 'config' })
      } else if (!isConfigured(this.config)) {
        this.audit.record('config.incomplete', 'mail addresses are not configured', {
          errorCategory: 'config',
        })
      } else if (!this.credentialConfigured) {
        this.audit.record('credential.missing', `no value for ${AUTH_CODE_REF}`, {
          errorCategory: 'credential',
        })
        // "Not configured" alone cannot tell "the user stored nothing" apart
        // from "this plugin cannot reach the credential store at all", and the
        // two need different fixes. Record which one it is.
        await this.diagnoseCredential()
      }

      this.running = true
      this.#schedule()
      this.audit.record('service.start', this.configured ? 'configured' : 'not configured')
      return this.health()
    } catch (error) {
      this.running = false
      this.lastError = String(error?.message ?? error)
      this.logger?.error?.(`mail-notify failed to start: ${this.lastError}`)
      return this.health()
    }
  }

  /**
   * Re-resolve the authorization code from the secret store.
   *
   * The credentials seam resolves per operation so that a rotated secret takes
   * effect on the next request rather than at the next restart. Reading the
   * value once at startup broke that contract in two ways: rotating the code
   * did nothing until a restart, and a plugin that booted before its credential
   * existed stayed idle forever even once the user had stored it.
   *
   * A changed value discards the cached transports, because they captured the
   * previous password when they were built.
   *
   * @returns {Promise<boolean>} whether a credential is now available.
   */
  async refreshCredential() {
    let value = null
    try {
      value = await this.secretStore.read(AUTH_CODE_REF)
    } catch (error) {
      this.audit?.record('credential.read', String(error?.message ?? error), { errorCategory: 'credential' })
    }
    const had = this.credentialConfigured
    if (value !== this.authorizationCode) {
      this.authorizationCode = value
      this.cachedSender = null
      this.cachedReceiver = null
    }
    this.credentialConfigured = Boolean(value)
    if (this.credentialConfigured && !had) {
      this.audit?.record('credential.loaded', `resolved ${AUTH_CODE_REF} via ${this.secretStore?.kind ?? 'unknown'}`)
    } else if (!this.credentialConfigured && had) {
      this.audit?.record('credential.removed', `${AUTH_CODE_REF} is no longer available`, {
        errorCategory: 'credential',
      })
    }
    return this.credentialConfigured
  }

  /**
   * Record why no credential could be resolved.
   *
   * Reported as one audit entry rather than logged, so it survives into the
   * file a user can actually read after a restart. It contains no secret: only
   * which store was chosen, how the service was looked up, and the seam's own
   * non-secret view of the reference.
   *
   * @returns {Promise<object>} the same diagnosis, for the status surface.
   */
  async diagnoseCredential() {
    const probe = probeCredentialsService(this.ctx)
    const detail = {
      store: this.secretStore?.kind ?? 'unknown',
      reason: this.secretStore?.reason ?? '',
      via: probe.via,
      lookups: probe.attempts.map((attempt) =>
        attempt.usable ? `${attempt.via}=usable` : attempt.error ? `${attempt.via}=error(${attempt.error})` : `${attempt.via}=absent`,
      ),
    }
    if (typeof this.secretStore?.describe === 'function') {
      detail.seam = await this.secretStore.describe(AUTH_CODE_REF)
    }
    this.credentialDiagnosis = detail
    this.audit?.record('credential.diagnose', JSON.stringify(detail), { errorCategory: 'credential' })
    return detail
  }

  /** Stop the timer; the Cordis fiber owns the event subscriptions. */
  async stop() {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      this.audit?.record('service.stop', 'stopped')
    } catch {
      // Shutdown must not fail because the audit log could not be written.
    }
  }

  #credentials() {
    // `probeCredentialsService` also tries the plain `ctx.credentials`
    // property, and reports which lookup worked, so a failure here is
    // diagnosable rather than a silent fall back to an in-memory store.
    return probeCredentialsService(this.ctx).service
  }

  #schedule() {
    if (this.timer) clearTimeout(this.timer)
    if (!this.running) return
    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch((error) => {
          this.lastError = String(error?.message ?? error)
          this.logger?.warn?.(`mail-notify cycle failed: ${this.lastError}`)
        })
        .finally(() => this.#schedule())
    }, this.config.pollIntervalMs)
    // A pending poll must never hold the harness process open.
    this.timer.unref?.()
  }

  // -- notifications -----------------------------------------------------

  /**
   * Accept a task from the bridge and queue its notification.
   *
   * Deduplication is by task id, which the bridge derives deterministically
   * from the session and turn, so a replayed event cannot produce a second mail.
   */
  handleTask(task) {
    try {
      if (!this.config.notificationsEnabled) return
      if (!NOTIFIABLE.has(task.status) && !this.#waitingNotifiable(task)) return
      const already = this.state.listAsSet('notified_tasks')
      if (already.has(task.taskId)) return

      const enriched = { ...task, resultSummary: this.#summarize(task.resultSummary) }
      const notification = this.buildNotification(enriched)
      this.queue.add(notification)
      this.state.rememberInList('notified_tasks', task.taskId, 5000)
      this.#rememberTaskSession(task.taskId, task.sessionId)
      this.audit.record('notification.enqueue', `${task.status} ${task.taskId}`, { taskId: task.taskId })
      // A fresh notification should not wait for the next timer tick.
      void this.dispatchDue()
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      this.logger?.warn?.(`mail-notify could not queue a notification: ${this.lastError}`)
    }
  }

  /** Waiting states are notifiable even though they are not terminal. */
  #waitingNotifiable(task) {
    return task.status === TaskStatus.WAITING_USER_INPUT || task.status === TaskStatus.WAITING_APPROVAL
  }

  /** Cap the assistant text that goes into the mail, exactly as the reference does. */
  #summarize(text) {
    if (!this.config.includeReplySummary) return null
    const cleaned = String(text ?? '').trim()
    if (!cleaned) return null
    const limit = Number(this.config.replySummaryMaxChars)
    if (limit <= 0) return null
    if (cleaned.length <= limit) return cleaned
    return `${cleaned.slice(0, limit).replace(/\s+$/, '')}…（已截断，完整内容请在 DeepSeek Harness 中查看）`
  }

  /** Issue or reuse the one-time code and render the mail. */
  buildNotification(task) {
    let token = this.tokens.records.get(task.taskId)
    if (!token || token.used) {
      token = this.tokens.issue(task.taskId, { ttlHours: this.config.replyTokenTtlHours })
    }
    const { subject, body } = renderNotification(task, token.token, {
      subjectPrefix: this.config.subjectPrefix,
      tokenTtlHours: this.config.replyTokenTtlHours,
    })
    return createNotification({
      notificationId: `n-${task.taskId}-${task.status}`,
      taskId: task.taskId,
      channel: 'email',
      subject,
      body,
    })
  }

  /**
   * The SMTP sender, created once and reused.
   *
   * A batch of notifications is normally delivered in one cycle, and opening a
   * fresh TLS session per mail would multiply both latency and the chance of
   * tripping the provider's connection limits.
   */
  #sender() {
    if (!this.cachedSender) {
      const config = this.config
      this.cachedSender =
        this.senderFactory?.() ??
        new SmtpMailSender({
          host: config.smtpHost,
          port: config.smtpPort,
          security: config.smtpSecurity,
          username: config.senderEmail,
          password: this.authorizationCode,
        })
    }
    return this.cachedSender
  }

  /** The IMAP receiver, created once and reused for fetch and acknowledge. */
  #receiver() {
    if (!this.cachedReceiver) {
      const config = this.config
      this.cachedReceiver =
        this.receiverFactory?.() ??
        new ImapMailReceiver({
          host: config.imapHost,
          port: config.imapPort,
          security: config.imapSecurity,
          username: config.senderEmail,
          password: this.authorizationCode,
          mailbox: config.imapMailbox,
          // Subject-tagged and date-bounded, deliberately not `UNSEEN`: a reply
          // can arrive already read, and an unseen-only search never sees it.
          searchCriteria: buildSearchCriteria({ subjectTag: config.subjectPrefix, now: this.clock() }),
          maxPerPoll: 50,
        })
    }
    return this.cachedReceiver
  }

  #channel() {
    const config = this.config
    return {
      send: async (subject, body) => {
        await this.#sender().send({
          sender: config.senderEmail,
          to: config.recipientEmail,
          subject,
          body,
        })
      },
    }
  }

  /** Send every notification whose backoff has elapsed. */
  async dispatchDue(now = this.clock()) {
    if (!this.credentialConfigured) await this.refreshCredential()
    if (!this.configured) return []
    try {
      const sent = await this.queue.dispatchDue(this.#channel(), now)
      for (const notificationId of sent) {
        this.audit.record('notification.sent', notificationId)
      }
      return sent
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      this.audit.record('notification.dispatch', this.lastError, {
        errorCategory: error instanceof MailError ? error.category : 'mail_error',
      })
      return []
    }
  }

  // -- replies -----------------------------------------------------------

  /** One full cycle: flush the queue, then read and route replies. */
  async runOnce(now = this.clock()) {
    const summary = { sent: [], replies: [], queued: [], rejected: [] }
    if (!this.running) await this.start()
    // Re-read the credential every cycle: storing or rotating it must take
    // effect on its own, without the user restarting the harness again.
    await this.refreshCredential()
    if (this.config.notificationsEnabled) summary.sent = await this.dispatchDue(now)
    if (this.config.continuationEnabled || this.router.queue.length) {
      const result = await this.pollReplies(now)
      summary.replies = result.submitted
      summary.queued = result.queued
      summary.rejected = result.rejected
    }
    this.#flushRouter()
    this.lastPollAt = now.toISOString()
    this.lastPollSummary = {
      sent: summary.sent.length,
      replies: summary.replies.length,
      queued: summary.queued.length,
    }
    return summary
  }

  /** Retry replies that were held back by a pause, a rate limit or a busy session. */
  #flushRouter() {
    if (!this.router.queue.length) return
    const results = this.router.flush((sessionId) => this.bridge.sessionState(sessionId))
    for (const outcome of results) {
      if (outcome.startsWith('submitted')) this.audit.record('reply.route', outcome)
    }
  }

  /** Read the mailbox and route every acceptable reply. */
  async pollReplies(now = this.clock()) {
    const submitted = []
    const queued = []
    const rejected = []
    if (!this.credentialConfigured) await this.refreshCredential()
    if (!this.configured) return { submitted, queued, rejected }

    let messages
    try {
      const receiver = this.#receiver()
      // Ask only for mail that arrived since the last poll. Re-downloading the
      // whole search window every cycle is what made a reply wait behind every
      // older message — the newest UID is fetched last — and cost seconds per
      // poll for messages that were then skipped as already seen.
      receiver.sinceUid = this.#imapMark()
      messages = await receiver.receive()
      this.receiver = receiver
      this.#rememberImapMark(receiver)
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      this.audit.record('imap.receive', this.lastError, {
        errorCategory: error instanceof MailError ? error.category : 'mail_error',
      })
      return { submitted, queued, rejected }
    }

    const acceptedUids = []
    for (const raw of messages) {
      try {
        // A rejected message is deliberately left unread in the user's mailbox,
        // so it is handed to us again on every poll. Re-validating it cannot
        // produce a different answer, and auditing it again turned a handful of
        // stale messages into hundreds of identical log entries — so a message
        // we have already examined is dropped without a trace.
        if (raw.messageId && this.validator.seenMessageIds.has(raw.messageId)) continue

        // The tag is enforced locally as well as server-side. QQ Mail's IMAP
        // ignores text search criteria outright — `SUBJECT` and even `TEXT` with
        // a string that appears nowhere return the same set — so the only
        // server-side limit that actually holds is `SINCE`. Without this guard
        // every unrelated message in the window would be validated and audited.
        if (!String(raw.subject ?? '').includes(this.config.subjectPrefix)) continue

        if (raw.isNotification) {
          // With one mailbox for both directions every notification comes back
          // as unread mail. It must never be mistaken for a human reply, and it
          // is left unread so the user still sees it in their inbox.
          this.#rememberMessageId(raw.messageId)
          continue
        }
        const reply = this.validator.validate({
          messageId: raw.messageId,
          sender: raw.sender,
          subject: raw.subject,
          text: raw.text,
          html: raw.html,
          hasAttachments: raw.hasAttachments,
          receivedAt: raw.receivedAt,
        })
        this.#rememberMessageId(raw.messageId)

        if (reply.verificationStatus !== 'accepted') {
          rejected.push(reply.rejectionReason ?? 'rejected')
          this.audit.record('reply.reject', String(reply.rejectionReason), {
            replyId: reply.replyId,
            errorCategory: 'verification',
          })
          continue
        }

        reply.sessionId = this.#sessionForTask(reply.taskId)
        const outcome = this.router.route(reply, this.bridge.sessionState(reply.sessionId))
        this.audit.record('reply.route', outcome, { taskId: reply.taskId, replyId: reply.replyId })
        if (outcome.startsWith('submitted')) {
          submitted.push(outcome)
          // Only mail the plugin actually consumed is marked read; a rejected
          // message stays untouched in the user's mailbox.
          if (raw.uid) acceptedUids.push(raw.uid)
        } else {
          queued.push(outcome)
        }
      } catch (error) {
        rejected.push('processing_error')
        this.audit.record('reply.error', String(error?.message ?? error), { errorCategory: 'processing' })
      }
    }

    await this.#acknowledge(acceptedUids)
    this.#persistSeen()
    return { submitted, queued, rejected }
  }

  /**
   * Highest mailbox UID already examined, persisted across restarts.
   *
   * Kept in the state document rather than on the receiver because the mark has
   * to survive a harness restart; a receiver is rebuilt from configuration each
   * time the process starts.
   */
  #imapMark() {
    const mark = this.state?.data?.imap_mark
    return mark && typeof mark === 'object' ? Math.max(0, Number(mark.lastUid) || 0) : 0
  }

  /** Persist the mark, and note a UID re-baseline when the mailbox restarted. */
  #rememberImapMark(receiver) {
    if (!this.state) return
    const previous = this.#imapMark()
    const lastUid = Math.max(0, Number(receiver.lastUid) || 0)
    if (receiver.uidReset) {
      this.audit?.record('imap.rebaseline', `mailbox UIDs moved backwards; re-scanned up to UID ${lastUid}`, {
        errorCategory: 'mail_error',
      })
    }
    if (lastUid === previous) return
    this.state.data.imap_mark = { lastUid }
    this.state.save()
  }

  async #acknowledge(uids) {
    if (!uids.length || !this.receiver?.acknowledgeMany) return
    try {
      await this.receiver.acknowledgeMany(uids)
    } catch (error) {
      // Leaving mail unread is the safe failure mode: it is re-examined, and
      // the one-time code means a second pass cannot double-submit.
      this.audit.record('imap.acknowledge', String(error?.message ?? error), { errorCategory: 'mail_error' })
    }
  }

  #rememberMessageId(messageId) {
    if (!messageId) return
    this.validator.seenMessageIds.add(messageId)
  }

  #persistSeen() {
    const seen = [...this.validator.seenMessageIds].sort().slice(-2000)
    this.state.data.seen_message_ids = seen
    this.state.save()
  }

  #rememberTaskSession(taskId, sessionId) {
    const mapping = { ...(this.state.data.task_sessions ?? {}) }
    mapping[taskId] = sessionId
    const entries = Object.entries(mapping).slice(-2000)
    this.state.data.task_sessions = Object.fromEntries(entries)
    this.state.save()
  }

  #sessionForTask(taskId) {
    return this.state.data.task_sessions?.[taskId] ?? ''
  }

  // -- diagnostics -------------------------------------------------------

  /** Send a test mail; it carries no task id or code, so replying to it does nothing. */
  async sendTestEmail() {
    if (!this.credentialConfigured) await this.refreshCredential()
    if (!this.configured) throw new Error('mail notification is not configured yet')
    const number = String(Math.floor(Math.random() * 900000) + 100000)
    await this.#channel().send(
      `${this.config.subjectPrefix}[测试] 邮件通知测试`,
      '如果你收到这封邮件，说明 DeepSeek Harness 邮件通知插件配置成功。\n' +
        `测试编号：${number}\n` +
        '（测试邮件不含任务编号与验证码，因此回复它不会触发续聊。）\n',
    )
    this.audit.record('mail.test', `sent number=${number}`)
    return number
  }

  /** Pause or resume mail continuation; queued replies are preserved either way. */
  pauseContinuation() {
    this.router.setPaused(true)
    this.audit.record('continuation.pause', 'email continuation paused')
  }

  /** Resume continuation when the bridge can actually submit. */
  resumeContinuation() {
    const available = this.bridge.continuationAvailable
    this.router.setPaused(!available)
    this.audit.record('continuation.resume', available ? 'resumed' : 'interface unavailable')
    return available
  }

  /** Status document, safe to render anywhere: it holds no credential value. */
  health() {
    const queue = this.queue?.summary?.() ?? { pending: [], failed: [], total: 0 }
    return {
      running: this.running,
      configured: this.configured,
      configError: this.configError,
      credentialConfigured: this.credentialConfigured,
      credentialRef: AUTH_CODE_REF,
      credentialStore: this.secretStore?.kind ?? 'unknown',
      credentialDiagnosis: this.credentialDiagnosis ?? null,
      dataDir: this.dataDir,
      continuationAvailable: this.bridge?.continuationAvailable ?? false,
      continuationPaused: this.router?.paused ?? true,
      pendingNotifications: queue.pending,
      failedNotifications: queue.failed,
      queuedReplies: this.router?.queue.length ?? 0,
      lastError: this.lastError,
      lastPollAt: this.lastPollAt,
      lastPollSummary: this.lastPollSummary,
      config: publicConfig(this.config),
      updatedAt: nowIso(),
    }
  }
}
