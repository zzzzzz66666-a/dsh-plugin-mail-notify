#!/usr/bin/env node
/**
 * Configure the mail notification plugin for a harness profile.
 *
 * Does four things, each backed up before it is touched:
 *   1. declares this package as a `link:` dependency of the profile,
 *   2. installs that dependency with the harness's own pnpm,
 *   3. writes the plugin row (including its non-secret configuration) into the
 *      profile's `cordis.patch.yml`,
 *   4. stores the mailbox authorization code in the harness credential store.
 *
 * It never prints the authorization code, and it never writes the code into a
 * configuration file.
 *
 * @module scripts/configure
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, validateConfig } from '../lib/config.js'
import { AUTH_CODE_REF, PACKAGE_NAME, ROW_ID, upsertCredentialRef, upsertPluginRow } from './lib/profile-edit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')

/** Minimal argument parser: `--flag`, `--key value`, and `--no-flag`. */
function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [rawName, inline] = token.slice(2).split('=')
    if (rawName.startsWith('no-')) {
      flags[rawName.slice(3)] = false
      continue
    }
    if (inline !== undefined) {
      flags[rawName] = inline
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) flags[rawName] = true
    else {
      flags[rawName] = next
      index += 1
    }
  }
  return flags
}

/** Locate the harness's bundled pnpm, falling back to whatever is on PATH. */
function findPnpm(home) {
  const runtimes = join(home, 'dsh-runtimes')
  if (existsSync(runtimes)) {
    for (const entry of readdirSync(runtimes)) {
      const candidate = join(runtimes, entry, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Copy the files this script may rewrite into a timestamped backup directory. */
function backup(paths, backupDir) {
  mkdirSync(backupDir, { recursive: true })
  const saved = []
  for (const path of paths) {
    if (!existsSync(path)) continue
    const target = join(backupDir, path.split(/[\\/]/).pop())
    copyFileSync(path, target)
    saved.push(target)
  }
  return saved
}

/** Read the first line available on a non-interactive stdin. */
function readLineFromStdin() {
  try {
    const chunk = readFileSync(0, 'utf8')
    return chunk.split(/\r?\n/)[0].trim()
  } catch {
    return ''
  }
}

/**
 * Read the authorization code without ever echoing it into the summary.
 *
 * On a terminal the line is read interactively; when stdin is a pipe the whole
 * first line is taken from it, which is how a script supplies the value without
 * the code appearing in the process arguments.
 */
async function readAuthorizationCode() {
  if (process.stdin.isTTY) {
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = await new Promise((resolve) => rl.question('Mailbox authorization code: ', resolve))
      return String(answer ?? '').trim()
    } finally {
      rl.close()
    }
  }
  return readLineFromStdin()
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const home = flags.home || process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = resolve(flags.profile || join(home, 'profiles', 'desktop'))
  const credentialsPath = resolve(flags.credentials || join(home, '.credentials.yaml'))
  const dryRun = Boolean(flags['dry-run'])

  if (flags.help) {
    process.stdout.write(
      [
        'Usage: node scripts/configure.mjs [options]',
        '',
        '  --sender <address>        mailbox that sends the notifications (required)',
        '  --recipient <address>     mailbox that receives them (default: --sender)',
        '  --reply-to <address>      the only address allowed to reply (default: --sender)',
        '  --auth-code-stdin         read the authorization code from stdin (preferred)',
        '  --auth-code <code>        pass the code directly (visible in shell history)',
        '  --no-credential           do not touch the credential store',
        '  --no-config               install the plugin without a mailbox configuration',
        '                            (it loads, reports "not configured" and stays idle)',
        '  --smtp-host/--smtp-port/--smtp-security',
        '  --imap-host/--imap-port/--imap-security',
        '  --prefix <tag>            subject tag used for the queue and the IMAP search',
        '  --data-dir <path>         override the plugin data directory',
        '  --profile <dir>           profile to configure (default: <home>/profiles/desktop)',
        '  --home <dir>              harness home (default: $DSH_HOME or ~/.dsh)',
        '  --credentials <file>      credential store file',
        '  --skip-install            write the dependency but do not run pnpm',
        '  --dry-run                 print the changes without writing anything',
        '  --json                    print a machine-readable summary',
        '',
      ].join('\n'),
    )
    return
  }

  // `--no-xyz` is recorded as `xyz: false`, so a negation is tested on the
  // positive key rather than on a separately spelled one.
  const installOnly = flags.config === false
  const config = installOnly
    ? {}
    : validateConfig({
        ...DEFAULT_CONFIG,
        senderEmail: flags.sender ?? '',
        recipientEmail: flags.recipient ?? flags.sender ?? '',
        allowedReplyEmail: flags['reply-to'] ?? flags.sender ?? '',
        ...(flags['smtp-host'] ? { smtpHost: flags['smtp-host'] } : {}),
        ...(flags['smtp-port'] ? { smtpPort: Number(flags['smtp-port']) } : {}),
        ...(flags['smtp-security'] ? { smtpSecurity: flags['smtp-security'] } : {}),
        ...(flags['imap-host'] ? { imapHost: flags['imap-host'] } : {}),
        ...(flags['imap-port'] ? { imapPort: Number(flags['imap-port']) } : {}),
        ...(flags['imap-security'] ? { imapSecurity: flags['imap-security'] } : {}),
        ...(flags.prefix ? { subjectPrefix: flags.prefix } : {}),
        ...(flags['data-dir'] ? { dataDir: flags['data-dir'] } : {}),
      })

  const explicitCode = typeof flags['auth-code'] === 'string' ? flags['auth-code'].trim() : ''
  // An install-only run has no mailbox to authenticate against, so it stores no
  // credential unless one was handed over explicitly.
  const storeCredential = flags.credential !== false && !(installOnly && explicitCode === '')
  const code = explicitCode || (storeCredential ? await readAuthorizationCode() : '')
  if (storeCredential && !code) {
    fail('no authorization code supplied; use --auth-code-stdin, --auth-code, or pass --no-credential')
  }

  if (!existsSync(profileDir)) fail(`profile directory not found: ${profileDir}`)
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(manifestPath)) fail(`profile manifest not found: ${manifestPath}`)
  if (!existsSync(patchPath)) fail(`profile patch not found: ${patchPath}`)
  if (!existsSync(join(PACKAGE_ROOT, 'package.json'))) fail(`plugin package not found: ${PACKAGE_ROOT}`)

  // -- 1. dependency ------------------------------------------------------
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = manifest.dependencies ?? {}
  const linkValue = `link:${PACKAGE_ROOT.replace(/\\/g, '/')}`
  const dependencyChanged = manifest.dependencies[PACKAGE_NAME] !== linkValue
  if (dependencyChanged) manifest.dependencies[PACKAGE_NAME] = linkValue
  const reloaded = { ...manifest, dependencies: Object.fromEntries(Object.entries(manifest.dependencies).sort()) }

  // -- 2. plugin row ------------------------------------------------------
  const patchText = readFileSync(patchPath, 'utf8')
  const nextPatch = upsertPluginRow(patchText, config)

  // -- 3. credential ------------------------------------------------------
  const credentialsText = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : ''
  const nextCredentials = storeCredential
    ? upsertCredentialRef(credentialsText, AUTH_CODE_REF, code)
    : credentialsText

  if (dryRun) {
    process.stdout.write('=== package.json ===\n')
    process.stdout.write(`${JSON.stringify(reloaded, null, 2)}\n\n`)
    process.stdout.write('=== cordis.patch.yml ===\n')
    process.stdout.write(`${nextPatch}\n`)
    if (storeCredential) {
      // The credential file stores every secret this harness holds, so it is
      // never printed — not even with the one value we are about to touch
      // masked. Only the intended change is described.
      const alreadyStored = new RegExp(`^\\s+${AUTH_CODE_REF}\\s*:`, 'm').test(credentialsText)
      process.stdout.write('=== .credentials.yaml ===\n')
      process.stdout.write(
        `${alreadyStored ? 'would replace' : 'would add'} refs.${AUTH_CODE_REF} = [REDACTED] in ${credentialsPath}\n` +
          '(the file itself is not printed: it holds every stored credential)\n',
      )
    }
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(profileDir, `.mail-notify-backup-${stamp}`)
  const saved = backup([manifestPath, patchPath, credentialsPath], backupDir)

  writeFileSync(manifestPath, `${JSON.stringify(reloaded, null, 2)}\n`, 'utf8')
  writeFileSync(patchPath, nextPatch, 'utf8')
  if (storeCredential) writeFileSync(credentialsPath, nextCredentials, 'utf8')

  // -- 4. install the linked dependency -----------------------------------
  let installResult = 'skipped'
  if (dependencyChanged && !flags['skip-install']) {
    const pnpm = findPnpm(home)
    if (!pnpm) {
      installResult = 'pnpm-not-found'
    } else {
      // `stdio: 'inherit'` keeps the install output out of a pipe, which a
      // sandboxed shell refuses to create.
      const result = spawnSync(process.execPath, [pnpm, 'add', PACKAGE_ROOT], {
        cwd: profileDir,
        stdio: 'inherit',
      })
      installResult = result.status === 0 ? 'installed' : `failed(${result.status ?? 'signal'})`
    }
  }

  const summary = {
    profile: profileDir,
    packageRoot: PACKAGE_ROOT,
    dependency: linkValue,
    dependencyChanged,
    rowId: ROW_ID,
    credentialRef: storeCredential ? AUTH_CODE_REF : null,
    credentialsPath: storeCredential ? credentialsPath : null,
    backupDir,
    backups: saved,
    install: installResult,
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return
  }

  process.stdout.write(
    [
      `profile        ${profileDir}`,
      `dependency     ${linkValue}${dependencyChanged ? '' : '  (already declared)'}`,
      `plugin row     ${ROW_ID} written to cordis.patch.yml${installOnly ? ' (no mailbox configuration yet)' : ''}`,
      `credential     ${storeCredential ? `${AUTH_CODE_REF} in ${credentialsPath}` : 'left untouched'}`,
      `install        ${installResult}`,
      `backup         ${backupDir}`,
      '',
      installResult === 'pnpm-not-found'
        ? 'pnpm was not found; run the install yourself:\n  cd <profile> && node <pnpm.mjs> add ' + PACKAGE_ROOT
        : null,
      'Restart DeepSeek Harness for the plugin to load.',
      'Verify with: node scripts/verify-install.mjs',
      '',
    ]
      .filter((line) => line !== null)
      .join('\n'),
  )
}

main().catch((error) => fail(error?.stack ?? String(error)))
