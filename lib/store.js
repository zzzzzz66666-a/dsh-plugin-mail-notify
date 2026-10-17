/**
 * Durable JSON storage with atomic writes.
 *
 * Every persisted record lives in a small JSON document. A write goes to a
 * sibling temporary file that is flushed and fsync-ed before an atomic rename,
 * so a crash mid-write can never leave a truncated document behind. The
 * harness process can be killed at any time, and a half-written queue would
 * silently drop notifications, so this invariant matters more here than speed.
 *
 * @module dsh-plugin-mail-notify/store
 */

import { existsSync, mkdirSync, openSync, closeSync, writeSync, fsyncSync, renameSync, unlinkSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Absolute path of the per-user data directory for this plugin. */
export function defaultDataDir(env = process.env) {
  if (env.DSH_MAIL_NOTIFY_DATA_DIR) return env.DSH_MAIL_NOTIFY_DATA_DIR
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'mail-notify')
}

/**
 * Write `text` to `path` atomically.
 *
 * The temporary file is created in the target directory so the final rename
 * stays on one filesystem and is therefore atomic.
 */
export function atomicWriteText(path, text) {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`)
  const handle = openSync(temporary, 'w')
  try {
    writeSync(handle, Buffer.from(text, 'utf8'))
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  try {
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The rename failure is the interesting one; a failed cleanup must not hide it.
    }
    throw error
  }
}

/** Read and parse a JSON document, returning `fallback` when it is absent or corrupt. */
export function readJson(path, fallback = null) {
  if (!path || !existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // A corrupt document is reported by its absence: callers treat it as "no data"
    // and rebuild, which is always safer than refusing to start.
    return fallback
  }
}

/** Serialise `payload` and write it atomically. */
export function writeJson(path, payload) {
  atomicWriteText(path, `${JSON.stringify(payload, null, 2)}\n`)
}

/**
 * A small key/value document persisted as JSON.
 *
 * Mutations go through {@link JsonDocument#update} so that every change is
 * flushed in one atomic write rather than leaving a window where the in-memory
 * and on-disk views disagree.
 */
export class JsonDocument {
  /** @param {string|null} path - file to persist to, or null for a memory-only document. */
  constructor(path) {
    this.path = path || null
    this.data = {}
    this.#load()
  }

  #load() {
    const payload = readJson(this.path, {})
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) this.data = payload
  }

  /** Persist the current in-memory view. */
  save() {
    if (!this.path) return
    writeJson(this.path, this.data)
  }

  /** Mutate the document and persist the result. */
  update(mutator) {
    mutator(this.data)
    this.save()
  }

  /** Delete the backing file and reset the in-memory view. */
  deleteFile() {
    if (this.path && existsSync(this.path)) unlinkSync(this.path)
    this.data = {}
  }

  /**
   * Append `value` to a capped array kept under `key`.
   *
   * The caps mirror the original component: they bound the state file so a
   * long-lived installation cannot grow it without limit, while still covering
   * far more history than any duplicate-suppression window needs.
   */
  rememberInList(key, value, cap) {
    const current = Array.isArray(this.data[key]) ? this.data[key] : []
    const next = [...new Set([...current, value])].sort()
    this.data[key] = next.slice(-cap)
    this.save()
  }

  /** Read a capped array back as a Set. */
  listAsSet(key) {
    return new Set(Array.isArray(this.data[key]) ? this.data[key] : [])
  }
}
