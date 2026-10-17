/**
 * Domain records and the task state machine.
 *
 * This is the transport-independent core: nothing here knows about mail, the
 * harness or the filesystem. Statuses and transitions are ported from the
 * reference component so both implementations reject the same illegal moves.
 *
 * @module dsh-plugin-mail-notify/domain
 */

/** Lifecycle of one notifiable unit of work. */
export const TaskStatus = Object.freeze({
  DISCOVERED: 'discovered',
  RUNNING: 'running',
  WAITING_USER_INPUT: 'waiting_user_input',
  WAITING_APPROVAL: 'waiting_approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
})

/** Delivery lifecycle of one queued notification. */
export const NotificationStatus = Object.freeze({
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  RETRYING: 'retrying',
  FAILED: 'failed',
})

/** How far a received reply got through verification. */
export const ReplyVerification = Object.freeze({
  RECEIVED: 'received',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
})

/** How far a verified reply got towards the session. */
export const ReplySubmission = Object.freeze({
  NOT_SUBMITTED: 'not_submitted',
  QUEUED: 'queued',
  SUBMITTED: 'submitted',
  FAILED: 'failed',
})

/** Current time as an ISO string; injectable clocks make the tests deterministic. */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * Legal task transitions.
 *
 * `COMPLETED`, `FAILED` and `INTERRUPTED` are terminal. A turn that has ended
 * must never be re-opened, otherwise a late poll would email the same work
 * twice.
 */
export const TASK_TRANSITIONS = Object.freeze({
  [TaskStatus.DISCOVERED]: [TaskStatus.RUNNING, TaskStatus.INTERRUPTED],
  [TaskStatus.RUNNING]: [
    TaskStatus.WAITING_USER_INPUT,
    TaskStatus.WAITING_APPROVAL,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.INTERRUPTED,
  ],
  [TaskStatus.WAITING_USER_INPUT]: [
    TaskStatus.RUNNING,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.INTERRUPTED,
  ],
  [TaskStatus.WAITING_APPROVAL]: [TaskStatus.RUNNING, TaskStatus.FAILED, TaskStatus.INTERRUPTED],
  [TaskStatus.COMPLETED]: [],
  [TaskStatus.FAILED]: [],
  [TaskStatus.INTERRUPTED]: [],
})

/** Statuses that describe a finished turn. */
export const TERMINAL_STATUSES = new Set([
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.INTERRUPTED,
])

/** Build a task record with defaults applied. */
export function createTask(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: '',
    sessionId: '',
    turnId: null,
    title: '',
    status: TaskStatus.DISCOVERED,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    errorSummary: null,
    resultSummary: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  }
}

/** Build a notification record with defaults applied. */
export function createNotification(overrides = {}) {
  return {
    schemaVersion: 1,
    notificationId: '',
    taskId: '',
    channel: 'email',
    status: NotificationStatus.PENDING,
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
    sentAt: null,
    subject: '',
    body: '',
    ...overrides,
  }
}

/** Build a reply record with defaults applied. */
export function createReply(overrides = {}) {
  return {
    schemaVersion: 1,
    replyId: '',
    messageId: '',
    senderAddress: '',
    taskId: '',
    sessionId: '',
    turnId: null,
    verificationStatus: ReplyVerification.RECEIVED,
    submissionStatus: ReplySubmission.NOT_SUBMITTED,
    receivedAt: nowIso(),
    processedAt: null,
    rejectionReason: null,
    body: '',
    ...overrides,
  }
}

/**
 * Move `task` to `target`, stamping the timing fields the notification renders.
 *
 * @returns {boolean} true when the status actually changed.
 * @throws {Error} when the transition is not legal.
 */
export function transitionTask(task, target, at = new Date()) {
  if (task.status === target) return false
  const allowed = TASK_TRANSITIONS[task.status] || []
  if (!allowed.includes(target)) {
    throw new Error(`illegal task transition: ${task.status} -> ${target}`)
  }
  const stamp = at.toISOString()
  if (target === TaskStatus.RUNNING && !task.startedAt) task.startedAt = stamp
  if (TERMINAL_STATUSES.has(target)) {
    task.completedAt = stamp
    if (task.startedAt) {
      task.durationMs = Math.max(0, at.getTime() - new Date(task.startedAt).getTime())
    }
  }
  task.status = target
  task.updatedAt = stamp
  return true
}
