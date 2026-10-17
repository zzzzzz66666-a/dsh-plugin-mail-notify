#!/usr/bin/env node
/**
 * Undo `configure.mjs`.
 *
 * Removing the row disables the plugin; the dependency, the stored credential
 * and the plugin's local data are each opt-in, because the most common reason
 * to run this is "turn it off for now", not "forget everything".
 *
 * @module scripts/uninstall
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AUTH_CODE_REF, PACKAGE_NAME, ROW_ID, removeCredentialRef, removePluginRow } from './lib/profile-edit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=')
    const next = argv[index + 1]
    if (inline !== undefined) flags[name] = inline
    else if (next === undefined || next.startsWith('--')) flags[name] = true
    else {
      flags[name] = next
      index += 1
    }
  }
  return flags
}

function findPnpm(home) {
  const runtimes = join(home, 'dsh-runtimes')
  if (!existsSync(runtimes)) return null
  for (const entry of readdirSync(runtimes)) {
    const candidate = join(runtimes, entry, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
    if (existsSync(candidate)) return candidate
  }
  return null
}

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

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const home = flags.home || process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = resolve(flags.profile || join(home, 'profiles', 'desktop'))
  const credentialsPath = resolve(flags.credentials || join(home, '.credentials.yaml'))
  const dataDir = resolve(flags['data-dir'] || join(home, 'mail-notify'))
  const dryRun = Boolean(flags['dry-run'])

  if (flags.help) {
    process.stdout.write(
      [
        'Usage: node scripts/uninstall.mjs [options]',
        '',
        '  --remove-credential    also delete the stored authorization code',
        '  --remove-dependency    also run pnpm remove for the plugin package',
        '  --purge-data           also delete the plugin data directory (queue, tokens, audit)',
        '  --profile/--home/--credentials/--data-dir  path overrides',
        '  --dry-run              report what would change without writing',
        '  --json                 print a machine-readable summary',
        '',
      ].join('\n'),
    )
    return
  }

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    process.stderr.write(`error: profile patch not found: ${patchPath}\n`)
    process.exit(1)
  }

  const patchText = readFileSync(patchPath, 'utf8')
  const { text: nextPatch, removed } = removePluginRow(patchText)
  const credentialsText = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : ''
  const credentialResult = flags['remove-credential']
    ? removeCredentialRef(credentialsText, AUTH_CODE_REF)
    : { text: credentialsText, removed: false }

  if (dryRun) {
    process.stdout.write(`row ${ROW_ID}: ${removed ? 'would be removed' : 'not present'}\n`)
    process.stdout.write(`credential ${AUTH_CODE_REF}: ${credentialResult.removed ? 'would be removed' : 'left in place'}\n`)
    process.stdout.write(`data directory ${dataDir}: ${flags['purge-data'] ? 'would be deleted' : 'left in place'}\n`)
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(profileDir, `.mail-notify-uninstall-${stamp}`)
  const saved = backup([patchPath, credentialsPath], backupDir)

  if (removed) writeFileSync(patchPath, nextPatch, 'utf8')
  if (credentialResult.removed) writeFileSync(credentialsPath, credentialResult.text, 'utf8')

  let dependencyResult = 'kept'
  if (flags['remove-dependency']) {
    const pnpm = findPnpm(home)
    if (!pnpm) dependencyResult = 'pnpm-not-found'
    else {
      const result = spawnSync(process.execPath, [pnpm, 'remove', PACKAGE_NAME], { cwd: profileDir, stdio: 'inherit' })
      dependencyResult = result.status === 0 ? 'removed' : `failed(${result.status ?? 'signal'})`
    }
  }

  let dataResult = 'kept'
  if (flags['purge-data'] && existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true })
    dataResult = 'deleted'
  }

  const summary = {
    profile: profileDir,
    rowRemoved: removed,
    credentialRemoved: credentialResult.removed,
    dependency: dependencyResult,
    data: dataResult,
    backupDir,
    backups: saved,
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return
  }

  process.stdout.write(
    [
      `plugin row     ${removed ? 'removed from cordis.patch.yml' : 'was not present'}`,
      `credential     ${credentialResult.removed ? 'removed' : 'left in place'}`,
      `dependency     ${dependencyResult}`,
      `data           ${dataResult}`,
      `backup         ${backupDir}`,
      '',
      'Restart DeepSeek Harness for the change to take effect.',
      '',
    ].join('\n'),
  )
}

main().catch((error) => {
  process.stderr.write(`error: ${error?.stack ?? String(error)}\n`)
  process.exit(1)
})
