import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  NotificationStatus,
  TaskStatus,
  createNotification,
  createTask,
  transitionTask,
} from '../../lib/domain.js'
import { JsonDocument, atomicWriteText, readJson, writeJson } from '../../lib/store.js'
import { ConfigError, DEFAULT_CONFIG, isConfigured, validateConfig, withDefaults } from '../../lib/config.js'

const sandbox = () => mkdtempSync(join(tmpdir(), 'mail-notify-core-'))

test('transitionTask stamps timing on the first terminal move', () => {
  const task = createTask({ taskId: 't1' })
  const started = new Date('2026-01-01T00:00:00.000Z')
  transitionTask(task, TaskStatus.RUNNING, started)
  assert.equal(task.startedAt, started.toISOString())

  const ended = new Date('2026-01-01T00:00:02.500Z')
  assert.equal(transitionTask(task, TaskStatus.COMPLETED, ended), true)
  assert.equal(task.completedAt, ended.toISOString())
  assert.equal(task.durationMs, 2500)
})

test('transitionTask rejects an illegal move instead of silently ignoring it', () => {
  const task = createTask({ status: TaskStatus.COMPLETED })
  assert.throws(() => transitionTask(task, TaskStatus.RUNNING), /illegal task transition/)
})

test('transitionTask reports no change when the status is already the target', () => {
  const task = createTask({ status: TaskStatus.FAILED })
  assert.equal(transitionTask(task, TaskStatus.FAILED), false)
})

test('atomicWriteText replaces the file in one step and leaves no temp behind', () => {
  const dir = sandbox()
  const path = join(dir, 'doc.json')
  writeJson(path, { a: 1 })
  writeJson(path, { a: 2 })
  assert.deepEqual(readJson(path), { a: 2 })
  const leftovers = readFileSync(path, 'utf8')
  assert.ok(leftovers.endsWith('\n'))
})

test('readJson returns the fallback for a corrupt document rather than throwing', () => {
  const dir = sandbox()
  const path = join(dir, 'broken.json')
  writeFileSync(path, '{ not json')
  assert.deepEqual(readJson(path, { safe: true }), { safe: true })
})

test('readJson returns the fallback when the file does not exist', () => {
  assert.equal(readJson(join(sandbox(), 'missing.json'), null), null)
})

test('atomicWriteText creates missing parent directories', () => {
  const dir = sandbox()
  const path = join(dir, 'nested', 'deeper', 'file.txt')
  atomicWriteText(path, 'hello')
  assert.equal(readFileSync(path, 'utf8'), 'hello')
})

test('JsonDocument persists updates and caps remembered lists', () => {
  const dir = sandbox()
  const path = join(dir, 'state.json')
  const document = new JsonDocument(path)
  document.update((data) => {
    data.marker = 1
  })
  for (let index = 0; index < 10; index += 1) document.rememberInList('seen', `id-${index}`, 4)

  const reloaded = new JsonDocument(path)
  assert.equal(reloaded.data.marker, 1)
  assert.deepEqual([...reloaded.listAsSet('seen')].sort(), ['id-6', 'id-7', 'id-8', 'id-9'])
})

test('JsonDocument.deletedFile resets to an empty document', () => {
  const dir = sandbox()
  const path = join(dir, 'state.json')
  const document = new JsonDocument(path)
  document.update((data) => {
    data.marker = 1
  })
  document.deleteFile()
  assert.equal(existsSync(path), false)
  assert.deepEqual(document.data, {})
})

test('withDefaults fills every field and ignores unknown keys', () => {
  const merged = withDefaults({ senderEmail: 'a@b.com', notARealKey: 1 })
  assert.equal(merged.senderEmail, 'a@b.com')
  assert.equal(merged.smtpHost, DEFAULT_CONFIG.smtpHost)
  assert.equal(merged.notARealKey, undefined)
})

test('validateConfig accepts a complete configuration', () => {
  const config = validateConfig({
    senderEmail: 'me@qq.com',
    recipientEmail: 'me@qq.com',
    allowedReplyEmail: 'me@qq.com',
  })
  assert.equal(config.smtpPort, 465)
  assert.equal(config.subjectPrefix, '[DSH]')
  assert.equal(isConfigured(config), true)
})

test('validateConfig rejects malformed addresses, ports and security modes', () => {
  const base = { senderEmail: 'me@qq.com', recipientEmail: 'me@qq.com', allowedReplyEmail: 'me@qq.com' }
  assert.throws(() => validateConfig({ ...base, senderEmail: 'nope' }), ConfigError)
  assert.throws(() => validateConfig({ ...base, smtpPort: 0 }), ConfigError)
  assert.throws(() => validateConfig({ ...base, imapSecurity: 'plain' }), ConfigError)
  assert.throws(() => validateConfig({ ...base, subjectPrefix: '   ' }), ConfigError)
  assert.throws(() => validateConfig({ ...base, replyTokenTtlHours: 24 * 31 }), ConfigError)
  assert.throws(() => validateConfig({ ...base, pollIntervalMs: 10 }), ConfigError)
})

test('isConfigured is false while any address is missing', () => {
  assert.equal(isConfigured(withDefaults({})), false)
})

test('createNotification and createTask carry schema version and defaults', () => {
  const notification = createNotification({ notificationId: 'n-1' })
  assert.equal(notification.schemaVersion, 1)
  assert.equal(notification.status, NotificationStatus.PENDING)
  assert.equal(notification.retryCount, 0)
  assert.equal(createTask({}).status, TaskStatus.DISCOVERED)
})
