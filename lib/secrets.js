/**
 * Secret storage for the SMTP/IMAP authorization code.
 *
 * The authorization code must never reach the plain configuration document, the
 * audit log or a diagnostic dump. The harness ships the right place for it: the
 * credentials seam (`ctx.credentials`), whose configuration surface reports
 * whether a secret is set, where it came from and whether it is writable — but
 * never its value.
 *
 * ## Why there is a second, file-backed reader
 *
 * Resolving through the seam is the primary path and the only one that can
 * write. It also depends on the service being reachable from this plugin's
 * context, and when it is not, a silent fall back to an in-memory store turns
 * "the plugin cannot see its credential" into the indistinguishable and
 * unhelpful "not configured". The managed document is a documented, stable
 * format, so a read-only reader of that same file is used as a last resort —
 * and the store that was chosen is reported in the audit log, so the situation
 * is diagnosable instead of silent.
 *
 * This module imports nothing from `@deepseek-ai/*`: a plugin installed as a
 * `link:` dependency lives outside the profile directory, so the harness's own
 * packages are not resolvable from it.
 *
 * @module dsh-plugin-mail-notify/secrets
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Name of the credential reference holding the mailbox authorization code. */
export const AUTH_CODE_REF = 'DSH_MAIL_NOTIFY_AUTH_CODE'

/** Absolute path of the harness's managed credential document. */
export function credentialsFilePath(env = process.env) {
  if (env.DSH_MAIL_NOTIFY_CREDENTIALS_FILE) return env.DSH_MAIL_NOTIFY_CREDENTIALS_FILE
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.credentials.yaml')
}

/** Undo the quoting styles the credentials document uses for a value. */
function unquoteScalar(raw) {
  const text = String(raw ?? '').trim()
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'")
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return text
}

/**
 * Read one reference out of a credentials document.
 *
 * Deliberately narrow: it understands only the `refs:` section of the
 * documented `version`/`refs`/`records` layout. A document it cannot make sense
 * of yields null rather than a wrong value.
 *
 * @param {string} text - `.credentials.yaml` contents.
 * @param {string} ref - reference name to look up.
 * @returns {string|null}
 */
export function readRefFromCredentialsDocument(text, ref) {
  const lines = String(text ?? '').split(/\r?\n/)
  let inRefs = false
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (!inRefs) {
      if (indent === 0 && /^refs:\s*$/.test(line)) inRefs = true
      continue
    }
    // Any key back at column zero ends the section.
    if (indent === 0) break
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line.trim())
    if (!match || match[1] !== ref) continue
    const value = unquoteScalar(match[2])
    return value === '' ? null : value
  }
  return null
}

/** In-process secret store used by tests and by compositions with no store at all. */
export class MemorySecretStore {
  constructor(reason = 'no-store-available') {
    /** @type {Map<string, string>} */
    this.values = new Map()
    this.kind = 'memory'
    this.reason = reason
  }

  /** @returns {boolean} whether the store can persist across restarts. */
  get persistent() {
    return false
  }

  async save(key, value) {
    this.values.set(key, String(value))
  }

  async read(key) {
    return this.values.has(key) ? this.values.get(key) : null
  }

  async delete(key) {
    this.values.delete(key)
  }
}

/**
 * Adapter over the harness credentials seam.
 *
 * Only `set`, `resolve`, `unset` and `describe` are used, and every call is
 * made per operation rather than cached, which is what makes rotating the
 * authorization code take effect on the next request without a restart.
 */
export class CredentialsServiceSecretStore {
  /**
   * @param {object} credentials - the `ctx.credentials` service.
   */
  constructor(credentials) {
    this.credentials = credentials
    this.kind = 'credentials-service'
    this.reason = 'service-reachable'
  }

  get persistent() {
    return true
  }

  async save(key, value) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('authorization code must not be empty')
    }
    await this.credentials.set(key, value)
  }

  async read(key) {
    const hit = await this.credentials.resolve(key)
    // An empty stored value means "not configured", matching the seam's own rule.
    return hit && typeof hit.value === 'string' && hit.value !== '' ? hit.value : null
  }

  async delete(key) {
    await this.credentials.unset(key)
  }

  /** `{configured, source?, writable}` — never the value. */
  async describe(key) {
    try {
      return await this.credentials.describe(key)
    } catch (error) {
      return { configured: false, writable: false, error: String(error?.message ?? error) }
    }
  }
}

/**
 * Read-only reader of the harness's managed credential document.
 *
 * Used only when the credentials seam is not reachable. It cannot write: the
 * setup scripts own the write path, and a plugin that silently rewrote the
 * document every harness component shares would be a worse neighbour than one
 * that reports what it found.
 */
export class FileSecretStore {
  /**
   * @param {string} path - the credentials document.
   * @param {string} reason - why this store was selected, for the audit log.
   */
  constructor(path, reason = 'service-unavailable') {
    this.path = path
    this.kind = 'credentials-file'
    this.reason = reason
  }

  get persistent() {
    return true
  }

  async save() {
    throw new Error(
      `this plugin reads ${this.path} but never writes it; use scripts/set-credential.mjs to store the code`,
    )
  }

  async read(key) {
    if (!existsSync(this.path)) return null
    try {
      return readRefFromCredentialsDocument(readFileSync(this.path, 'utf8'), key)
    } catch {
      return null
    }
  }

  async delete() {
    throw new Error(`use scripts/uninstall.mjs --remove-credential to remove the code from ${this.path}`)
  }
}

/**
 * Look for the credentials service on a Cordis context.
 *
 * Tries the documented accessor first, then the plain property. Both can fail
 * without throwing (`ctx.get` returns undefined when nothing is provided, the
 * property throws when the service is isolated), and the difference is exactly
 * what a diagnosis needs, so each attempt is reported.
 *
 * @param {object} ctx
 * @returns {{service: object|null, via: string, attempts: object[]}}
 */
export function probeCredentialsService(ctx) {
  const attempts = []
  const candidates = [
    ['ctx.get', () => ctx?.get?.('credentials')],
    ['ctx.credentials', () => ctx?.credentials],
    ['ctx.reflect.get', () => ctx?.reflect?.get?.('credentials', false)],
  ]
  for (const [via, attempt] of candidates) {
    try {
      const value = attempt()
      const usable = Boolean(value) && typeof value.resolve === 'function'
      attempts.push({ via, found: Boolean(value), usable })
      if (usable) return { service: value, via, attempts }
    } catch (error) {
      attempts.push({ via, found: false, usable: false, error: String(error?.message ?? error) })
    }
  }
  return { service: null, via: 'none', attempts }
}

/**
 * A credentials-seam store that falls back to the managed document.
 *
 * The seam is authoritative for writes, and normally for reads too. But a
 * plugin that idles because the seam reports "not configured" while the very
 * document the seam reads plainly contains the reference is worse than useless:
 * it looks like a user error. When the two disagree the document wins for that
 * read, and the disagreement is reported so it can be investigated rather than
 * silently absorbed.
 */
export class FallbackSecretStore {
  /**
   * @param {CredentialsServiceSecretStore} primary
   * @param {string} path - the managed credential document.
   * @param {(message: string) => void} [onFallback] - called once per fallback read.
   */
  constructor(primary, path, onFallback = null) {
    this.primary = primary
    this.path = path
    this.onFallback = onFallback
    this.kind = primary.kind
    this.reason = primary.reason
    this.fallbackPath = path
    /** Whether the last read had to fall back. */
    this.usedFallback = false
  }

  get persistent() {
    return true
  }

  async save(key, value) {
    return this.primary.save(key, value)
  }

  async delete(key) {
    return this.primary.delete(key)
  }

  async describe(key) {
    return this.primary.describe(key)
  }

  async read(key) {
    let fromPrimary = null
    try {
      fromPrimary = await this.primary.read(key)
    } catch {
      // A throwing seam is a reason to consult the document, not to give up.
      fromPrimary = null
    }
    if (fromPrimary) {
      this.usedFallback = false
      return fromPrimary
    }
    const fromFile = existsSync(this.path)
      ? readRefFromCredentialsDocument(readFileSync(this.path, 'utf8'), key)
      : null
    this.usedFallback = Boolean(fromFile)
    if (fromFile) {
      this.onFallback?.(
        `the ${this.primary.kind} store did not resolve ${key}; read it from ${this.path} instead`,
      )
    }
    return fromFile
  }
}

/**
 * Pick the best available secret store.
 *
 * `DSH_MAIL_NOTIFY_SECRET_STORE=memory` is an explicit opt-in for headless and
 * CI runs, where credentials stay in memory for the process lifetime and are
 * never persisted. It must never be set on a real desktop.
 *
 * @param {object} options
 * @param {object|null} [options.credentials] - the `ctx.credentials` service, when present.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(message: string) => void} [options.onFallback] - reporter for a file fallback read.
 * @returns {MemorySecretStore|CredentialsServiceSecretStore|FallbackSecretStore|FileSecretStore}
 */
export function createSecretStore({ credentials = null, env = process.env, onFallback = null } = {}) {
  if (String(env.DSH_MAIL_NOTIFY_SECRET_STORE || '').toLowerCase() === 'memory') {
    return new MemorySecretStore('env-override')
  }

  const path = credentialsFilePath(env)
  const fileAvailable = existsSync(path)

  if (credentials && typeof credentials.set === 'function' && typeof credentials.resolve === 'function') {
    const primary = new CredentialsServiceSecretStore(credentials)
    return fileAvailable ? new FallbackSecretStore(primary, path, onFallback) : primary
  }
  if (fileAvailable) return new FileSecretStore(path, 'credentials-service-unreachable')
  return new MemorySecretStore('credentials-service-unreachable-and-no-file')
}
