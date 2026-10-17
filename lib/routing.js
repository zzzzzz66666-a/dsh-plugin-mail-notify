/**
 * Reply routing: how a verified reply reaches the right session.
 *
 * Approval prompts are never answered here. The harness asks for approval
 * through its own surface, and a mail reply must not be able to stand in for
 * the human's decision — recording and notifying is the whole of this plugin's
 * involvement with them.
 *
 * @module dsh-plugin-mail-notify/routing
 */

import { ReplySubmission } from './domain.js'

/** In-memory view of a session, as far as routing cares. */
export function sessionState(overrides = {}) {
  return {
    exists: true,
    running: false,
    waitingInput: false,
    waitingApproval: false,
    loaded: true,
    ...overrides,
  }
}

/**
 * Decides whether a verified reply may be submitted, and submits it.
 *
 * Every path that cannot submit *keeps* the reply in the local queue rather
 * than dropping it: a paused bridge, a rate limit or a missing session are all
 * temporary, and the user's message is not ours to discard.
 */
export class ReplyRouter {
  /**
   * @param {object} bridge - a {@link module:dsh-plugin-mail-notify/bridge.HarnessBridge}.
   * @param {object} [options]
   * @param {number} [options.maxRepliesPerMinute]
   * @param {() => Date} [options.clock]
   */
  constructor(bridge, { maxRepliesPerMinute = 20, clock = () => new Date() } = {}) {
    this.bridge = bridge
    this.paused = false
    /** @type {object[]} replies accepted from mail but not yet submitted. */
    this.queue = []
    this.outcomes = []
    this.maxRepliesPerMinute = maxRepliesPerMinute
    this.recent = []
    this.clock = clock
  }

  /** Pause or resume submission of queued replies. */
  setPaused(value) {
    this.paused = Boolean(value)
  }

  #bridgeReady() {
    return Boolean(this.bridge?.connected)
  }

  #canContinue() {
    return Boolean(this.bridge?.capabilities?.startTurn)
  }

  #rateLimited() {
    const cutoff = this.clock().getTime() - 60_000
    this.recent = this.recent.filter((moment) => moment >= cutoff)
    return this.recent.length >= this.maxRepliesPerMinute
  }

  #record(reply, outcome, path, detail = '') {
    this.recent.push(this.clock().getTime())
    this.outcomes.push({
      replyId: reply.replyId,
      sessionId: reply.sessionId,
      outcome,
      path,
      detail,
    })
    if (this.outcomes.length > 500) this.outcomes = this.outcomes.slice(-500)
  }

  /**
   * Route one verified reply.
   *
   * @param {object} reply - accepted reply record.
   * @param {object} state - {@link sessionState} for the reply's session.
   * @returns {string} the outcome name, recorded in the audit log.
   */
  route(reply, state) {
    if (this.paused || !this.#bridgeReady()) {
      this.queue.push(reply)
      return 'paused'
    }
    if (this.#rateLimited()) {
      this.queue.push(reply)
      return 'rate_limited'
    }
    if (!state.exists || !state.loaded) {
      this.queue.push(reply)
      return 'queued_missing_session'
    }
    if (state.waitingApproval) {
      // The harness is blocked on a human decision. Email never makes it.
      this.queue.push(reply)
      return 'queued_approval'
    }
    if (!this.#canContinue()) {
      this.queue.push(reply)
      return 'paused'
    }
    if (!this.bridge.sendMessage(reply.sessionId, reply.body, reply.messageId)) {
      this.queue.push(reply)
      return 'paused'
    }
    reply.submissionStatus = ReplySubmission.SUBMITTED
    reply.processedAt = this.clock().toISOString()
    this.#record(reply, 'submitted', state.running ? 'queued_in_session' : 'new_turn')
    return state.running ? 'submitted_running' : 'submitted'
  }

  /**
   * Retry queued replies against fresh session state.
   *
   * @param {(sessionId: string) => object} stateLookup
   */
  flush(stateLookup) {
    const pending = this.queue
    this.queue = []
    const results = []
    for (const reply of pending) {
      const state = stateLookup(reply.sessionId)
      if (!state || !state.exists) {
        this.queue.push(reply)
        continue
      }
      results.push(this.route(reply, state))
    }
    return results
  }
}
