#!/usr/bin/env node
/**
 * Verify that the plugin is installed correctly enough to load.
 *
 * This checks the things that actually decide whether a restart will work:
 * the dependency resolves to this package, the host entry imports, the plugin
 * boots against a stand-in context, the profile patch carries the row, and the
 * credential is present. It is deliberately runnable *before* restarting the
 * harness, because a failed import is cheap to find now and expensive to
 * diagnose from a blank GUI.
 *
 * @module scripts/verify-install
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { validateConfig } from '../lib/config.js'
import { AUTH_CODE_REF, PACKAGE_NAME, ROW_ID, readPluginRowConfig } from './lib/profile-edit.mjs'

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

/** A Cordis context just real enough for the plugin to boot. */
function standInContext() {
  const listeners = new Map()
  const disposers = []
  return {
    listeners,
    ctx: {
      on(name, handler) {
        listeners.set(name, handler)
        return () => listeners.delete(name)
      },
      effect(initializer) {
        const disposer = initializer()
        if (typeof disposer === 'function') disposers.push(disposer)
        return () => {}
      },
      get() {
        return null
      },
      logger: null,
    },
    dispose() {
      for (const disposer of disposers.splice(0)) {
        try {
          disposer()
        } catch {
          // Teardown failures are reported by their own check, not here.
        }
      }
    },
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const home = flags.home || process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = resolve(flags.profile || join(home, 'profiles', 'desktop'))
  const credentialsPath = resolve(flags.credentials || join(home, '.credentials.yaml'))

  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}\n`)
  }
  const skip = (name, detail) => {
    results.push({ name, ok: true, skipped: true, detail })
    process.stdout.write(`skip  ${name} — ${detail}\n`)
  }

  // 1. profile files exist ------------------------------------------------
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  check('profile manifest exists', existsSync(manifestPath), manifestPath)
  check('profile patch exists', existsSync(patchPath), patchPath)

  // 2. dependency declared and resolving to this package ------------------
  let manifest = null
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      check('profile manifest parses', false, error.message)
    }
  }
  const declared = manifest?.dependencies?.[PACKAGE_NAME]
  check(
    'profile declares the dependency',
    typeof declared === 'string' && declared.startsWith('link:'),
    `expected a link: entry, found ${JSON.stringify(declared)}`,
  )
  if (typeof declared === 'string') {
    const declaredPath = resolve(declared.replace(/^link:/, '').replace(/\//g, process.platform === 'win32' ? '\\' : '/'))
    check('the declared link points at this package', declaredPath === PACKAGE_ROOT, `${declaredPath} != ${PACKAGE_ROOT}`)
  }

  const installed = join(profileDir, 'node_modules', PACKAGE_NAME)
  if (existsSync(installed)) {
    let linked = ''
    try {
      linked = realpathSync(installed)
    } catch (error) {
      check('the installed package resolves', false, error.message)
    }
    if (linked) check('the installed package resolves to this package', resolve(linked) === PACKAGE_ROOT, linked)
  } else {
    check('the installed package resolves', false, `${installed} is missing; run pnpm add`)
  }

  // 3. host entry imports -------------------------------------------------
  const entry = join(PACKAGE_ROOT, 'lib', 'index.js')
  let module = null
  try {
    module = await import(pathToFileURL(entry).href)
    check('the host entry imports', true)
  } catch (error) {
    check('the host entry imports', false, error.message)
  }
  check('the host entry exports apply()', typeof module?.apply === 'function', 'apply must be a function')

  // 4. the patch row is present and its config is valid -------------------
  let rowConfig = null
  if (existsSync(patchPath)) {
    const patchText = readFileSync(patchPath, 'utf8')
    check('the patch layer enables the row', new RegExp(`-\\s*id:\\s*${ROW_ID}\\s*$`, 'm').test(patchText))
    rowConfig = readPluginRowConfig(patchText)
  }

  // 5. the plugin boots against a stand-in context ------------------------
  if (typeof module?.apply === 'function') {
    const standIn = standInContext()
    const dataDir = mkdtempSync(join(tmpdir(), 'mail-notify-verify-'))
    // Pin the secret store for the smoke test. Without this the outcome would
    // depend on whether this machine happens to have a credential document, and
    // the check is "does the plugin boot", not "whose secret is where".
    const previousStore = process.env.DSH_MAIL_NOTIFY_SECRET_STORE
    process.env.DSH_MAIL_NOTIFY_SECRET_STORE = 'memory'
    try {
      const service = module.apply(standIn.ctx, {
        ...(rowConfig ?? {}),
        senderEmail: rowConfig?.senderEmail || 'verify@example.com',
        recipientEmail: rowConfig?.recipientEmail || 'verify@example.com',
        allowedReplyEmail: rowConfig?.allowedReplyEmail || 'verify@example.com',
        dataDir,
      })
      const health = service?.health?.()
      check('the plugin boots and reports health', Boolean(health), 'apply() did not return a service with health()')
      check('the plugin registers its session listeners', standIn.listeners.has('session/event'), 'session/event is not subscribed')
      if (health) {
        // Booting unconfigured is the correct state here: the pinned store is
        // empty, and the plugin must stay idle rather than fail the profile.
        check('the plugin idles when it has no credential', health.credentialConfigured === false)
        check('the plugin reports which store it chose', typeof health.credentialStore === 'string')
      }
      await service?.stop?.()
    } catch (error) {
      check('the plugin boots and reports health', false, error.message)
    } finally {
      if (previousStore === undefined) delete process.env.DSH_MAIL_NOTIFY_SECRET_STORE
      else process.env.DSH_MAIL_NOTIFY_SECRET_STORE = previousStore
      standIn.dispose()
    }
  }

  // 6. configuration and credential --------------------------------------
  if (rowConfig && Object.keys(rowConfig).length > 0) {
    try {
      validateConfig(rowConfig)
      check('the row configuration is valid', true)
    } catch (error) {
      check('the row configuration is valid', false, error.message)
    }
  } else {
    skip('the row configuration is valid', 'the row carries no config yet; run scripts/configure.mjs')
  }

  if (existsSync(credentialsPath)) {
    const text = readFileSync(credentialsPath, 'utf8')
    const present = new RegExp(`^\\s+${AUTH_CODE_REF}\\s*:\\s*\\S`, 'm').test(text)
    check(`the credential ${AUTH_CODE_REF} is stored`, present, `not found in ${credentialsPath}`)
  } else {
    check(`the credential ${AUTH_CODE_REF} is stored`, false, `${credentialsPath} does not exist`)
  }

  const failures = results.filter((result) => !result.ok)
  process.stdout.write(`\n${results.length - failures.length}/${results.length} checks passed\n`)
  if (failures.length > 0) {
    process.stdout.write('Restart DeepSeek Harness only after every check passes.\n')
    process.exit(1)
  }
  process.stdout.write('Installation looks correct. Restart DeepSeek Harness to load the plugin.\n')
}

main().catch((error) => {
  process.stderr.write(`error: ${error?.stack ?? String(error)}\n`)
  process.exit(1)
})
