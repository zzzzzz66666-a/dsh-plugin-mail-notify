import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HarnessBridge } from '../../lib/bridge.js'
import { MemorySecretStore, AUTH_CODE_REF } from '../../lib/secrets.js'
import { MailNotifyService } from '../../lib/service.js'
import { TaskStatus, createTask } from '../../lib/domain.js'

const sandbox = () => mkdtempSync(join(tmpdir(), 'mail-notify-e2e-'))
const fixed = () => new Date('2026-01-01T00:00:00.000Z')

const MAIL_CONFIG = {
  senderEmail: 'me@qq.com',
  recipientEmail: 'me@qq.com',
  allowedReplyEmail: 'me@qq.com',
  pollIntervalMs: 30000,
  subjectPrefix: '[DSH]',
}

/** Recording fake for the SMTP side. */
function fakeSender(behaviour = null) {
  return {
    sent: [],
    async send(mail) {
      this.sent.push(mail)
      if (behaviour) await behaviour(mail, this.sent.length)
    },
  }
}

/** Fake IMAP side: hands out a fixed batch, then nothing. */
function fakeReceiver(batches) {
  const queue = [...batches]
  return {
    acked: [],
    async receive() {
      return queue.shift() ?? []
    },
    async acknowledgeMany(uids) {
      this.acked.push(...uids)
    },
  }
}

/** Build a service wired to fakes, with a live in-process bridge. */
function setup({ config = MAIL_CONFIG, mail = [], code = 'secret-code' } = {}) {
  const sessionId = 'session-abc'
  const agent = {
    status: 'idle',
    followups: [],
    followup(message) {
      this.followups.push(message)
    },
  }
  const ctx = { get: (name) => (name === 'agents' ? { get: (id) => (id === sessionId ? agent : undefined) } : null) }
  const bridge = new HarnessBridge({ ctx, onTask: (task) => service.handleTask(task) })
  const secrets = new MemorySecretStore()
  const sender = fakeSender()
  const receiver = fakeReceiver(mail)

  const service = new MailNotifyService({
    ctx,
    config,
    bridge,
    clock: fixed,
    dataDir: sandbox(),
    secretStore: secrets,
    senderFactory: () => sender,
    receiverFactory: () => receiver,
  })
  return { service, bridge, secrets, sender, receiver, agent, sessionId, code }
}

/** A raw inbound message shaped like the IMAP layer's output. */
function incoming(overrides = {}) {
  return {
    uid: overrides.uid ?? '101',
    messageId: overrides.messageId ?? '<reply-1@example.com>',
    sender: overrides.sender ?? 'me@qq.com',
    subject: overrides.subject ?? '[DSH][completed] demo',
    text: overrides.text ?? '任务: TASKID\n验证码: CODE',
    html: null,
    hasAttachments: false,
    isNotification: overrides.isNotification ?? false,
    receivedAt: fixed(),
  }
}

test('a completed turn is emailed once, with a usable one-time code', async () => {
  const { service, secrets, sender, sessionId } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()
  assert.equal(service.configured, true)

  service.handleTask(
    createTask({
      taskId: 'task-aaa-t1',
      sessionId,
      turnId: '1',
      title: '部署',
      status: TaskStatus.COMPLETED,
      resultSummary: '完成。',
    }),
  )
  await service.runOnce()

  assert.equal(sender.sent.length, 1)
  const mail = sender.sent[0]
  assert.equal(mail.to, 'me@qq.com')
  assert.equal(mail.sender, 'me@qq.com')
  assert.match(mail.subject, /^\[DSH\]\[completed\] 部署 - task-aaa-t1$/)
  assert.match(mail.body, /本地任务编号：task-aaa-t1/)

  // The code in the mail is the one the validator will accept.
  const code = /验证码：([0-9A-F]{8})/.exec(mail.body)?.[1]
  assert.ok(code, 'the mail must carry a one-time code')
  assert.equal(service.tokens.check('task-aaa-t1', code).ok, true)
  await service.stop()
})

test('the same task never produces a second mail', async () => {
  const { service, secrets, sender, sessionId } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()

  const task = createTask({ taskId: 'task-aaa-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED })
  service.handleTask(task)
  service.handleTask(task)
  await service.runOnce()

  assert.equal(sender.sent.length, 1)
  await service.stop()
})

test('the plugin ignores the notification mail that comes back through the mailbox', async () => {
  const { service, secrets, receiver, agent } = setup({
    mail: [[incoming({ isNotification: true, uid: '900', text: '任务: task-aaa-t1\n验证码: DEADBEEF' })]],
  })
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()
  await service.pollReplies()

  assert.equal(agent.followups.length, 0)
  assert.deepEqual(receiver.acked, [], 'an ignored message must not be marked read')
  await service.stop()
})

test('a valid reply reaches the session and its mail is acknowledged', async () => {
  const { service, secrets, sender, agent, sessionId, receiver } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()

  service.handleTask(
    createTask({ taskId: 'task-aaa-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED }),
  )
  await service.runOnce()
  const code = /验证码：([0-9A-F]{8})/.exec(sender.sent[0].body)[1]

  // Second poll returns a genuine reply quoting the task id and the code.
  receiver.receive = async () => [
    incoming({ uid: '102', messageId: '<reply-2@example.com>', text: `本地任务编号：task-aaa-t1\n一次性验证码：${code}\n请继续` }),
  ]
  const result = await service.pollReplies()

  assert.deepEqual(result.submitted, ['submitted'])
  assert.equal(agent.followups.length, 1)
  // The body is submitted verbatim, exactly as the reference component did:
  // the user is told to keep the task-id and code lines, so those lines are
  // part of what they wrote and part of what the session receives.
  const submitted = agent.followups[0].content[0].text
  assert.match(submitted, /请继续/)
  assert.match(submitted, /task-aaa-t1/)
  assert.deepEqual(receiver.acked, ['102'], 'only consumed mail is marked read')
  await service.stop()
})

test('mail whose subject lacks the queue tag is ignored locally', async () => {
  // QQ Mail's IMAP ignores text search criteria — SUBJECT and TEXT both return
  // the same set regardless of the string — so the server cannot be trusted to
  // filter by tag. Unrelated mail inside the date window must be dropped here,
  // before it reaches the validator or the audit log.
  const { service, secrets, receiver, agent } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()
  receiver.receive = async () => [
    incoming({
      uid: '1',
      messageId: '<newsletter@example.com>',
      subject: '每周通讯：本周更新',
      text: '任务: task-aaa-t1\n验证码: ABC123',
    }),
  ]

  const result = await service.pollReplies()

  assert.deepEqual(result.rejected, [], 'unrelated mail must not be reported as a rejected reply')
  assert.equal(agent.followups.length, 0)
  assert.deepEqual(receiver.acked, [])
  assert.deepEqual(service.audit.records.filter((record) => record.action === 'reply.reject'), [])
  await service.stop()
})

test('a reply is recognised by the tag even with a client-added prefix', async () => {
  const { service, secrets, sender, receiver, agent, sessionId } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()
  service.handleTask(
    createTask({ taskId: 'task-aaa-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED }),
  )
  await service.runOnce()
  const code = /验证码：([0-9A-F]{8})/.exec(sender.sent[0].body)[1]

  receiver.receive = async () => [
    incoming({
      uid: '9',
      messageId: '<prefixed@qq.com>',
      subject: '回复：[DSH][completed] demo',
      text: `本地任务编号：task-aaa-t1\n一次性验证码：${code}\n请继续`,
    }),
  ]
  const result = await service.pollReplies()
  assert.deepEqual(result.submitted, ['submitted'])
  assert.equal(agent.followups.length, 1)
  await service.stop()
})

test('a rejected reply is never submitted and never marked read', async () => {
  const { service, secrets, receiver, agent } = setup({
    mail: [
      [
        incoming({ uid: '1', messageId: '<r1>', sender: 'evil@example.com', text: '任务: t\n验证码: ABC123' }),
        incoming({ uid: '2', messageId: '<r2>', text: '任务: t\n验证码: WRONG' }),
      ],
    ],
  })
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()
  const result = await service.pollReplies()

  assert.deepEqual(result.submitted, [])
  assert.equal(result.rejected.length, 2)
  assert.equal(agent.followups.length, 0)
  assert.deepEqual(receiver.acked, [])
  await service.stop()
})

test('a second reply to the same notification is accepted', async () => {
  // The failure that motivated this: replying again to one notification — the
  // obvious way to add a follow-up thought — used to be rejected because the
  // code had been burned. It is now reusable until it expires.
  const { service, secrets, sender, receiver, agent, sessionId } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()
  service.handleTask(
    createTask({ taskId: 'task-aaa-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED }),
  )
  await service.runOnce()
  const code = /验证码：([0-9A-F]{8})/.exec(sender.sent[0].body)[1]

  receiver.receive = async () => [
    incoming({ uid: '1', messageId: '<a>', text: `任务: task-aaa-t1\n验证码: ${code}\n第一次` }),
  ]
  const first = await service.pollReplies()
  receiver.receive = async () => [
    incoming({ uid: '2', messageId: '<b>', text: `任务: task-aaa-t1\n验证码: ${code}\n第二次` }),
  ]
  const second = await service.pollReplies()

  assert.deepEqual(first.submitted, ['submitted'])
  assert.deepEqual(second.submitted, ['submitted'], 'the same code must still work')
  assert.equal(agent.followups.length, 2, 'both replies reach the session')
  // The task id and code are in the user's own text here (nothing is quoted),
  // so the delivered body keeps them along with the new sentence.
  assert.match(agent.followups[1].content[0].text, /第二次/)
  assert.equal(service.tokens.records.get('task-aaa-t1').useCount, 2)
  await service.stop()
})

test('a replayed identical message is still dropped by Message-ID', async () => {
  // Reusability must not turn into replay: the same mail delivered twice is
  // still processed exactly once.
  const { service, secrets, sender, receiver, agent, sessionId } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()
  service.handleTask(
    createTask({ taskId: 'task-aaa-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED }),
  )
  await service.runOnce()
  const code = /验证码：([0-9A-F]{8})/.exec(sender.sent[0].body)[1]

  const duplicate = incoming({ uid: '1', messageId: '<same>', text: `任务: task-aaa-t1\n验证码: ${code}\n再说一次` })
  receiver.receive = async () => [duplicate]
  await service.pollReplies()
  receiver.receive = async () => [duplicate]
  await service.pollReplies()

  assert.equal(agent.followups.length, 1, 'a redelivered mail must not drive the agent twice')
  await service.stop()
})

test('a reply arriving while an approval is pending is queued, not submitted', async () => {
  const { service, secrets, sender, receiver, agent, bridge, sessionId } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()
  service.handleTask(
    createTask({ taskId: 'task-aaa-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED }),
  )
  await service.runOnce()
  const code = /验证码：([0-9A-F]{8})/.exec(sender.sent[0].body)[1]

  // The session asks for approval before the reply is handled.
  bridge.handleSessionEvent({ id: sessionId, log: [] }, {
    type: 'approval/asked',
    data: { id: 'ap1', toolName: 'pwsh' },
    time: 1,
  })

  receiver.receive = async () => [
    incoming({ uid: '1', messageId: '<a>', text: `任务: task-aaa-t1\n验证码: ${code}\n继续` }),
  ]
  const result = await service.pollReplies()

  assert.deepEqual(result.submitted, [])
  assert.deepEqual(result.queued, ['queued_approval'])
  assert.equal(agent.followups.length, 0, 'approval can never be granted by mail')
  assert.equal(service.router.queue.length, 1)
  await service.stop()
})

test('an unconfigured plugin loads, reports why, and does nothing', async () => {
  const { service, sender } = setup({ config: { senderEmail: '', recipientEmail: '', allowedReplyEmail: '' } })
  await service.start()
  assert.equal(service.configured, false)
  assert.match(service.configError, /invalid email/)

  service.handleTask(createTask({ taskId: 't', sessionId: 's', title: 'x', status: TaskStatus.COMPLETED }))
  await service.runOnce()
  assert.equal(sender.sent.length, 0)
  await service.stop()
})

test('a missing credential keeps the plugin idle instead of throwing', async () => {
  const { service } = setup()
  await service.start()
  assert.equal(service.configured, false)
  assert.equal(service.credentialConfigured, false)
  assert.match(service.health().credentialRef, /DSH_MAIL_NOTIFY_AUTH_CODE/)
  await service.stop()
})

test('a credential stored after start is picked up on the next cycle', async () => {
  // The real-world sequence: the plugin boots before the user has stored the
  // authorization code, and must start working on its own once they do —
  // without a second restart.
  const { service, secrets, sender, sessionId } = setup()
  await service.start()
  assert.equal(service.credentialConfigured, false)
  assert.equal(service.configured, false)

  await secrets.save(AUTH_CODE_REF, 'late-arriving-code')
  await service.runOnce()

  assert.equal(service.credentialConfigured, true)
  assert.equal(service.configured, true)

  service.handleTask(
    createTask({ taskId: 'task-aaa-t9', sessionId, turnId: '9', title: '迟到', status: TaskStatus.COMPLETED }),
  )
  await service.runOnce()
  assert.equal(sender.sent.length, 1, 'the plugin must work without a restart')
  assert.match(sender.sent[0].subject, /task-aaa-t9/)
  await service.stop()
})

test('rotating the credential rebuilds the cached transports', async () => {
  const { service, secrets, sessionId } = setup()
  await secrets.save(AUTH_CODE_REF, 'first-code')
  await service.start()
  service.handleTask(
    createTask({ taskId: 'task-aaa-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED }),
  )
  await service.runOnce()
  const before = service.cachedSender

  await secrets.save(AUTH_CODE_REF, 'second-code')
  await service.runOnce()

  assert.equal(service.authorizationCode, 'second-code')
  assert.notEqual(service.cachedSender, before, 'a stale password must not stay in a cached transport')
  await service.stop()
})

test('removing the credential puts the plugin back to idle', async () => {
  const { service, secrets } = setup()
  await secrets.save(AUTH_CODE_REF, 'code')
  await service.start()
  assert.equal(service.configured, true)

  await secrets.delete(AUTH_CODE_REF)
  await service.runOnce()
  assert.equal(service.credentialConfigured, false)
  assert.equal(service.configured, false)
  await service.stop()
})

test('health never exposes the authorization code', async () => {
  const { service, secrets } = setup()
  await secrets.save(AUTH_CODE_REF, 'super-secret-code')
  await service.start()
  const health = JSON.stringify(service.health())
  assert.doesNotMatch(health, /super-secret-code/)
  assert.equal(service.health().credentialConfigured, true)
  await service.stop()
})

test('a mail transport failure is recorded and retried, never thrown', async () => {
  const { service, secrets, sessionId } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()

  const { TransientMailError } = await import('../../lib/mail/errors.js')
  let attempts = 0
  service.cachedSender = {
    async send() {
      attempts += 1
      throw new TransientMailError('mailbox unreachable')
    },
  }

  service.handleTask(
    createTask({ taskId: 'task-aaa-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED }),
  )
  const sent = await service.dispatchDue()
  assert.deepEqual(sent, [])
  assert.equal(attempts >= 1, true)
  // A transient failure parks the notification as retrying, not as lost.
  const record = service.queue.get('n-task-aaa-t1-completed')
  assert.equal(record.status, 'retrying')
  assert.match(record.lastError, /^transient: mailbox unreachable/)
  assert.ok(service.health().pendingNotifications.includes('n-task-aaa-t1-completed'))
  await service.stop()
})

test('the plugin works when the credentials seam cannot see its own document', async () => {
  // Reproduces the production failure: the seam is reachable but resolves
  // nothing, while the managed document plainly holds the reference. Before the
  // fallback existed this left the plugin permanently idle and reporting only
  // "not configured", which is indistinguishable from a user who never
  // configured anything.
  const directory = mkdtempSync(join(tmpdir(), 'mail-notify-seam-'))
  const credentialsPath = join(directory, '.credentials.yaml')
  writeFileSync(credentialsPath, `version: 1\nrefs:\n  ${AUTH_CODE_REF}: 'from-the-document'\nrecords: {}\n`)

  const previous = process.env.DSH_MAIL_NOTIFY_CREDENTIALS_FILE
  process.env.DSH_MAIL_NOTIFY_CREDENTIALS_FILE = credentialsPath
  try {
    const sessionId = 'session-abc'
    const agent = {
      status: 'idle',
      followups: [],
      followup(message) {
        this.followups.push(message)
      },
    }
    const seam = {
      async resolve() {
        return undefined
      },
      async set() {},
      async unset() {},
      async describe() {
        return { configured: false, writable: true }
      },
    }
    const ctx = {
      get: (name) => (name === 'agents' ? { get: (id) => (id === sessionId ? agent : undefined) } : seam),
    }
    const sender = fakeSender()
    let service = null
    const bridge = new HarnessBridge({ ctx, onTask: (task) => service.handleTask(task) })
    service = new MailNotifyService({
      ctx,
      config: MAIL_CONFIG,
      bridge,
      clock: fixed,
      dataDir: sandbox(),
      senderFactory: () => sender,
    })

    await service.start()
    assert.equal(service.credentialConfigured, true, 'the document must be used when the seam cannot see it')
    assert.equal(service.configured, true)
    assert.equal(service.health().credentialStore, 'credentials-service', 'the seam stays the primary store')

    service.handleTask(
      createTask({ taskId: 'task-seam-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED }),
    )
    await service.runOnce()
    assert.equal(sender.sent.length, 1, 'mail must actually be sent')
    assert.match(sender.sent[0].subject, /task-seam-t1/)
    await service.stop()
  } finally {
    if (previous === undefined) delete process.env.DSH_MAIL_NOTIFY_CREDENTIALS_FILE
    else process.env.DSH_MAIL_NOTIFY_CREDENTIALS_FILE = previous
  }
})

test('a message already examined is not re-audited on every poll', async () => {
  // Rejected mail is deliberately left unread, so IMAP hands it back on every
  // poll. Re-validating it cannot change the answer, and auditing it again
  // turned a handful of stale messages into hundreds of identical entries.
  const { service, secrets, receiver } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()

  const batch = [
    incoming({ uid: '1', messageId: '<stale-1@qq.com>', text: '任务: nope\n验证码: WRONG001' }),
    incoming({ uid: '2', messageId: '<stale-2@qq.com>', text: '任务: nope\n验证码: WRONG002' }),
  ]
  receiver.receive = async () => batch

  for (let cycle = 0; cycle < 6; cycle += 1) await service.pollReplies()

  const rejections = service.audit.records.filter((record) => record.action === 'reply.reject')
  assert.equal(rejections.length, 2, 'each message must be audited exactly once')
  assert.deepEqual(rejections.map((record) => record.result), ['token_invalid', 'token_invalid'])
  await service.stop()
})

test('a fresh reply still passes after an earlier poll skipped stale mail', async () => {
  const { service, secrets, sender, receiver, agent, sessionId } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()
  service.handleTask(
    createTask({ taskId: 'task-aaa-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED }),
  )
  await service.runOnce()
  const code = /验证码：([0-9A-F]{8})/.exec(sender.sent[0].body)[1]

  const stale = incoming({ uid: '1', messageId: '<stale@qq.com>', text: '任务: nope\n验证码: WRONG001' })
  receiver.receive = async () => [stale]
  await service.pollReplies()

  // The user's real reply arrives in a later poll, alongside the stale message.
  const genuine = incoming({
    uid: '2',
    messageId: '<genuine@qq.com>',
    text: `本地任务编号：task-aaa-t1\n一次性验证码：${code}\n请继续`,
  })
  receiver.receive = async () => [stale, genuine]
  const result = await service.pollReplies()

  assert.deepEqual(result.submitted, ['submitted'])
  assert.equal(agent.followups.length, 1)
  assert.deepEqual(receiver.acked, ['2'], 'only the genuine reply is marked read')
  await service.stop()
})

test('the queue file is written so an unsent notification survives a restart', async () => {
  const { service, secrets, sessionId } = setup()
  await secrets.save(AUTH_CODE_REF, 'secret-code')
  await service.start()
  service.cachedSender = {
    async send() {
      const { TransientMailError } = await import('../../lib/mail/errors.js')
      throw new TransientMailError('offline')
    },
  }
  service.handleTask(
    createTask({ taskId: 'task-aaa-t1', sessionId, turnId: '1', title: 'x', status: TaskStatus.COMPLETED }),
  )
  await service.dispatchDue()

  const path = join(service.dataDir, 'notifications.json')
  assert.equal(existsSync(path), true)
  const persisted = JSON.parse(readFileSync(path, 'utf8'))
  assert.ok(persisted['n-task-aaa-t1-completed'])
  await service.stop()
})
