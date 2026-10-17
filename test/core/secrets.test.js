import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTH_CODE_REF,
  CredentialsServiceSecretStore,
  FallbackSecretStore,
  FileSecretStore,
  MemorySecretStore,
  createSecretStore,
  credentialsFilePath,
  probeCredentialsService,
  readRefFromCredentialsDocument,
} from '../../lib/secrets.js'

const DOCUMENT = `version: 1
refs:
  DSH_MAIL_NOTIFY_AUTH_CODE: 'abcd1234efgh5678'
  OTHER_KEY: "plain-value"
records:
  client-connection/browser-session:
    kind: grant
    payload:
      secret: unrelated
`

function tempFile(contents) {
  const path = join(mkdtempSync(join(tmpdir(), 'mail-notify-secrets-')), '.credentials.yaml')
  writeFileSync(path, contents)
  return path
}

test('reads a reference out of the managed document', () => {
  assert.equal(readRefFromCredentialsDocument(DOCUMENT, AUTH_CODE_REF), 'abcd1234efgh5678')
  assert.equal(readRefFromCredentialsDocument(DOCUMENT, 'OTHER_KEY'), 'plain-value')
})

test('never reads a value out of the records section', () => {
  // `secret: unrelated` is a record payload, not a reference.
  assert.equal(readRefFromCredentialsDocument(DOCUMENT, 'secret'), null)
  assert.equal(readRefFromCredentialsDocument(DOCUMENT, 'kind'), null)
})

test('handles quoting, comments and a missing section', () => {
  const quoted = `version: 1
refs:
  # a comment
  A: 'it''s here'

  B: "double"
records: {}
`
  assert.equal(readRefFromCredentialsDocument(quoted, 'A'), "it's here")
  assert.equal(readRefFromCredentialsDocument(quoted, 'B'), 'double')
  assert.equal(readRefFromCredentialsDocument(quoted, 'C'), null)
  assert.equal(readRefFromCredentialsDocument('version: 1\nrecords: {}\n', 'A'), null)
  assert.equal(readRefFromCredentialsDocument('', 'A'), null)
})

test('an unparseable document yields null rather than a wrong value', () => {
  assert.equal(readRefFromCredentialsDocument('refs: not-a-section\n', AUTH_CODE_REF), null)
})

test('credentialsFilePath honours the environment override and the harness home', () => {
  assert.equal(credentialsFilePath({ DSH_MAIL_NOTIFY_CREDENTIALS_FILE: 'X:/custom.yaml' }), 'X:/custom.yaml')
  assert.equal(credentialsFilePath({ DSH_HOME: 'X:/home' }), join('X:/home', '.credentials.yaml'))
})

test('FileSecretStore reads but refuses to write', async () => {
  const path = tempFile(DOCUMENT)
  const store = new FileSecretStore(path)
  assert.equal(store.kind, 'credentials-file')
  assert.equal(store.persistent, true)
  assert.equal(await store.read(AUTH_CODE_REF), 'abcd1234efgh5678')
  assert.equal(await store.read('MISSING'), null)
  await assert.rejects(() => store.save(AUTH_CODE_REF, 'x'), /never writes it/)
  await assert.rejects(() => store.delete(AUTH_CODE_REF), /uninstall\.mjs/)
})

test('FileSecretStore reports a missing file as absent, not an error', async () => {
  const store = new FileSecretStore(join(mkdtempSync(join(tmpdir(), 'mail-notify-none-')), 'nope.yaml'))
  assert.equal(await store.read(AUTH_CODE_REF), null)
})

test('probeCredentialsService finds the service through ctx.get', () => {
  const service = { resolve() {}, set() {}, describe() {} }
  const probe = probeCredentialsService({ get: (name) => (name === 'credentials' ? service : undefined) })
  assert.equal(probe.service, service)
  assert.equal(probe.via, 'ctx.get')
})

test('probeCredentialsService falls back to the plain property', () => {
  const service = { resolve() {}, set() {} }
  const probe = probeCredentialsService({
    get() {
      return undefined
    },
    credentials: service,
  })
  assert.equal(probe.service, service)
  assert.equal(probe.via, 'ctx.credentials')
})

test('probeCredentialsService reports every failed lookup without throwing', () => {
  const probe = probeCredentialsService({
    get() {
      throw new Error('service not found')
    },
    get credentials() {
      throw new Error('isolated')
    },
    reflect: {
      get() {
        return undefined
      },
    },
  })
  assert.equal(probe.service, null)
  assert.equal(probe.via, 'none')
  assert.equal(probe.attempts.length, 3)
  assert.match(probe.attempts[0].error, /not found/)
  assert.match(probe.attempts[1].error, /isolated/)
})

test('probeCredentialsService rejects a service without resolve()', () => {
  const probe = probeCredentialsService({ get: () => ({ set() {} }) })
  assert.equal(probe.service, null)
})

/** A path that is guaranteed not to exist, so the document fallback stays out of the way. */
function absentFile() {
  return join(mkdtempSync(join(tmpdir(), 'mail-notify-absent-')), 'absent.yaml')
}

test('createSecretStore prefers the credentials service when no document exists', () => {
  const service = { resolve() {}, set() {} }
  const store = createSecretStore({
    credentials: service,
    env: { DSH_MAIL_NOTIFY_CREDENTIALS_FILE: absentFile() },
  })
  assert.ok(store instanceof CredentialsServiceSecretStore)
  assert.equal(store.kind, 'credentials-service')
})

test('createSecretStore wraps the service with a document fallback', async () => {
  const path = tempFile(DOCUMENT)
  // A seam that resolves nothing while the document it reads plainly has the
  // reference: exactly the situation that made the plugin idle with no
  // explanation. The read must succeed and the disagreement must be reported.
  const service = {
    async resolve() {
      return undefined
    },
    async set() {},
    async describe() {
      return { configured: false, writable: true }
    },
  }
  const reported = []
  const store = createSecretStore({
    credentials: service,
    env: { DSH_MAIL_NOTIFY_CREDENTIALS_FILE: path },
    onFallback: (message) => reported.push(message),
  })

  assert.ok(store instanceof FallbackSecretStore)
  assert.equal(store.kind, 'credentials-service', 'the seam is still the primary store')
  assert.equal(await store.read(AUTH_CODE_REF), 'abcd1234efgh5678')
  assert.equal(store.usedFallback, true)
  assert.equal(reported.length, 1)
  assert.match(reported[0], /did not resolve/)
  assert.match(reported[0], /credentials-service/)
})

test('no fallback read happens while the seam resolves the value', async () => {
  const path = tempFile(DOCUMENT)
  const reported = []
  const store = createSecretStore({
    credentials: {
      async resolve() {
        return { value: 'from-service' }
      },
      async set() {},
    },
    env: { DSH_MAIL_NOTIFY_CREDENTIALS_FILE: path },
    onFallback: (message) => reported.push(message),
  })
  assert.ok(store instanceof FallbackSecretStore, 'a usable seam must be wrapped, not replaced')
  assert.equal(await store.read(AUTH_CODE_REF), 'from-service')
  assert.equal(store.usedFallback, false)
  assert.deepEqual(reported, [])
})

test('a throwing seam still allows the document fallback', async () => {
  const path = tempFile(DOCUMENT)
  const store = createSecretStore({
    credentials: {
      async resolve() {
        throw new Error('store is closing')
      },
      async set() {},
    },
    env: { DSH_MAIL_NOTIFY_CREDENTIALS_FILE: path },
  })
  assert.ok(store instanceof FallbackSecretStore)
  assert.equal(await store.read(AUTH_CODE_REF), 'abcd1234efgh5678')
})

test('a service missing set() is not treated as the seam', () => {
  // The seam must be writable to be usable; a resolve-only object is not it.
  const store = createSecretStore({
    credentials: { resolve() {} },
    env: { DSH_MAIL_NOTIFY_CREDENTIALS_FILE: absentFile() },
  })
  assert.ok(store instanceof MemorySecretStore)
})

test('the wrapped store still writes through the seam', async () => {
  const path = tempFile(DOCUMENT)
  const calls = []
  const store = createSecretStore({
    credentials: {
      async resolve() {
        return undefined
      },
      async set(ref, value) {
        calls.push(['set', ref, value])
      },
      async unset(ref) {
        calls.push(['unset', ref])
      },
    },
    env: { DSH_MAIL_NOTIFY_CREDENTIALS_FILE: path },
  })
  await store.save(AUTH_CODE_REF, 'new-secret')
  await store.delete(AUTH_CODE_REF)
  assert.deepEqual(calls, [
    ['set', AUTH_CODE_REF, 'new-secret'],
    ['unset', AUTH_CODE_REF],
  ])
})

test('createSecretStore falls back to the file when the service is unreachable', () => {
  const path = tempFile(DOCUMENT)
  const store = createSecretStore({ credentials: null, env: { DSH_MAIL_NOTIFY_CREDENTIALS_FILE: path } })
  assert.ok(store instanceof FileSecretStore)
  assert.equal(store.reason, 'credentials-service-unreachable')
})

test('createSecretStore falls back to memory when there is no file either', () => {
  const nowhere = join(mkdtempSync(join(tmpdir(), 'mail-notify-empty-')), 'absent.yaml')
  const store = createSecretStore({ credentials: null, env: { DSH_MAIL_NOTIFY_CREDENTIALS_FILE: nowhere } })
  assert.ok(store instanceof MemorySecretStore)
  assert.equal(store.kind, 'memory')
  assert.match(store.reason, /no-file/)
})

test('the memory opt-in overrides everything', () => {
  const path = tempFile(DOCUMENT)
  const store = createSecretStore({
    credentials: { resolve() {}, set() {} },
    env: { DSH_MAIL_NOTIFY_SECRET_STORE: 'memory', DSH_MAIL_NOTIFY_CREDENTIALS_FILE: path },
  })
  assert.ok(store instanceof MemorySecretStore)
  assert.equal(store.reason, 'env-override')
})

test('an end-to-end read through the file store finds the real reference', async () => {
  const path = tempFile(DOCUMENT)
  const store = createSecretStore({ credentials: null, env: { DSH_MAIL_NOTIFY_CREDENTIALS_FILE: path } })
  assert.equal(await store.read(AUTH_CODE_REF), 'abcd1234efgh5678')
})

test('CredentialsServiceSecretStore delegates and never exposes a value it lacks', async () => {
  const calls = []
  const service = {
    async resolve(ref) {
      calls.push(['resolve', ref])
      return ref === AUTH_CODE_REF ? { value: 'from-service', source: 'store' } : undefined
    },
    async set(ref, value) {
      calls.push(['set', ref, value])
    },
    async unset(ref) {
      calls.push(['unset', ref])
    },
    async describe() {
      return { configured: false, writable: true }
    },
  }
  const store = new CredentialsServiceSecretStore(service)
  assert.equal(await store.read(AUTH_CODE_REF), 'from-service')
  assert.equal(await store.read('MISSING'), null)
  await store.save(AUTH_CODE_REF, 'value')
  await store.delete(AUTH_CODE_REF)
  assert.deepEqual(calls, [
    ['resolve', AUTH_CODE_REF],
    ['resolve', 'MISSING'],
    ['set', AUTH_CODE_REF, 'value'],
    ['unset', AUTH_CODE_REF],
  ])
  await assert.rejects(() => store.save(AUTH_CODE_REF, ''), /must not be empty/)
})

test('the service store treats an empty stored value as not configured', async () => {
  const store = new CredentialsServiceSecretStore({ async resolve() {
    return { value: '' }
  } })
  assert.equal(await store.read(AUTH_CODE_REF), null)
})
