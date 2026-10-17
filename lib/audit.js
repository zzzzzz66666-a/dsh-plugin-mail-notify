/**
 * Local audit trail that never stores credentials or one-time codes.
 *
 * The audit log is the only place a user can see why a reply was rejected or a
 * mail was not sent, so it must be safe to read and safe to share in a bug
 * report — hence the redaction pass on every field that is written.
 *
 * @module dsh-plugin-mail-notify/audit
 */

import { randomUUID } from 'node:crypto'
import { readJson, writeJson } from './store.js'

/**
 * Patterns removed before anything is persisted.
 *
 * The standalone-token rule is deliberately case-sensitive: a case-insensitive
 * version also matched ordinary lowercase words and destroyed the audit trail.
 */
const REDACTION_PATTERNS = [
  {
    pattern: /(授权码|验证码|auth(?:orization)?[ _-]?code|password|token|code)\s*[:：=]\s*\S+/gi,
    replace: (match) => `${match.split(/[:：=]/)[0]}:[REDACTED]`,
  },
  { pattern: /\b[0-9A-F]{8}\b/g, replace: () => '[REDACTED]' },
]

/** Remove anything that looks like a secret from `text`. */
export function redact(text) {
  let result = String(text ?? '')
  for (const { pattern, replace } of REDACTION_PATTERNS) {
    result = result.replace(pattern, replace)
  }
  return result
}

/** Append-only audit trail persisted as JSON. */
export class AuditLog {
  /**
   * @param {object} [options]
   * @param {string|null} [options.path] - JSON file backing the log.
   * @param {number} [options.maxRecords] - retained record count.
   */
  constructor({ path = null, maxRecords = 2000 } = {}) {
    this.path = path || null
    this.maxRecords = maxRecords
    this.records = []
    this.#load()
  }

  /** Alias kept for parity with the reference component. */
  safeText(text) {
    return redact(text)
  }

  /** Append one event. Every text field passes through {@link redact} first. */
  record(action, result, { taskId = null, replyId = null, errorCategory = null } = {}) {
    const entry = {
      auditId: randomUUID().replace(/-/g, ''),
      action: redact(action),
      taskId,
      replyId,
      result: redact(result),
      errorCategory: errorCategory ? redact(errorCategory) : null,
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    }
    this.records.push(entry)
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords)
    }
    this.#persist()
    return entry
  }

  /** Newest `limit` records. */
  recent(limit = 50) {
    return this.records.slice(-limit)
  }

  #persist() {
    if (!this.path) return
    writeJson(this.path, this.records)
  }

  #load() {
    const payload = readJson(this.path, [])
    if (!Array.isArray(payload)) return
    this.records = payload.filter((entry) => entry && typeof entry === 'object')
  }
}
