/**
 * Adapter between the harness session event stream and the notification domain.
 *
 * The reference component polled a Codex thread history on a timer: it had to
 * re-read every thread and diff turn statuses to discover that something had
 * finished. Inside the harness we sit on the same event stream the GUI uses,
 * so a turn ending is observed directly, with its real reason and timing, and
 * no polling lag.
 *
 * Nothing here imports a `@deepseek-ai/*` package. A plugin installed as a
 * `link:` dependency lives outside the profile directory, so the harness's own
 * packages are not resolvable from it; every service is reached through the
 * Cordis context instead.
 *
 * @module dsh-plugin-mail-notify/bridge
 */

import { createHash, randomUUID } from 'node:crypto'
import { TaskStatus, createTask } from './domain.js'

/** Transport description advertised to the rest of the plugin. */
const CAPABILITIES = Object.freeze({
  transport: 'in-process',
  sharedSession: true,
  liveEvents: true,
  startTurn: true,
  /**
   * The harness answers a pending question with a structured batch, one item
   * per question, addressed by id. Free text from a mail body cannot be turned
   * into that batch without guessing which option the user meant, so this
   * plugin never claims the capability and always submits a normal message.
   */
  answerUserInput: false,
})

/**
 * How a `turn/end` reason maps onto a notifiable task status.
 *
 * `aborted` (the user pressed stop), `interrupted` (an ancestor cancelled it)
 * and `forked` are deliberately absent: they are not outcomes the user needs
 * mail about, and the reference component skipped the equivalent case for the
 * same reason.
 */
const TURN_END_STATUS = Object.freeze({
  completed: TaskStatus.COMPLETED,
  error: TaskStatus.FAILED,
  blocked: TaskStatus.FAILED,
  'max-tokens': TaskStatus.FAILED,
})

/** Human-readable reason per turn end, used when no error text is available. */
const TURN_END_REASON_TEXT = Object.freeze({
  completed: '轮次正常结束',
  error: '轮次以错误结束',
  blocked: '提示词被拦截，轮次未执行',
  'max-tokens': '达到输出上限，轮次被截断',
  aborted: '用户中止',
  interrupted: '被中断',
  forked: '已分叉',
})

/**
 * Coerce a session-event time into epoch milliseconds.
 *
 * Events carry a number in current builds, but the field is also seen as an
 * ISO string across the codebase, and guessing wrong would silently produce a
 * zero duration in every notification.
 */
export function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

/** Concatenate the text blocks of a message's content. */
export function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Build the stable, quotable task id for one session turn.
 *
 * The session id is hashed rather than truncated: session ids here are
 * directory-shaped and share long prefixes, so a prefix would collide and two
 * different sessions could answer to the same task id.
 */
export function taskIdFor(sessionId, turn) {
  const digest = createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 6)
  return `task-${digest}-t${turn}`
}

/**
 * Live view of harness sessions for the notification service.
 *
 * Per-session bookkeeping is dropped when the session is disposed, so a
 * long-lived harness does not accumulate state for every session it ever saw.
 */
export class HarnessBridge {
  /**
   * @param {object} options
   * @param {object} options.ctx - the Cordis context the plugin runs in.
   * @param {(task: object) => void} options.onTask - called for every notifiable task.
   * @param {object|null} [options.logger]
   */
  constructor({ ctx, onTask, logger = null }) {
    this.ctx = ctx
    this.onTask = onTask
    this.logger = logger
    this.capabilities = CAPABILITIES
    /** @type {Map<string, object>} per-session state. */
    this.sessions = new Map()
    this.version = 'harness'
  }

  /** In-process transport: usable exactly while the agent registry is present. */
  get connected() {
    return Boolean(this.#agents())
  }

  /** Continuation needs the agent registry and nothing else. */
  get continuationAvailable() {
    return this.connected
  }

  #agents() {
    try {
      return this.ctx.get?.('agents') ?? this.ctx.agents ?? null
    } catch {
      return null
    }
  }

  #state(sessionId) {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        id: sessionId,
        title: '',
        running: false,
        waitingApproval: false,
        waitingQuestion: null,
        turnStart: new Map(),
        lastAssistant: '',
        closed: false,
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * Adopt a session that already exists.
   *
   * A resumed or forked session arrives with history that must not be emailed:
   * seed events never publish on `session/event`, so folding the log here is
   * the only chance to mark those turns as already accounted for.
   */
  indexSession(session) {
    const state = this.#state(session.id)
    state.title = this.#titleFromLog(session) || state.title
    for (const event of session.log ?? []) {
      if (event?.type === 'turn/end') {
        state.turnStart.delete(event.data?.turn)
      } else if (event?.type === 'turn/start') {
        state.turnStart.set(event.data?.turn, toMillis(event.time))
      } else if (event?.type === 'assistant/message') {
        const text = messageText(event.data?.message)
        if (text) state.lastAssistant = text
      }
    }
    return state
  }

  /** Best-effort title: the harness title service first, the log second. */
  #titleFromLog(session) {
    const events = session.log ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'session/title') continue
      const data = event.data ?? {}
      const title = data.title ?? data.name ?? data.text
      if (typeof title === 'string' && title.trim()) return title.trim()
    }
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      const text = messageText(event.data)
      if (text) return text.split('\n')[0].slice(0, 80)
    }
    return ''
  }

  /** Title for a session, falling back to its id prefix. */
  sessionTitle(sessionId) {
    const state = this.sessions.get(sessionId)
    return state?.title || String(sessionId).slice(0, 12)
  }

  /** Current routing view of a session. */
  sessionState(sessionId) {
    const state = this.sessions.get(sessionId)
    const agent = this.#agents()?.get?.(sessionId)
    if (!state && !agent) return { exists: false, running: false, waitingInput: false, waitingApproval: false, loaded: false }
    return {
      exists: true,
      running: agent ? agent.status === 'running' : Boolean(state?.running),
      waitingInput: Boolean(state?.waitingQuestion),
      waitingApproval: Boolean(state?.waitingApproval),
      loaded: true,
    }
  }

  /** Drop a session's bookkeeping once the harness disposes it. */
  forget(sessionId) {
    this.sessions.delete(sessionId)
  }

  /**
   * Submit `text` as the user's next message in `sessionId`.
   *
   * `followup` is the harness's own commit point for "a message arrives from
   * outside the turn": when the agent is idle it starts a turn, and while it is
   * running the message is queued in the agent's inbox. Either way the harness
   * owns the ordering, which is why this plugin does not need the reference
   * component's running/idle branching.
   */
  sendMessage(sessionId, text, clientMessageId) {
    const agent = this.#agents()?.get?.(sessionId)
    if (!agent) return false
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'user' },
    }
    try {
      agent.followup(message)
      this.logger?.debug?.(`submitted reply ${clientMessageId} to session ${sessionId}`)
      return true
    } catch (error) {
      this.logger?.warn?.(`followup failed for session ${sessionId}: ${error?.message ?? error}`)
      return false
    }
  }

  /**
   * Fold one session event into the notification decision.
   *
   * @param {object} session - the session the event belongs to.
   * @param {object} event - `{ type, seq, time, data }`.
   */
  handleSessionEvent(session, event) {
    const sessionId = session?.id
    if (!sessionId || !event) return
    const state = this.#state(sessionId)
    const data = event.data ?? {}

    switch (event.type) {
      case 'session/title': {
        const title = data.title ?? data.name ?? data.text
        if (typeof title === 'string' && title.trim()) state.title = title.trim()
        return
      }
      case 'turn/start': {
        state.running = true
        state.turnStart.set(data.turn, toMillis(event.time))
        return
      }
      case 'assistant/message': {
        const text = messageText(data.message)
        if (text) state.lastAssistant = text
        return
      }
      case 'approval/asked': {
        state.waitingApproval = true
        this.#emitWaiting( sessionId, TaskStatus.WAITING_APPROVAL, `approval:${data.id ?? 'unknown'}`, {
          errorSummary: data.reason || `等待权限审批：${data.toolName ?? '工具调用'}`,
        })
        return
      }
      case 'approval/decided': {
        state.waitingApproval = false
        return
      }
      case 'tool/call': {
        if (data.name !== 'ask_user_question') return
        const questions = parseQuestions(data.arguments)
        state.waitingQuestion = data.callId ?? null
        this.#emitWaiting(sessionId, TaskStatus.WAITING_USER_INPUT, `question:${data.callId ?? 'unknown'}`, {
          errorSummary: renderQuestions(questions) || '等待用户输入',
          resultSummary: null,
        })
        return
      }
      case 'user/message': {
        // A new message from the user clears the waiting state: they acted.
        state.waitingQuestion = null
        return
      }
      case 'turn/end': {
        state.running = false
        const turn = data.turn
        const startedAt = state.turnStart.get(turn) ?? null
        state.turnStart.delete(turn)
        const kind = data.reason?.kind ?? 'completed'
        const status = TURN_END_STATUS[kind]
        if (!status) return
        const endedAt = toMillis(event.time)
        const task = createTask({
          taskId: taskIdFor(sessionId, turn),
          sessionId,
          turnId: String(turn),
          title: this.sessionTitle(sessionId),
          status,
          startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
          completedAt: new Date(endedAt).toISOString(),
          durationMs: startedAt === null ? null : Math.max(0, endedAt - startedAt),
          errorSummary: status === TaskStatus.FAILED ? describeFailure(data.reason, kind) : null,
          resultSummary: this.lastAssistantText(sessionId),
        })
        this.onTask?.(task)
        return
      }
      default:
    }
  }

  /**
   * Latest assistant text for a session, unbounded.
   *
   * Truncation belongs to the service, which knows the configured limit; the
   * bridge deliberately does not, so the whole answer stays available for
   * other consumers of this state.
   */
  lastAssistantText(sessionId) {
    return this.sessions.get(sessionId)?.lastAssistant || null
  }

  #emitWaiting(sessionId, status, dedupeKey, extra) {
    const task = createTask({
      taskId: taskIdFor(`${sessionId}:${dedupeKey}`, 0),
      sessionId,
      turnId: null,
      title: this.sessionTitle(sessionId),
      status,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      errorSummary: null,
      resultSummary: null,
      ...extra,
    })
    this.onTask?.(task)
  }
}

/**
 * Parse the `ask_user_question` tool arguments into a question list.
 *
 * Defensive by design: the arguments are model-produced JSON and may be
 * truncated or absent, and a notification must never fail because of that.
 */
export function parseQuestions(args) {
  if (typeof args !== 'string' || !args.trim()) return []
  try {
    const parsed = JSON.parse(args)
    return Array.isArray(parsed?.questions) ? parsed.questions : []
  } catch {
    return []
  }
}

/** Render questions and their options as plain text for the mail body. */
export function renderQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return ''
  const lines = ['等待你回答以下问题：']
  for (const [index, question] of questions.entries()) {
    const header = question?.header ? `（${question.header}）` : ''
    lines.push(`${index + 1}. ${question?.question ?? '(未提供问题文本)'}${header}`)
    for (const [optionIndex, option] of (question?.options ?? []).entries()) {
      const label = option?.label ?? String(option)
      const description = option?.description ? ` — ${option.description}` : ''
      lines.push(`   ${String.fromCharCode(97 + optionIndex)}. ${label}${description}`)
    }
    if (question?.multi_select) lines.push('   （可多选）')
  }
  lines.push('请回到 DeepSeek Harness 内作答；本插件不会替你选择选项。')
  return lines.join('\n')
}

/** Human-readable failure text for a turn that ended badly. */
function describeFailure(reason, kind) {
  const detail =
    reason?.error?.message ??
    reason?.failure?.message ??
    reason?.message ??
    (typeof reason?.error === 'string' ? reason.error : null)
  if (detail) return String(detail).slice(0, 500)
  return TURN_END_REASON_TEXT[kind] ?? String(kind)
}
