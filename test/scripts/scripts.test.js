import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** A secret that must never appear in any output the scripts produce. */
const CANARY = 'CANARY-SECRET-9f3a1c'

const PROFILE_PATCH = `# profile patch
- insert:
    - id: ui-frosted-glass
      name: 'dsh-plugin-frosted-glass'
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    model: deepseek-flash
`

const CREDENTIALS = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      secret: ${CANARY}
`

/**
 * Run a script and capture its output.
 *
 * Output goes to a real file rather than a pipe: a sandboxed shell refuses to
 * create the named pipe that `child_process` would use, and redirecting to a
 * file keeps this test runnable in the same environment a user has. Standard
 * input is a file for the same reason.
 */
function runScript(script, args, { input = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-notify-stdout-'))
  const outPath = join(dir, 'out.txt')
  const fd = openSync(outPath, 'w')
  let stdinFd = 'ignore'
  if (input !== null) {
    const inPath = join(dir, 'in.txt')
    writeFileSync(inPath, input)
    stdinFd = openSync(inPath, 'r')
  }
  let status
  try {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
      stdio: [stdinFd, fd, fd],
      cwd: ROOT,
    })
    status = result.status
  } finally {
    closeSync(fd)
    if (stdinFd !== 'ignore') closeSync(stdinFd)
  }
  return { status, output: readFileSync(outPath, 'utf8') }
}

/** Build a throwaway profile plus credential store. */
function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'mail-notify-scripts-'))
  const profile = join(root, 'profile')
  const credentials = join(root, '.credentials.yaml')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({ name: 'p', private: true, dependencies: {} }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), PROFILE_PATCH)
  writeFileSync(credentials, CREDENTIALS)
  return { root, profile, credentials }
}

const common = (paths) => ['--home', paths.root, '--profile', paths.profile, '--credentials', paths.credentials]

test('configure --dry-run writes nothing and never prints the credential file', () => {
  const paths = scaffold()
  const before = {
    manifest: readFileSync(join(paths.profile, 'package.json'), 'utf8'),
    patch: readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8'),
    credentials: readFileSync(paths.credentials, 'utf8'),
  }

  const { status, output } = runScript('configure.mjs', [
    ...common(paths),
    '--sender', 'me@qq.com',
    '--auth-code', 'dummy-code',
    '--dry-run',
  ])

  assert.equal(status, 0, output)
  assert.match(output, /- id: mail-notify/)
  assert.match(output, /would add refs\.DSH_MAIL_NOTIFY_AUTH_CODE = \[REDACTED\]/)
  // The whole point of the credential store is that its contents stay out of
  // logs and transcripts, including a dry run's.
  assert.doesNotMatch(output, new RegExp(CANARY))
  assert.doesNotMatch(output, /dummy-code/)

  assert.equal(readFileSync(join(paths.profile, 'package.json'), 'utf8'), before.manifest)
  assert.equal(readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8'), before.patch)
  assert.equal(readFileSync(paths.credentials, 'utf8'), before.credentials)
})

test('configure writes the dependency, the row and the credential', () => {
  const paths = scaffold()
  const { status, output } = runScript('configure.mjs', [
    ...common(paths),
    '--sender', 'me@qq.com',
    '--recipient', 'other@qq.com',
    '--reply-to', 'me@qq.com',
    '--prefix', '[OPS]',
    '--auth-code', 'auth-code-value',
    '--skip-install',
  ])
  assert.equal(status, 0, output)

  const manifest = JSON.parse(readFileSync(join(paths.profile, 'package.json'), 'utf8'))
  assert.match(manifest.dependencies['dsh-plugin-mail-notify'], /^link:/)

  const patch = readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: mail-notify/)
  assert.match(patch, /recipientEmail: 'other@qq\.com'/)
  assert.match(patch, /subjectPrefix: '\[OPS\]'/)
  assert.match(patch, /pollIntervalMs: 15000/)
  assert.match(patch, /ui-frosted-glass/)

  const credentials = readFileSync(paths.credentials, 'utf8')
  assert.match(credentials, /DSH_MAIL_NOTIFY_AUTH_CODE: 'auth-code-value'/)
  assert.match(credentials, new RegExp(CANARY), 'unrelated credentials must survive')

  assert.doesNotMatch(output, /auth-code-value/, 'the code must not be echoed')
  assert.match(output, /backup/)
})

test('a second configure run replaces the row instead of duplicating it', () => {
  const paths = scaffold()
  const args = [...common(paths), '--skip-install', '--auth-code', 'code-1']
  assert.equal(runScript('configure.mjs', [...args, '--sender', 'first@qq.com']).status, 0)
  assert.equal(runScript('configure.mjs', [...args, '--sender', 'second@qq.com']).status, 0)

  const patch = readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch.match(/- id: mail-notify/g).length, 1)
  assert.match(patch, /senderEmail: 'second@qq\.com'/)
  assert.doesNotMatch(patch, /first@qq\.com/)
})

test('configure rejects an incomplete address set before writing anything', () => {
  const paths = scaffold()
  const before = readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8')
  const { status } = runScript('configure.mjs', [
    ...common(paths),
    '--sender', 'not-an-address',
    '--auth-code', 'x',
    '--skip-install',
  ])
  assert.equal(status, 1)
  assert.equal(readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8'), before)
})

test('configure --no-config installs the row without a mailbox configuration', () => {
  const paths = scaffold()
  const { status, output } = runScript('configure.mjs', [...common(paths), '--no-config', '--skip-install'])
  assert.equal(status, 0, output)

  const patch = readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: mail-notify/)
  assert.match(patch, /ui-frosted-glass/)
  // No addresses and no config block: the plugin reports "not configured".
  assert.doesNotMatch(patch, /senderEmail/)
  assert.equal(readFileSync(paths.credentials, 'utf8'), CREDENTIALS, 'the credential store is untouched')
  assert.match(output, /no mailbox configuration yet/)
})

test('configure --no-credential configures the mailbox but leaves secrets alone', () => {
  const paths = scaffold()
  const { status, output } = runScript('configure.mjs', [
    ...common(paths),
    '--sender', 'me@qq.com',
    '--no-credential',
    '--skip-install',
  ])
  assert.equal(status, 0, output)
  assert.equal(readFileSync(paths.credentials, 'utf8'), CREDENTIALS)
  const patch = readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /senderEmail: 'me@qq\.com'/)
  assert.match(output, /credential {5}left untouched/)
})

test('set-credential stores a piped code without echoing it', () => {
  const paths = scaffold()
  assert.equal(
    runScript('configure.mjs', [...common(paths), '--sender', 'me@qq.com', '--no-credential', '--skip-install']).status,
    0,
  )

  const secret = 'QQ-AUTH-CODE-XYZZY'
  const { status, output } = runScript('set-credential.mjs', [...common(paths), '--no-check'], { input: `${secret}\n` })
  assert.equal(status, 0, output)
  assert.match(output, /stored DSH_MAIL_NOTIFY_AUTH_CODE/)
  assert.doesNotMatch(output, new RegExp(secret), 'the code must never be printed')
  assert.doesNotMatch(output, new RegExp(CANARY), 'unrelated credentials must never be printed')

  const credentials = readFileSync(paths.credentials, 'utf8')
  assert.match(credentials, new RegExp(`DSH_MAIL_NOTIFY_AUTH_CODE: '${secret}'`))
  assert.match(credentials, new RegExp(CANARY), 'existing credentials survive')
})

test('set-credential replaces an existing code rather than duplicating it', () => {
  const paths = scaffold()
  assert.equal(
    runScript('configure.mjs', [...common(paths), '--sender', 'me@qq.com', '--no-credential', '--skip-install']).status,
    0,
  )
  assert.equal(runScript('set-credential.mjs', [...common(paths), '--no-check'], { input: 'first-code\n' }).status, 0)
  const { output } = runScript('set-credential.mjs', [...common(paths), '--no-check'], { input: 'second-code\n' })
  assert.match(output, /replaced DSH_MAIL_NOTIFY_AUTH_CODE/)

  const credentials = readFileSync(paths.credentials, 'utf8')
  assert.equal(credentials.match(/DSH_MAIL_NOTIFY_AUTH_CODE/g).length, 1)
  assert.match(credentials, /DSH_MAIL_NOTIFY_AUTH_CODE: 'second-code'/)
})

test('set-credential refuses to run before the mailbox is configured', () => {
  const paths = scaffold()
  const { status, output } = runScript('set-credential.mjs', [...common(paths), '--no-check'], { input: 'code\n' })
  assert.equal(status, 1)
  assert.match(output, /carries no mailbox configuration yet/)
  assert.equal(readFileSync(paths.credentials, 'utf8'), CREDENTIALS)
})

test('set-credential rejects an empty code', () => {
  const paths = scaffold()
  assert.equal(
    runScript('configure.mjs', [...common(paths), '--sender', 'me@qq.com', '--no-credential', '--skip-install']).status,
    0,
  )
  const { status, output } = runScript('set-credential.mjs', [...common(paths), '--no-check'], { input: '\n' })
  assert.equal(status, 1)
  assert.match(output, /no authorization code supplied/)
})

test('uninstall removes the row but keeps the credential and the data by default', () => {
  const paths = scaffold()
  assert.equal(
    runScript('configure.mjs', [...common(paths), '--sender', 'me@qq.com', '--auth-code', 'code', '--skip-install']).status,
    0,
  )

  const { status, output } = runScript('uninstall.mjs', common(paths))
  assert.equal(status, 0, output)

  const patch = readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /- id: mail-notify/)
  assert.match(patch, /ui-frosted-glass/, 'the rest of the profile survives')
  assert.match(patch, /agent-default-model/)
  assert.match(readFileSync(paths.credentials, 'utf8'), /DSH_MAIL_NOTIFY_AUTH_CODE/, 'the credential is kept by default')
})

test('uninstall --remove-credential restores the original credential document', () => {
  const paths = scaffold()
  assert.equal(
    runScript('configure.mjs', [...common(paths), '--sender', 'me@qq.com', '--auth-code', 'code', '--skip-install']).status,
    0,
  )
  assert.equal(runScript('uninstall.mjs', [...common(paths), '--remove-credential']).status, 0)
  assert.equal(readFileSync(paths.credentials, 'utf8'), CREDENTIALS)
})

test('uninstall --dry-run leaves both files untouched', () => {
  const paths = scaffold()
  assert.equal(
    runScript('configure.mjs', [...common(paths), '--sender', 'me@qq.com', '--auth-code', 'code', '--skip-install']).status,
    0,
  )
  const patch = readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8')
  const credentials = readFileSync(paths.credentials, 'utf8')

  const { status, output } = runScript('uninstall.mjs', [...common(paths), '--dry-run', '--remove-credential'])
  assert.equal(status, 0, output)
  assert.match(output, /would be removed/)
  assert.equal(readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8'), patch)
  assert.equal(readFileSync(paths.credentials, 'utf8'), credentials)
})

test('verify-install reports the row and the credential of a configured profile', () => {
  const paths = scaffold()
  assert.equal(
    runScript('configure.mjs', [...common(paths), '--sender', 'me@qq.com', '--auth-code', 'code', '--skip-install']).status,
    0,
  )
  const { output } = runScript('verify-install.mjs', common(paths))
  assert.match(output, /ok {4}the host entry imports/)
  assert.match(output, /ok {4}the host entry exports apply\(\)/)
  assert.match(output, /ok {4}the plugin boots and reports health/)
  assert.match(output, /ok {4}the patch layer enables the row/)
  assert.match(output, /ok {4}the row configuration is valid/)
  assert.match(output, /ok {4}the credential DSH_MAIL_NOTIFY_AUTH_CODE is stored/)
  assert.doesNotMatch(output, new RegExp(CANARY))
  // The temp profile has no node_modules, so that check is expected to fail.
  assert.match(output, /FAIL {2}the installed package resolves/)
})
