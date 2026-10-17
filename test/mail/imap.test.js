import test from 'node:test'
import assert from 'node:assert/strict'

import { ImapMailReceiver, buildSearchCriteria, imapDate } from '../../lib/mail/imap.js'
import { buildMessage } from '../../lib/mail/mime.js'
import { AuthenticationFailed, MailError, PermanentMailError, TransientMailError } from '../../lib/mail/errors.js'
import { INSECURE_TLS, startImapServer } from './fake-servers.js'

/** Build a raw notification message the way the sender would. */
function rawNotification({ subject = '[DSH][completed] demo', body = '本地任务编号：task-abcd-t3\n一次性验证码：A1B2C3D4\n' } = {}) {
  return buildMessage({ sender: 'me@qq.com', to: 'me@qq.com', subject, body })
}

function receiverFor(port, overrides = {}) {
  return new ImapMailReceiver({
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

test('receive fetches and parses messages over a literal-framed FETCH', async () => {
  const server = await startImapServer({
    messages: [
      { uid: '101', raw: rawNotification({ subject: '[DSH][completed] 部署 - task-abcd-t3' }) },
      { uid: '102', raw: rawNotification({ subject: '[DSH][failed] 构建 - task-efgh-t4', body: '错误摘要：超时\n' }) },
    ],
  })
  try {
    const messages = await receiverFor(server.port).receive()
    assert.equal(messages.length, 2)
    assert.equal(messages[0].uid, '101')
    assert.equal(messages[0].subject, '[DSH][completed] 部署 - task-abcd-t3')
    assert.match(messages[0].text, /一次性验证码：A1B2C3D4/)
    assert.equal(messages[0].isNotification, true)
    assert.equal(messages[1].subject, '[DSH][failed] 构建 - task-efgh-t4')
    assert.match(messages[1].text, /错误摘要：超时/)
  } finally {
    await server.close()
  }
})

test('receive sends the configured search criteria', async () => {
  const server = await startImapServer({ messages: [{ uid: '7', raw: rawNotification() }] })
  try {
    await receiverFor(server.port, { searchCriteria: ['UNSEEN', 'SUBJECT', '"[OPS]"'] }).receive()
    const search = server.commands.find((line) => /UID SEARCH/i.test(line))
    assert.match(search, /UID SEARCH UNSEEN SUBJECT "\[OPS\]"$/)
  } finally {
    await server.close()
  }
})

test('the default search criteria are subject-tagged and never unseen-only', async () => {
  const server = await startImapServer({ messages: [{ uid: '7', raw: rawNotification() }] })
  try {
    await receiverFor(server.port).receive()
    const search = server.commands.find((line) => /UID SEARCH/i.test(line))
    assert.match(search, /UID SEARCH SUBJECT "\[DSH\]"$/)
    // A reply can arrive already read; searching UNSEEN would never see it.
    assert.doesNotMatch(search, /UNSEEN/)
  } finally {
    await server.close()
  }
})

test('buildSearchCriteria bounds the search by date and tag', () => {
  const criteria = buildSearchCriteria({ subjectTag: '[OPS]', now: new Date('2026-10-16T12:00:00Z'), lookbackDays: 3 })
  assert.deepEqual(criteria, ['SINCE', '13-Oct-2026', 'SUBJECT', '"[OPS]"'])
  assert.doesNotMatch(criteria.join(' '), /UNSEEN/)
})

test('buildSearchCriteria defaults to a three-day lookback', () => {
  const criteria = buildSearchCriteria({ now: new Date('2026-01-05T00:00:00Z') })
  assert.deepEqual(criteria, ['SINCE', '02-Jan-2026', 'SUBJECT', '"[DSH]"'])
})

test('sinceUid fetches only mail that arrived after the mark', async () => {
  // The latency fix: without the mark every poll re-downloads the whole search
  // window, and because the newest UID is fetched last a reply waits behind
  // every older message before it is even read.
  const messages = [
    { uid: '1', raw: rawNotification({ subject: '[DSH] one' }) },
    { uid: '2', raw: rawNotification({ subject: '[DSH] two' }) },
  ]
  const server = await startImapServer({ messages })
  try {
    const receiver = receiverFor(server.port, { sinceUid: 0 })
    const first = await receiver.receive()
    assert.equal(first.length, 2)
    assert.equal(receiver.lastUid, 2)

    messages.push({ uid: '3', raw: rawNotification({ subject: '[DSH] three' }) })
    receiver.sinceUid = receiver.lastUid
    const second = await receiver.receive()
    assert.deepEqual(second.map((message) => message.uid), ['3'])
    assert.equal(receiver.lastUid, 3)

    receiver.sinceUid = receiver.lastUid
    assert.deepEqual(await receiver.receive(), [], 'a quiet mailbox fetches nothing')

    // Three FETCHes in total proves the two older messages were not re-read.
    const fetches = server.commands.filter((line) => /UID FETCH/i.test(line))
    assert.equal(fetches.length, 3)
  } finally {
    await server.close()
  }
})

test('a mailbox whose UIDs move backwards is re-scanned once', async () => {
  const messages = [{ uid: '9', raw: rawNotification() }]
  const server = await startImapServer({ messages })
  try {
    // A mark beyond every UID in the mailbox is what a UID reset looks like.
    const receiver = receiverFor(server.port, { sinceUid: 50 })
    const batch = await receiver.receive()
    assert.equal(receiver.uidReset, true, 'the reset must be reported to the caller')
    assert.equal(batch.length, 1, 'the window is re-scanned rather than silently skipped')
    assert.equal(receiver.lastUid, 9, 'the mark re-baselines to the new UID space')
  } finally {
    await server.close()
  }
})

test('imapDate formats English month names regardless of locale', () => {
  assert.equal(imapDate(new Date('2026-10-01T00:00:00Z')), '01-Oct-2026')
  assert.equal(imapDate(new Date('2026-01-31T23:59:59Z')), '31-Jan-2026')
  assert.equal(imapDate(new Date('2026-12-09T00:00:00Z')), '09-Dec-2026')
})

test('maxPerPoll keeps only the newest matches', async () => {
  const server = await startImapServer({
    messages: [1, 2, 3, 4].map((n) => ({ uid: String(n), raw: rawNotification({ subject: `[DSH] m${n}` }) })),
  })
  try {
    const messages = await receiverFor(server.port, { maxPerPoll: 2 }).receive()
    assert.deepEqual(messages.map((message) => message.uid), ['3', '4'])
  } finally {
    await server.close()
  }
})

test('acknowledgeMany marks exactly the given UIDs as seen', async () => {
  const server = await startImapServer({ messages: [{ uid: '101', raw: rawNotification() }] })
  try {
    await receiverFor(server.port).acknowledgeMany(['101', '102'])
    assert.deepEqual(server.stored, ['101', '102'])
    const stores = server.commands.filter((line) => /UID STORE/i.test(line))
    assert.equal(stores.length, 2)
    assert.match(stores[0], /UID STORE 101 \+FLAGS \(\\Seen\)$/)
  } finally {
    await server.close()
  }
})

test('acknowledgeMany opens no connection for an empty list', async () => {
  const server = await startImapServer()
  try {
    await receiverFor(server.port).acknowledgeMany([])
    await receiverFor(server.port).acknowledgeMany([null, ''])
    assert.deepEqual(server.commands, [])
  } finally {
    await server.close()
  }
})

test('testConnection logs in and selects the mailbox', async () => {
  const server = await startImapServer()
  try {
    await receiverFor(server.port).testConnection()
    const verbs = server.commands.map((line) => line.split(/\s+/)[1]?.toUpperCase())
    assert.ok(verbs.includes('LOGIN'))
    assert.ok(verbs.includes('SELECT'))
    assert.ok(verbs.includes('LOGOUT'))
  } finally {
    await server.close()
  }
})

test('listFolders reports the folder names', async () => {
  const server = await startImapServer()
  try {
    const folders = await receiverFor(server.port).listFolders()
    assert.deepEqual(folders.map((folder) => folder.name), ['INBOX', 'Archive'])
  } finally {
    await server.close()
  }
})

test('recent searches all messages, not just unseen ones', async () => {
  const server = await startImapServer({ messages: [{ uid: '5', raw: rawNotification() }] })
  try {
    const messages = await receiverFor(server.port).recent(10)
    assert.equal(messages.length, 1)
    assert.ok(server.commands.some((line) => /UID SEARCH ALL$/.test(line)))
  } finally {
    await server.close()
  }
})

test('a rejected login raises AuthenticationFailed', async () => {
  const server = await startImapServer({ failLogin: true })
  try {
    await assert.rejects(
      () => receiverFor(server.port).receive(),
      (error) => {
        assert.ok(error instanceof AuthenticationFailed, `expected AuthenticationFailed, got ${error?.name}`)
        assert.equal(error.category, 'authentication')
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('a refused mailbox raises a permanent failure', async () => {
  const server = await startImapServer({ failSelect: true })
  try {
    await assert.rejects(
      () => receiverFor(server.port).receive(),
      (error) => {
        assert.ok(error instanceof PermanentMailError, `expected PermanentMailError, got ${error?.name}`)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('an unreachable server raises a transient failure', async () => {
  const server = await startImapServer()
  const deadPort = server.port
  await server.close()

  await assert.rejects(
    () => receiverFor(deadPort).receive(),
    (error) => {
      assert.ok(error instanceof TransientMailError, `expected TransientMailError, got ${error?.name}`)
      assert.equal(error.retryable, true)
      return true
    },
  )
})

test('the constructor rejects an unsupported security mode', () => {
  assert.throws(() => receiverFor(1, { security: 'plain' }), MailError)
})

test('a message with an embedded literal-looking sequence is framed correctly', async () => {
  // The literal is announced by byte length, so a body containing `}` and CRLF
  // sequences must still be read back byte-for-byte.
  const body = 'line one\n}\r\n{99}\nlast line\n'
  const server = await startImapServer({ messages: [{ uid: '1', raw: rawNotification({ body }) }] })
  try {
    const messages = await receiverFor(server.port).receive()
    assert.equal(messages.length, 1)
    assert.match(messages[0].text, /last line/)
  } finally {
    await server.close()
  }
})
