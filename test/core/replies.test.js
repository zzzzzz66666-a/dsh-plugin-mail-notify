import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ReplyValidator, TASK_RE, TokenStore, cleanReplyBody, secretsEqual } from '../../lib/replies.js'
import { ReplyVerification, TaskStatus, createTask } from '../../lib/domain.js'
import { renderNotification } from '../../lib/notifications.js'

const sandbox = () => mkdtempSync(join(tmpdir(), 'mail-notify-replies-'))
const fixed = () => new Date('2026-01-01T00:00:00.000Z')

function validator({ allowed = 'me@qq.com', ttlHours = 24, token = 'ABC123', maxLength = 8000 } = {}) {
  const tokens = new TokenStore({ clock: fixed })
  tokens.issue('t1', { ttlHours, token })
  return {
    tokens,
    validator: new ReplyValidator({
      allowedSender: allowed,
      tokenStore: tokens,
      seenMessageIds: new Set(),
      maxLength,
    }),
  }
}

const mail = (overrides = {}) => ({
  messageId: overrides.messageId ?? '<m1@example.com>',
  sender: overrides.sender ?? 'me@qq.com',
  subject: overrides.subject ?? '[DSH][completed] demo',
  text: overrides.text ?? '任务: t1\n验证码: ABC123\n继续做吧',
  html: overrides.html ?? null,
  hasAttachments: overrides.hasAttachments ?? false,
  receivedAt: overrides.receivedAt ?? fixed(),
})

test('an acceptable reply is accepted and its body cleaned', () => {
  const { validator: gate } = validator()
  const reply = gate.validate(mail())
  assert.equal(reply.verificationStatus, ReplyVerification.ACCEPTED)
  assert.equal(reply.taskId, 't1')
  assert.equal(reply.body, '任务: t1\n验证码: ABC123\n继续做吧')
})

test('the notification\u2019s own task-id line is accepted', () => {
  // Regression: the reference component rendered `本地任务编号：<id>` but its
  // task-id pattern required a colon directly after `任务`, so a user who
  // followed the instructions and kept that line was rejected outright.
  const task = createTask({ taskId: 'task-abcd-t3', title: 'demo', status: TaskStatus.COMPLETED })
  const { body } = renderNotification(task, 'ABC123')
  assert.match(body, /本地任务编号：task-abcd-t3/)

  const tokens = new TokenStore({ clock: fixed })
  tokens.issue('task-abcd-t3', { token: 'ABC123' })
  const gate = new ReplyValidator({
    allowedSender: 'me@qq.com',
    tokenStore: tokens,
    seenMessageIds: new Set(),
    maxLength: 8000,
  })
  const reply = gate.validate(mail({ text: body }))
  assert.equal(reply.verificationStatus, ReplyVerification.ACCEPTED)
  assert.equal(reply.taskId, 'task-abcd-t3')
})

test('every accepted task-id spelling resolves to the same id', () => {
  const forms = [
    '任务: t1',
    '任务：t1',
    '任务编号：t1',
    '本地任务编号：t1',
    'task: t1',
    'task id: t1',
    'TASK：t1',
  ]
  for (const form of forms) {
    assert.equal(TASK_RE.exec(form)?.[1], 't1', `expected ${form} to yield t1`)
  }
  assert.equal(TASK_RE.exec('没有任何标识'), null)
})

test('each rejection reason is reported exactly once', () => {
  const cases = [
    ['sender_not_allowed', { sender: 'evil@example.com' }],
    ['attachments_not_allowed', { hasAttachments: true }],
    ['task_id_missing', { text: '验证码: ABC123' }],
    ['token_missing', { text: '任务: t1' }],
    ['token_invalid', { text: '任务: t1\n验证码: WRONG1' }],
  ]
  for (const [reason, overrides] of cases) {
    const { validator: gate } = validator()
    const reply = gate.validate(mail(overrides))
    assert.equal(reply.verificationStatus, ReplyVerification.REJECTED, `${reason} should reject`)
    assert.equal(reply.rejectionReason, reason)
  }
})

test('a duplicate Message-ID is remembered even when the first copy was rejected', () => {
  const { validator: gate } = validator()
  const first = gate.validate(mail({ sender: 'evil@example.com' }))
  assert.equal(first.rejectionReason, 'sender_not_allowed')
  const second = gate.validate(mail())
  assert.equal(second.rejectionReason, 'duplicate_message_id')
})

test('a code stays usable until it expires', () => {
  // It used to be burned on first success, which made a second reply to the
  // same notification impossible. Reuse is bounded by the sender allow-list,
  // Message-ID de-duplication, the rate limit and the TTL instead.
  const { validator: gate, tokens } = validator()
  assert.equal(gate.validate(mail()).verificationStatus, ReplyVerification.ACCEPTED)
  const again = gate.validate(mail({ messageId: '<m2@example.com>' }))
  assert.equal(again.verificationStatus, ReplyVerification.ACCEPTED)
  assert.equal(again.taskId, 't1')
  assert.equal(tokens.check('t1', 'ABC123').ok, true, 'the code still validates')
  assert.equal(tokens.records.get('t1').useCount, 2, 'each acceptance is counted')
})

test('an expired code stops working even after successful uses', () => {
  const tokens = new TokenStore({ clock: fixed })
  tokens.issue('t1', { ttlHours: 1, token: 'ABC123' })
  assert.equal(tokens.check('t1', 'ABC123').ok, true)
  tokens.consume('t1')
  const later = new Date(fixed().getTime() + 2 * 3600 * 1000)
  assert.equal(tokens.check('t1', 'ABC123', later).reason, 'token_expired')
})

test('an expired code is rejected and a wrong task id has no code at all', () => {
  const { validator: gate } = validator({ ttlHours: 1 })
  const later = new Date(fixed().getTime() + 2 * 3600 * 1000)
  assert.equal(gate.tokenStore.check('t1', 'ABC123', later).reason, 'token_expired')
  assert.equal(gate.validate(mail({ text: '任务: other\n验证码: ABC123' })).rejectionReason, 'token_invalid')
})

test('an over-long body is rejected before any code is checked', () => {
  const { validator: gate } = validator({ maxLength: 10 })
  const reply = gate.validate(mail({ text: `任务: t1\n验证码: ABC123\n${'x'.repeat(50)}` }))
  assert.equal(reply.rejectionReason, 'body_too_long')
})

test('an HTML-only reply is converted to text before verification', () => {
  const { validator: gate } = validator()
  const reply = gate.validate(
    mail({
      text: '',
      html: '<div>任务: t1</div><div>验证码: ABC123</div><blockquote>历史引用</blockquote>',
    }),
  )
  assert.equal(reply.verificationStatus, ReplyVerification.ACCEPTED)
  assert.doesNotMatch(reply.body, /历史引用/)
})

test('quoted history and the signature are stripped from the body', () => {
  const body = ['任务: t1', '验证码: ABC123', ''].join('\n')
  const withQuote = `${body}\n> 这是引用\n在 2026 年写道：\n更多引用`
  const cleaned = cleanReplyBody(withQuote)
  assert.match(cleaned, /验证码: ABC123/)
  assert.doesNotMatch(cleaned, /这是引用/)
  assert.doesNotMatch(cleaned, /更多引用/)
})

test('a signature separator ends the body', () => {
  assert.equal(cleanReplyBody('任务: t1\n验证码: ABC123\n-- \n签名档'), '任务: t1\n验证码: ABC123')
})

test('a real QQ reply is accepted but delivers only the new sentence', () => {
  // The exact shape of a reply observed in production: the user typed one
  // sentence and QQ Mail appended the entire quoted notification underneath,
  // separator and header block included.
  const quoted = [
    '状态：completed',
    '任务标题：改造 Codex 通知插件供 Harness 使用',
    '本地任务编号：task-00f865-t12',
    '会话标识摘要：session-',
    '',
    '一次性验证码：8E5A40E6',
    '回复有效期：24 小时',
    '回复说明：直接回复本邮件并在正文保留上面的任务编号与验证码。',
  ].join('\n')

  const body = [
    '所以现在续聊功能成功了吗',
    '',
    '---原始邮件---',
    '发件人: "1902252007"<1902252007@qq.com&gt;',
    '发送时间: 2026年10月17日(周六) 上午9:04',
    '收件人: "1902252007"<1902252007@qq.com&gt;;',
    '主题: [DSH][completed] 改造 Codex 通知插件供 Harness 使用 - task-00f865-t12',
    '',
    quoted,
  ].join('\n')

  const tokens = new TokenStore({ clock: fixed })
  tokens.issue('task-00f865-t12', { token: '8E5A40E6' })
  const gate = new ReplyValidator({
    allowedSender: 'me@qq.com',
    tokenStore: tokens,
    seenMessageIds: new Set(),
    maxLength: 8000,
  })

  const reply = gate.validate(mail({ text: body }))

  // Accepted because the task id and the code sit in the quoted original — the
  // very reply the instructions ask for. Searching only the stripped body would
  // reject it.
  assert.equal(reply.verificationStatus, ReplyVerification.ACCEPTED)
  assert.equal(reply.taskId, 'task-00f865-t12')
  // …and only the sentence the user typed is delivered to the session.
  assert.equal(reply.body, '所以现在续聊功能成功了吗')
})

test('the QQ separator and its header block end the user\u2019s own words', () => {
  const separators = [
    '---原始邮件---',
    '----- 转发邮件 -----',
    '发件人: x@y.com',
    '发送时间: 2026年10月17日',
    '______________________________',
    '----',
  ]
  for (const separator of separators) {
    const body = `任务: t1\n验证码: ABC123\n${separator}\n引用的正文`
    assert.equal(cleanReplyBody(body), '任务: t1\n验证码: ABC123', `separator not honoured: ${separator}`)
  }
})

test('literal HTML entities in a plain-text body are decoded', () => {
  // QQ builds the text part by stripping tags without decoding entities.
  assert.equal(cleanReplyBody('任务: t1&nbsp;验证码: ABC123'), '任务: t1 验证码: ABC123')
  assert.equal(cleanReplyBody('a &amp; b'), 'a & b')
  assert.equal(cleanReplyBody('&#39;quoted&#39;'), "'quoted'")
  assert.equal(cleanReplyBody('caf\u00e9\u00a0here'), 'café here')
})

test('a body with no task id or code is still rejected', () => {
  // Stripping the quote must not turn an unverifiable mail into an accepted one.
  const { validator: gate } = validator()
  const reply = gate.validate(mail({ text: '随便写点什么\n---原始邮件---\n没有标识' }))
  assert.equal(reply.verificationStatus, ReplyVerification.REJECTED)
  assert.equal(reply.rejectionReason, 'task_id_missing')
})

test('secretsEqual compares content and length without throwing', () => {
  assert.equal(secretsEqual('ABCD', 'ABCD'), true)
  assert.equal(secretsEqual('ABCD', 'ABCE'), false)
  assert.equal(secretsEqual('ABCD', 'ABC'), false)
  assert.equal(secretsEqual('', ''), true)
})

test('a token store survives a restart and keeps its expiry', () => {
  const path = join(sandbox(), 'tokens.json')
  const store = new TokenStore({ path, clock: fixed })
  store.issue('t1', { token: 'KEEP1234' })
  const reloaded = new TokenStore({ path, clock: fixed })
  assert.deepEqual(reloaded.check('t1', 'KEEP1234').ok, true)
  assert.equal(reloaded.check('t1', 'WRONG').ok, false)
})

test('issued codes are unique uppercase hex with the expected ttl', () => {
  const store = new TokenStore({ clock: fixed })
  const first = store.issue('a')
  const second = store.issue('b')
  assert.match(first.token, /^[0-9A-F]{8}$/)
  assert.notEqual(first.token, second.token)
  assert.equal(first.expiresAt, new Date(fixed().getTime() + 24 * 3600 * 1000).toISOString())
})
