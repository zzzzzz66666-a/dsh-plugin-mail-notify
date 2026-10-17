import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NotificationQueue, renderNotification } from '../../lib/notifications.js'
import { AuthenticationFailed, PermanentMailError, TransientMailError } from '../../lib/mail/errors.js'
import { NotificationStatus, TaskStatus, createTask } from '../../lib/domain.js'

const sandbox = () => mkdtempSync(join(tmpdir(), 'mail-notify-queue-'))
const fixed = () => new Date('2026-01-01T00:00:00.000Z')

/** A channel whose behaviour each test controls. */
function channel(behaviour) {
  const sent = []
  return {
    sent,
    async send(subject, body) {
      sent.push({ subject, body })
      if (behaviour) await behaviour(sent.length)
    },
  }
}

test('renderNotification carries the task identity, the code and the approval warning', () => {
  const task = createTask({
    taskId: 'task-abcd-t3',
    sessionId: 'abcdefgh-session',
    title: '修复登录',
    status: TaskStatus.COMPLETED,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:03.000Z',
    durationMs: 3000,
    resultSummary: '已修复。',
  })
  const { subject, body } = renderNotification(task, 'A1B2C3D4')
  assert.equal(subject, '[DSH][completed] 修复登录 - task-abcd-t3')
  assert.match(body, /本地任务编号：task-abcd-t3/)
  assert.match(body, /回复验证码：A1B2C3D4/)
  assert.match(body, /本次回复摘要：\n已修复。/)
  assert.match(body, /权限审批不能通过邮件批准/)
  assert.match(body, /回复有效期：24 小时内可多次回复/)
})

test('renderNotification honours a custom prefix and ttl', () => {
  const task = createTask({ taskId: 't', title: 'x', status: TaskStatus.FAILED })
  const { subject, body } = renderNotification(task, 'CODE', { subjectPrefix: '[OPS]', tokenTtlHours: 2 })
  assert.equal(subject, '[OPS][failed] x - t')
  assert.match(body, /回复有效期：2 小时/)
})

test('a notification is delivered once and never resent', async () => {
  const queue = new NotificationQueue({ path: join(sandbox(), 'n.json'), clock: fixed })
  queue.add({ notificationId: 'n-1', taskId: 't1', subject: 's', body: 'b' })
  const target = channel()
  assert.equal(await queue.sendOnce('n-1', target), true)
  assert.equal(await queue.sendOnce('n-1', target), false)
  assert.equal(target.sent.length, 1)
  assert.equal(queue.get('n-1').status, NotificationStatus.SENT)
})

test('add is idempotent for the same notification id', () => {
  const queue = new NotificationQueue({ clock: fixed })
  queue.add({ notificationId: 'n-1', taskId: 't1', subject: 'first' })
  queue.add({ notificationId: 'n-1', taskId: 't1', subject: 'second' })
  assert.equal(queue.records.size, 1)
  assert.equal(queue.get('n-1').subject, 'first')
})

test('a transient failure backs off exponentially and then gives up', async () => {
  const queue = new NotificationQueue({ maxRetries: 3, clock: fixed })
  queue.add({ notificationId: 'n-1', taskId: 't1', subject: 's', body: 'b' })
  const failing = channel(() => {
    throw new TransientMailError('server busy')
  })

  await queue.sendOnce('n-1', failing, fixed())
  let record = queue.get('n-1')
  assert.equal(record.status, NotificationStatus.RETRYING)
  assert.equal(record.retryCount, 1)
  assert.equal(record.nextRetryAt, new Date(fixed().getTime() + 2000).toISOString())

  // Still inside the backoff window: nothing is attempted.
  assert.equal(await queue.sendOnce('n-1', failing, new Date(fixed().getTime() + 1000)), false)
  assert.equal(queue.get('n-1').retryCount, 1)

  await queue.sendOnce('n-1', failing, new Date(fixed().getTime() + 2000))
  record = queue.get('n-1')
  assert.equal(record.retryCount, 2)
  assert.equal(record.nextRetryAt, new Date(fixed().getTime() + 2000 + 4000).toISOString())

  // Third attempt reaches maxRetries and parks the record as failed.
  await queue.sendOnce('n-1', failing, new Date(fixed().getTime() + 6000))
  record = queue.get('n-1')
  assert.equal(record.status, NotificationStatus.FAILED)
  assert.equal(record.nextRetryAt, null)
  assert.match(record.lastError, /^transient: server busy/)
})

test('a permanent failure stops immediately and is not retried automatically', async () => {
  const queue = new NotificationQueue({ clock: fixed })
  queue.add({ notificationId: 'n-1', taskId: 't1', subject: 's', body: 'b' })
  const failing = channel(() => {
    throw new PermanentMailError('bad recipient')
  })
  await queue.sendOnce('n-1', failing, fixed())
  const record = queue.get('n-1')
  assert.equal(record.status, NotificationStatus.FAILED)
  assert.equal(record.retryCount, 0)
  assert.equal(await queue.sendOnce('n-1', failing, fixed()), false)
  assert.equal(failing.sent.length, 1)
})

test('an authentication failure is classified as permanent, never transient', async () => {
  const queue = new NotificationQueue({ clock: fixed })
  queue.add({ notificationId: 'n-1', taskId: 't1', subject: 's', body: 'b' })
  const failing = channel(() => {
    throw new AuthenticationFailed('authorization code rejected')
  })
  await queue.sendOnce('n-1', failing, fixed())
  assert.equal(queue.get('n-1').lastError, 'authentication: authorization code rejected')
  assert.equal(queue.get('n-1').status, NotificationStatus.FAILED)
})

test('an unexpected error is treated as transient so nothing is lost', async () => {
  const queue = new NotificationQueue({ clock: fixed })
  queue.add({ notificationId: 'n-1', taskId: 't1', subject: 's', body: 'b' })
  const failing = channel(() => {
    throw new Error('socket exploded')
  })
  await queue.sendOnce('n-1', failing, fixed())
  assert.equal(queue.get('n-1').status, NotificationStatus.RETRYING)
})

test('manual retry ignores the backoff window but refuses an already-sent record', async () => {
  const queue = new NotificationQueue({ clock: fixed })
  queue.add({ notificationId: 'n-1', taskId: 't1', subject: 's', body: 'b' })
  const failing = channel(() => {
    throw new TransientMailError('down')
  })
  await queue.sendOnce('n-1', failing, fixed())
  assert.equal(queue.get('n-1').nextRetryAt !== null, true)

  const target = channel()
  assert.equal(await queue.retry('n-1', target, fixed()), true)
  assert.equal(queue.get('n-1').status, NotificationStatus.SENT)
  assert.equal(await queue.retry('n-1', target, fixed()), false)
})

test('retryFailed only touches exhausted records', async () => {
  const queue = new NotificationQueue({ clock: fixed })
  queue.add({ notificationId: 'n-ok', taskId: 't1', subject: 's', body: 'b' })
  queue.add({ notificationId: 'n-bad', taskId: 't2', subject: 's', body: 'b' })
  const target = channel()
  await queue.sendOnce('n-ok', target, fixed())
  await queue.sendOnce('n-bad', channel(() => {
    throw new PermanentMailError('nope')
  }), fixed())

  assert.deepEqual(queue.failedIds(), ['n-bad'])
  const results = await queue.retryFailed(target, fixed())
  assert.deepEqual(results, { 'n-bad': true })
})

test('recoverStaleSending turns a crashed send back into a retry', () => {
  const path = join(sandbox(), 'n.json')
  const queue = new NotificationQueue({ path, clock: fixed })
  queue.add({ notificationId: 'n-1', taskId: 't1', subject: 's', body: 'b' })
  // Simulate the marker a crash would leave behind.
  queue.get('n-1').status = NotificationStatus.SENDING
  queue.recoverStaleSending(fixed())

  const reloaded = new NotificationQueue({ path, clock: fixed })
  const record = reloaded.get('n-1')
  assert.equal(record.status, NotificationStatus.RETRYING)
  assert.equal(record.nextRetryAt, new Date(fixed().getTime() + 30000).toISOString())
})

test('queue state survives a restart', async () => {
  const path = join(sandbox(), 'n.json')
  const queue = new NotificationQueue({ path, clock: fixed })
  queue.add({ notificationId: 'n-1', taskId: 't1', subject: 'kept', body: 'body' })
  const reloaded = new NotificationQueue({ path, clock: fixed })
  assert.equal(reloaded.get('n-1').subject, 'kept')
  assert.equal(reloaded.summary().pending.length, 1)
})

test('dispatchDue only sends records whose backoff has elapsed', async () => {
  const queue = new NotificationQueue({ clock: fixed })
  queue.add({ notificationId: 'n-due', taskId: 't1', subject: 's', body: 'b' })
  queue.add({ notificationId: 'n-later', taskId: 't2', subject: 's', body: 'b' })
  queue.get('n-later').nextRetryAt = new Date(fixed().getTime() + 60_000).toISOString()

  const target = channel()
  const sent = await queue.dispatchDue(target, fixed())
  assert.deepEqual(sent, ['n-due'])
  assert.equal(target.sent.length, 1)
})

test('summary separates pending from failed records', () => {
  const queue = new NotificationQueue({ clock: fixed })
  queue.add({ notificationId: 'n-1', taskId: 't1' })
  queue.add({ notificationId: 'n-2', taskId: 't2' })
  queue.get('n-2').status = NotificationStatus.FAILED
  const summary = queue.summary()
  assert.deepEqual(summary.pending, ['n-1'])
  assert.deepEqual(summary.failed, ['n-2'])
  assert.equal(summary.total, 2)
})
