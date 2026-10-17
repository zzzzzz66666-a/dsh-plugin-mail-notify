import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

import {
  AUTH_CODE_REF,
  ROW_ID,
  readPluginRowConfig,
  removeCredentialRef,
  removePluginRow,
  renderPluginRow,
  unquoteScalar,
  upsertCredentialRef,
  upsertPluginRow,
} from '../../scripts/lib/profile-edit.mjs'

/** The real profile patch, reproduced so the editors are tested on real input. */
const REAL_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
- insert:
    - id: ui-frosted-glass
      name: 'dsh-plugin-frosted-glass'
- id: ui-settings-account
  name: "@deepseek-ai/dsh-client-ui-settings-account"
  config:
    version: 1
    step: done
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: max
`

/** A credentials document with records but no refs, as found on a real machine. */
const REAL_CREDENTIALS = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: abc
  deepseek-account-platform/default:
    kind: grant
    payload:
      token: def
`

/** Load a real YAML parser when one is pointed at, else fall back to structure checks. */
async function loadYaml() {
  const candidate = process.env.DSH_YAML_MODULE
  if (!candidate) return null
  try {
    return await import(pathToFileURL(candidate).href)
  } catch {
    return null
  }
}

/** Minimal structural check: indentation of the row must be internally consistent. */
function assertRowShape(text, markerIndent = 4) {
  const lines = text.split('\n')
  const idLine = lines.findIndex((line) => line.trim() === `- id: ${ROW_ID}`)
  assert.notEqual(idLine, -1, 'the row must be present')
  assert.equal(lines[idLine].length - lines[idLine].trimStart().length, markerIndent)
  assert.equal(lines[idLine + 1].trim(), "name: 'dsh-plugin-mail-notify'")
  assert.equal(lines[idLine + 1].length - lines[idLine + 1].trimStart().length, markerIndent + 2)
  if (lines[idLine + 2]?.trim() === 'config:') {
    assert.equal(lines[idLine + 2].length - lines[idLine + 2].trimStart().length, markerIndent + 2)
    for (let index = idLine + 3; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '') continue
      const indent = line.length - line.trimStart().length
      if (indent <= markerIndent) break
      assert.equal(indent, markerIndent + 4, `config entry out of line: ${line}`)
    }
  }
}

const CONFIG = {
  senderEmail: 'me@qq.com',
  recipientEmail: 'me@qq.com',
  allowedReplyEmail: 'me@qq.com',
  smtpPort: 465,
  smtpSecurity: 'ssl',
  notificationsEnabled: true,
  subjectPrefix: '[DSH]',
}

test('renderPluginRow quotes every string and leaves numbers and booleans bare', () => {
  const lines = renderPluginRow(CONFIG)
  assert.equal(lines[0], `    - id: ${ROW_ID}`)
  assert.equal(lines[1], "      name: 'dsh-plugin-mail-notify'")
  assert.equal(lines[2], '      config:')
  assert.ok(lines.includes("        senderEmail: 'me@qq.com'"))
  assert.ok(lines.includes('        smtpPort: 465'))
  assert.ok(lines.includes('        notificationsEnabled: true'))
  assert.ok(lines.includes("        subjectPrefix: '[DSH]'"))
})

test('a new row is appended to a real profile patch without disturbing it', () => {
  const next = upsertPluginRow(REAL_PATCH, CONFIG)
  for (const original of ['ui-frosted-glass', 'ui-settings-account', 'agent-default-model']) {
    assert.match(next, new RegExp(original))
  }
  assert.match(next, /^# Your patch layer for this dsh profile/m)
  assertRowShape(next)
  // The existing single-row insert block and the four top-level entries remain.
  assert.equal(next.match(/^- insert:/gm).length, 2)
  assert.equal(next.match(/^- id: ui-settings-account$/gm).length, 1)
})

test('applying the same row twice replaces it instead of adding a duplicate', () => {
  const once = upsertPluginRow(REAL_PATCH, CONFIG)
  const twice = upsertPluginRow(once, { ...CONFIG, senderEmail: 'other@qq.com' })
  assert.equal(twice.match(new RegExp(`- id: ${ROW_ID}`, 'g')).length, 1)
  assert.match(twice, /senderEmail: 'other@qq\.com'/)
  assert.doesNotMatch(twice, /senderEmail: 'me@qq\.com'/)
  assert.equal(twice.match(/^- insert:/gm).length, 2)
})

test('an existing row keeps its own indentation when updated', () => {
  const nested = `- insert:\n    - id: ${ROW_ID}\n      name: 'dsh-plugin-mail-notify'\n`
  const next = upsertPluginRow(nested, CONFIG)
  assertRowShape(next, 4)
  assert.equal(next.match(new RegExp(`- id: ${ROW_ID}`, 'g')).length, 1)
})

test('an empty array document is replaced, not appended to', () => {
  const next = upsertPluginRow('# just a comment\n[]\n', CONFIG)
  assert.doesNotMatch(next, /^\s*\[\s*\]\s*$/m)
  assertRowShape(next)
  assert.match(next, /^# just a comment$/m)
})

test('an entirely empty document produces a loadable patch', () => {
  const next = upsertPluginRow('', CONFIG)
  assertRowShape(next)
  assert.ok(next.startsWith('- insert:'))
})

test('a row without config is valid and adds no config block', () => {
  const next = upsertPluginRow(REAL_PATCH, {})
  assertRowShape(next)
  // Scoped to the new row: the document already has config blocks of its own.
  const lines = next.split('\n')
  const idLine = lines.findIndex((line) => line.trim() === `- id: ${ROW_ID}`)
  assert.notEqual(lines[idLine + 2].trim(), 'config:')
})

test('removing the row leaves the rest of the profile intact', () => {
  const withRow = upsertPluginRow(REAL_PATCH, CONFIG)
  const { text, removed } = removePluginRow(withRow)
  assert.equal(removed, true)
  assert.doesNotMatch(text, new RegExp(ROW_ID))
  // The original insert block and its frosted-glass row survive.
  assert.match(text, /ui-frosted-glass/)
  assert.equal(text.match(/^- insert:/gm).length, 1)
  assert.match(text, /agent-default-model/)
})

test('removing an absent row is a no-op', () => {
  const { text, removed } = removePluginRow(REAL_PATCH)
  assert.equal(removed, false)
  assert.equal(text, REAL_PATCH)
})

test('a credential reference is created after version when refs is absent', () => {
  const next = upsertCredentialRef(REAL_CREDENTIALS, AUTH_CODE_REF, 'auth-code-1')
  const lines = next.split('\n')
  assert.equal(lines[0], 'version: 1')
  assert.equal(lines[1], 'refs:')
  assert.equal(lines[2], `  ${AUTH_CODE_REF}: 'auth-code-1'`)
  // `records:` keeps its content and stays a top-level key.
  assert.ok(lines.includes('records:'))
  assert.match(next, /client-connection\/browser-session:/)
  assert.match(next, /token: def/)
})

test('an existing reference is replaced, not duplicated', () => {
  const once = upsertCredentialRef(REAL_CREDENTIALS, AUTH_CODE_REF, 'first')
  const twice = upsertCredentialRef(once, AUTH_CODE_REF, 'second')
  assert.equal(twice.match(new RegExp(AUTH_CODE_REF, 'g')).length, 1)
  assert.match(twice, new RegExp(`${AUTH_CODE_REF}: 'second'`))
  assert.doesNotMatch(twice, /'first'/)
})

test('a second reference is added inside the existing refs section', () => {
  const withOne = upsertCredentialRef(REAL_CREDENTIALS, 'OTHER_KEY', 'value-a')
  const withTwo = upsertCredentialRef(withOne, AUTH_CODE_REF, 'value-b')
  assert.match(withTwo, /OTHER_KEY: 'value-a'/)
  assert.match(withTwo, new RegExp(`${AUTH_CODE_REF}: 'value-b'`))
  assert.equal(withTwo.match(/^refs:$/gm).length, 1)
  // Nothing was pushed into the records section.
  const refsBlock = withTwo.slice(withTwo.indexOf('refs:'), withTwo.indexOf('records:'))
  assert.match(refsBlock, new RegExp(AUTH_CODE_REF))
})

test('an empty document produces a complete credentials file', () => {
  const next = upsertCredentialRef('', AUTH_CODE_REF, 'fresh')
  assert.equal(next, `version: 1\nrefs:\n  ${AUTH_CODE_REF}: 'fresh'\n`)
})

test('special characters survive quoting', () => {
  const awkward = "it's #not-a-comment: @here"
  const next = upsertCredentialRef(REAL_CREDENTIALS, AUTH_CODE_REF, awkward)
  assert.match(next, new RegExp(`${AUTH_CODE_REF}: 'it''s #not-a-comment: @here'`))
})

test('the credential value is rejected when empty or multi-line', () => {
  assert.throws(() => upsertCredentialRef(REAL_CREDENTIALS, AUTH_CODE_REF, ''), /must not be empty/)
  assert.throws(() => upsertCredentialRef(REAL_CREDENTIALS, AUTH_CODE_REF, '   '), /must not be empty/)
  assert.throws(() => upsertCredentialRef(REAL_CREDENTIALS, AUTH_CODE_REF, 'a\nb'), /line break/)
})

test('an invalid reference name is rejected', () => {
  assert.throws(() => upsertCredentialRef(REAL_CREDENTIALS, 'has-dash', 'x'), /invalid credential reference/)
  assert.throws(() => upsertCredentialRef(REAL_CREDENTIALS, '1LEADING', 'x'), /invalid credential reference/)
})

test('removing a reference keeps the others and preserves records', () => {
  const both = upsertCredentialRef(upsertCredentialRef(REAL_CREDENTIALS, 'KEEP_ME', 'a'), AUTH_CODE_REF, 'b')
  const { text, removed } = removeCredentialRef(both, AUTH_CODE_REF)
  assert.equal(removed, true)
  assert.match(text, /KEEP_ME: 'a'/)
  assert.doesNotMatch(text, new RegExp(AUTH_CODE_REF))
  assert.match(text, /records:/)
})

test('removing the last reference drops the empty refs section', () => {
  const only = upsertCredentialRef(REAL_CREDENTIALS, AUTH_CODE_REF, 'b')
  const { text } = removeCredentialRef(only, AUTH_CODE_REF)
  assert.doesNotMatch(text, /^refs:$/m)
  assert.match(text, /^version: 1$/m)
  assert.match(text, /records:/)
})

test('removing an absent reference is a no-op', () => {
  const { text, removed } = removeCredentialRef(REAL_CREDENTIALS, AUTH_CODE_REF)
  assert.equal(removed, false)
  assert.equal(text, REAL_CREDENTIALS)
})

test('readPluginRowConfig round-trips what renderPluginRow wrote', () => {
  const patch = upsertPluginRow(REAL_PATCH, CONFIG)
  const read = readPluginRowConfig(patch)
  assert.deepEqual(read, CONFIG)
  // Types survive the text round-trip, not just the values.
  assert.equal(typeof read.smtpPort, 'number')
  assert.equal(typeof read.notificationsEnabled, 'boolean')
  assert.equal(typeof read.subjectPrefix, 'string')
})

test('readPluginRowConfig ignores the surrounding rows', () => {
  const patch = upsertPluginRow(REAL_PATCH, CONFIG)
  const read = readPluginRowConfig(patch)
  assert.equal(read.model, undefined, 'a neighbouring row\u2019s config must not leak in')
  assert.equal(read.step, undefined)
  assert.equal(read.version, undefined)
})

test('readPluginRowConfig returns null without the row and {} without config', () => {
  assert.equal(readPluginRowConfig(REAL_PATCH), null)
  assert.deepEqual(readPluginRowConfig(upsertPluginRow(REAL_PATCH, {})), {})
})

test('unquoteScalar handles quoting, escapes and plain scalars', () => {
  assert.equal(unquoteScalar("'a''b'"), "a'b")
  assert.equal(unquoteScalar('"plain"'), 'plain')
  assert.equal(unquoteScalar('true'), true)
  assert.equal(unquoteScalar('false'), false)
  assert.equal(unquoteScalar('465'), 465)
  assert.equal(unquoteScalar('0.5'), 0.5)
  assert.equal(unquoteScalar('bare'), 'bare')
})

test('YAML produced for a profile parses and has the expected shape', async (t) => {
  const yaml = await loadYaml()
  if (!yaml) return t.skip('set DSH_YAML_MODULE to a YAML module to run the parse check')
  const document = yaml.parse(upsertPluginRow(REAL_PATCH, CONFIG))
  assert.ok(Array.isArray(document), 'the patch root must be a sequence')
  // A profile may hold several insert lists; ours is appended as its own entry.
  const inserted = document.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
  const row = inserted.find((entry) => entry.id === ROW_ID)
  assert.ok(row, 'the row must be inside an insert list')
  assert.equal(row.name, 'dsh-plugin-mail-notify')
  assert.equal(row.config.smtpPort, 465)
  assert.equal(row.config.notificationsEnabled, true)
  assert.equal(row.config.subjectPrefix, '[DSH]')
  assert.equal(row.config.senderEmail, 'me@qq.com')
})

test('YAML produced for credentials parses and keeps the records section', async (t) => {
  const yaml = await loadYaml()
  if (!yaml) return t.skip('set DSH_YAML_MODULE to a YAML module to run the parse check')
  const document = yaml.parse(upsertCredentialRef(REAL_CREDENTIALS, AUTH_CODE_REF, "s3'cret"))
  assert.equal(document.version, 1)
  assert.equal(document.refs[AUTH_CODE_REF], "s3'cret")
  assert.equal(document.records['client-connection/browser-session'].kind, 'grant')
  assert.equal(document.records['deepseek-account-platform/default'].payload.token, 'def')
})
