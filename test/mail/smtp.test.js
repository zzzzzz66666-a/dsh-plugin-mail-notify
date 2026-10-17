import test from 'node:test'
import assert from 'node:assert/strict'

import { SmtpMailSender } from '../../lib/mail/smtp.js'
import { buildMessage, parseMessage } from '../../lib/mail/mime.js'
import { AuthenticationFailed, CertificateError, MailError, PermanentMailError, TransientMailError } from '../../lib/mail/errors.js'
import { INSECURE_TLS, startSmtpServer } from './fake-servers.js'

/** Build a sender pointed at a fake server. */
function senderFor(port, overrides = {}) {
  return new SmtpMailSender({
    host: '127.0.0.1',
    port,
    security: 'ssl',
    username: 'me@qq.com',
    password: 'authorization-code',
    timeoutMs: 5000,
    tlsOptions: INSECURE_TLS,
    ...overrides,
  })
}

test('send drives a complete SMTP conversation and returns the Message-ID', async () => {
  const server = await startSmtpServer()
  try {
    const sender = senderFor(server.port)
    const messageId = await sender.send({
      sender: 'me@qq.com',
      to: 'me@qq.com',
      subject: 'hello',
      body: 'world',
    })

    assert.match(messageId, /^<.+@.+>$/)
    const verbs = server.commands.map((line) => line.split(/\s+/)[0].toUpperCase())
    assert.deepEqual(verbs, ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT'])
    assert.match(server.commands[2], /^MAIL FROM:<me@qq\.com>$/)
    assert.match(server.commands[3], /^RCPT TO:<me@qq\.com>$/)
    assert.equal(server.credentials.username, 'me@qq.com')
    assert.equal(server.credentials.password, 'authorization-code')
    assert.equal(server.messages.length, 1)
  } finally {
    await server.close()
  }
})

test('a Chinese subject and body survive the wire round-trip', async () => {
  const server = await startSmtpServer()
  try {
    await senderFor(server.port).send({
      sender: 'me@qq.com',
      to: 'me@qq.com',
      subject: '[DSH][completed] 部署服务 - task-abcd-t3',
      body: '状态：completed\n一次性验证码：A1B2C3D4\n',
    })

    const parsed = parseMessage(server.messages[0])
    assert.equal(parsed.subject, '[DSH][completed] 部署服务 - task-abcd-t3')
    assert.match(parsed.text, /一次性验证码：A1B2C3D4/)
    assert.equal(parsed.sender, 'me@qq.com')
    assert.equal(parsed.isNotification, true, 'the notification header must mark our own mail')
  } finally {
    await server.close()
  }
})

test('a body line that is a single dot is transmitted intact', async () => {
  const server = await startSmtpServer()
  try {
    await senderFor(server.port).send({
      sender: 'me@qq.com',
      to: 'me@qq.com',
      subject: 'dot',
      body: 'before\n.\nafter\n',
    })
    const parsed = parseMessage(server.messages[0])
    // Without dot-stuffing the lone dot would end DATA and truncate the message.
    assert.match(parsed.text, /before/)
    assert.match(parsed.text, /after/)
    assert.match(parsed.text, /^\s*\.\s*$/m)
  } finally {
    await server.close()
  }
})

test('a non-notification kind is still tagged so the receiver can filter', async () => {
  const server = await startSmtpServer()
  try {
    await senderFor(server.port).send({
      sender: 'me@qq.com',
      to: 'me@qq.com',
      subject: 'x',
      body: 'y',
      kind: 'test',
    })
    const parsed = parseMessage(server.messages[0])
    assert.equal(parsed.isNotification, true)
  } finally {
    await server.close()
  }
})

test('test() authenticates and issues NOOP without sending mail', async () => {
  const server = await startSmtpServer()
  try {
    await senderFor(server.port).test()
    const verbs = server.commands.map((line) => line.split(/\s+/)[0].toUpperCase())
    assert.deepEqual(verbs, ['EHLO', 'AUTH', 'NOOP', 'QUIT'])
    assert.equal(server.messages.length, 0)
  } finally {
    await server.close()
  }
})

test('a rejected authorization code raises AuthenticationFailed', async () => {
  const server = await startSmtpServer({ failAuth: true })
  try {
    await assert.rejects(
      () => senderFor(server.port).send({ sender: 'me@qq.com', to: 'me@qq.com', subject: 's', body: 'b' }),
      (error) => {
        assert.ok(error instanceof AuthenticationFailed, `expected AuthenticationFailed, got ${error?.name}`)
        assert.equal(error.category, 'authentication')
        assert.equal(error.retryable, false)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('a refused recipient raises a permanent failure', async () => {
  const server = await startSmtpServer({ failRcpt: true })
  try {
    await assert.rejects(
      () => senderFor(server.port).send({ sender: 'me@qq.com', to: 'nobody@qq.com', subject: 's', body: 'b' }),
      (error) => {
        assert.ok(error instanceof PermanentMailError)
        assert.equal(error.category, 'permanent')
        assert.equal(error.retryable, false)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('a 4xx on the final DATA dot raises a transient failure', async () => {
  const server = await startSmtpServer({ failData: true })
  try {
    await assert.rejects(
      () => senderFor(server.port).send({ sender: 'me@qq.com', to: 'me@qq.com', subject: 's', body: 'b' }),
      (error) => {
        assert.ok(error instanceof TransientMailError, `expected TransientMailError, got ${error?.name}`)
        assert.equal(error.retryable, true)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('the self-signed certificate is rejected by default', async () => {
  const server = await startSmtpServer()
  try {
    const strict = senderFor(server.port, { tlsOptions: {} })
    await assert.rejects(
      () => strict.send({ sender: 'me@qq.com', to: 'me@qq.com', subject: 's', body: 'b' }),
      (error) => {
        assert.ok(error instanceof CertificateError, `expected CertificateError, got ${error?.name}`)
        assert.equal(error.category, 'tls')
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('an unreachable server raises a transient failure', async () => {
  const server = await startSmtpServer()
  const deadPort = server.port
  await server.close()

  await assert.rejects(
    () => senderFor(deadPort).send({ sender: 'me@qq.com', to: 'me@qq.com', subject: 's', body: 'b' }),
    (error) => {
      assert.ok(error instanceof TransientMailError, `expected TransientMailError, got ${error?.name}`)
      assert.equal(error.retryable, true)
      return true
    },
  )
})

test('the constructor rejects an unsupported security mode', () => {
  assert.throws(() => senderFor(1, { security: 'plain' }), MailError)
  assert.throws(() => senderFor(1, { host: '' }), MailError)
})

test('send requires both sender and recipient', async () => {
  const sender = senderFor(1)
  await assert.rejects(() => sender.send({ to: 'me@qq.com', subject: 's', body: 'b' }), MailError)
  await assert.rejects(() => sender.send({ sender: 'me@qq.com', subject: 's', body: 'b' }), MailError)
})

test('our own Message-ID domain still marks the mail as a notification', () => {
  // Some providers rewrite or drop unknown `X-` headers. Without a second
  // marker a notification would look exactly like a reply — it quotes a task id
  // and a live one-time code — and would be fed back into the session.
  const raw = buildMessage({ sender: 'me@qq.com', to: 'me@qq.com', subject: 's', body: 'b' })
  const stripped = raw.replace(/^X-Agent-Mail-Notify:.*\r\n/m, '')
  assert.doesNotMatch(stripped, /X-Agent-Mail-Notify/)
  assert.equal(parseMessage(stripped).isNotification, true)
})

test('a foreign message is not mistaken for a notification', () => {
  const raw = buildMessage({ sender: 'other@example.com', to: 'me@qq.com', subject: 'hi', body: 'there' })
  const stripped = raw
    .replace(/^X-Agent-Mail-Notify:.*\r\n/m, '')
    .replace(/^Message-ID:.*\r\n/m, 'Message-ID: <tencent_ABC123@qq.com>\r\n')
  assert.equal(parseMessage(stripped).isNotification, false)
})

test('buildMessage emits the headers the SMTP path relies on', () => {
  const raw = buildMessage({ sender: 'a@b.com', to: 'c@d.com', subject: 'Hi', body: 'there' })
  assert.match(raw, /^From: a@b\.com\r\n/)
  assert.match(raw, /\r\nTo: c@d\.com\r\n/)
  assert.match(raw, /\r\nMessage-ID: <[^>]+>\r\n/)
  assert.match(raw, /\r\nX-Agent-Mail-Notify: notification\r\n/)
  assert.ok(raw.endsWith('\r\n'))
})
