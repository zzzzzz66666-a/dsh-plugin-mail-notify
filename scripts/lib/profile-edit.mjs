/**
 * Text-level editors for the two files setup has to touch.
 *
 * Both are hand-written line editors rather than a YAML round-trip, because a
 * round-trip would rewrite the user's whole profile: it would drop comments,
 * reflow formatting and reorder keys in a file the harness itself also edits.
 * Everything here is therefore pure `string -> string`, which is also what
 * makes it testable without touching a real profile.
 *
 * @module scripts/lib/profile-edit
 */

/** The row id this plugin is inserted under. */
export const ROW_ID = 'mail-notify'

/** The package specifier the row mounts. */
export const PACKAGE_NAME = 'dsh-plugin-mail-notify'

/** The credential reference the authorization code is stored under. */
export const AUTH_CODE_REF = 'DSH_MAIL_NOTIFY_AUTH_CODE'

/** Indent width used when rendering new YAML. */
const INDENT = 2

/**
 * Render one YAML scalar.
 *
 * Single quotes are used for every string: they are the only YAML style with
 * no escape sequences beyond doubling the quote itself, so an address
 * containing `:`, `#`, `@` or a leading `*` cannot change the document's
 * meaning.
 */
function yamlScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const text = String(value ?? '')
  if (/[\r\n]/.test(text)) throw new Error(`a configuration value must not contain a line break: ${JSON.stringify(text)}`)
  return `'${text.replace(/'/g, "''")}'`
}

/** Render the loader row for this plugin at the given marker indent. */
export function renderPluginRow(config, markerIndent = 4) {
  const pad = ' '.repeat(markerIndent)
  const key = ' '.repeat(markerIndent + 2)
  const nested = ' '.repeat(markerIndent + 4)
  const lines = [`${pad}- id: ${ROW_ID}`, `${key}name: '${PACKAGE_NAME}'`]
  const entries = Object.entries(config ?? {})
  if (entries.length > 0) {
    lines.push(`${key}config:`)
    for (const [name, value] of entries) lines.push(`${nested}${name}: ${yamlScalar(value)}`)
  }
  return lines
}

/**
 * Find the row belonging to this plugin.
 *
 * @returns {{start: number, end: number, indent: number}|null} half-open line range.
 */
function findRow(lines) {
  const pattern = new RegExp(`^(\\s*)-\\s*id:\\s*${ROW_ID}\\s*$`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index])
    if (!match) continue
    const indent = match[1].length
    let end = index + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line.trim() === '') {
        end += 1
        continue
      }
      const leading = line.length - line.trimStart().length
      if (leading <= indent) break
      end += 1
    }
    // Trailing blank lines belong to the gap, not to the row.
    while (end > index + 1 && lines[end - 1].trim() === '') end -= 1
    return { start: index, end, indent }
  }
  return null
}

/**
 * Insert or replace this plugin's row in a profile patch document.
 *
 * @param {string} text - current `cordis.patch.yml` contents (may be empty).
 * @param {object} config - configuration to render into the row.
 * @returns {string}
 */
export function upsertPluginRow(text, config) {
  const source = String(text ?? '')
  const lines = source.split(/\r?\n/)
  const existing = findRow(lines)
  if (existing) {
    const rendered = renderPluginRow(config, existing.indent)
    return [...lines.slice(0, existing.start), ...rendered, ...lines.slice(existing.end)].join('\n')
  }

  // `[]` is a valid empty document but nothing may follow it, so an append
  // would produce a second root value and an unparseable file.
  const trimmed = lines.filter((line) => !/^\s*\[\s*\]\s*$/.test(line))
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop()

  const block = ['- insert:', ...renderPluginRow(config, 4)]
  const joined = [...trimmed, ...block].join('\n')
  return joined.endsWith('\n') ? joined : `${joined}\n`
}

/**
 * Remove this plugin's row, and the now-empty `insert:` marker that held it.
 *
 * @param {string} text
 * @returns {{text: string, removed: boolean}}
 */
export function removePluginRow(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const existing = findRow(lines)
  if (!existing) return { text: String(text ?? ''), removed: false }

  const remaining = [...lines.slice(0, existing.start), ...lines.slice(existing.end)]
  // Drop an `insert:` marker whose list is now empty; leaving it behind is
  // harmless to the loader but confusing to the next person reading the file.
  for (let index = 0; index < remaining.length; index += 1) {
    if (!/^\s*-\s*insert:\s*$/.test(remaining[index])) continue
    const markerIndent = remaining[index].length - remaining[index].trimStart().length
    const child = remaining[index + 1]
    const childIndent = child === undefined ? -1 : child.length - child.trimStart().length
    const empty = child === undefined || child.trim() === '' || childIndent <= markerIndent
    if (empty) remaining.splice(index, 1)
  }
  // Collapse a run of blank lines left by the deletion.
  return { text: remaining.join('\n').replace(/\n{3,}/g, '\n\n'), removed: true }
}

/**
 * Insert or replace a credential reference in a `.credentials.yaml` document.
 *
 * The harness credentials store accepts direct edits and hot-reloads them, and
 * it rejects any document with an unknown top-level key — so this only ever
 * touches `version` and `refs`.
 *
 * @param {string} text - current file contents; empty when the file is absent.
 * @param {string} ref - an environment-variable-shaped reference name.
 * @param {string} value - the secret; must be non-empty.
 * @param {{version?: number}} [options]
 * @returns {string}
 */
export function upsertCredentialRef(text, ref, value, { version = 1 } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error(`invalid credential reference: ${ref}`)
  if (typeof value !== 'string' || value.trim() === '') throw new Error('the credential value must not be empty')
  const rendered = `  ${ref}: ${yamlScalar(value)}`

  const source = String(text ?? '')
  if (source.trim() === '') return `version: ${version}\nrefs:\n${rendered}\n`

  const lines = source.split(/\r?\n/)
  const refsIndex = lines.findIndex((line) => /^refs:\s*$/.test(line))

  if (refsIndex === -1) {
    // No `refs:` section yet. Place it directly after `version:` when that
    // exists, so the document keeps the store's documented key order.
    const versionIndex = lines.findIndex((line) => /^version:/.test(line))
    const insertAt = versionIndex === -1 ? 0 : versionIndex + 1
    const head = versionIndex === -1 ? [`version: ${version}`] : []
    const next = [...lines.slice(0, insertAt), ...head, 'refs:', rendered, ...lines.slice(insertAt)]
    return next.join('\n')
  }

  let end = refsIndex + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() === '') {
      end += 1
      continue
    }
    if (line.length - line.trimStart().length === 0) break
    end += 1
  }
  while (end > refsIndex + 1 && lines[end - 1].trim() === '') end -= 1

  const existing = lines.findIndex(
    (line, index) => index > refsIndex && index < end && new RegExp(`^\\s+${ref}\\s*:`).test(line),
  )
  if (existing !== -1) {
    const next = [...lines]
    next[existing] = rendered
    return next.join('\n')
  }
  return [...lines.slice(0, end), rendered, ...lines.slice(end)].join('\n')
}

/**
 * Remove a credential reference, dropping an empty `refs:` section.
 *
 * @param {string} text
 * @param {string} ref
 * @returns {{text: string, removed: boolean}}
 */
export function removeCredentialRef(text, ref) {
  const lines = String(text ?? '').split(/\r?\n/)
  const refsIndex = lines.findIndex((line) => /^refs:\s*$/.test(line))
  if (refsIndex === -1) return { text: String(text ?? ''), removed: false }

  let end = refsIndex + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() === '') {
      end += 1
      continue
    }
    if (line.length - line.trimStart().length === 0) break
    end += 1
  }
  while (end > refsIndex + 1 && lines[end - 1].trim() === '') end -= 1

  const target = new RegExp(`^\\s+${ref}\\s*:`)
  const kept = lines.slice(refsIndex + 1, end).filter((line) => !target.test(line))
  if (kept.length === lines.slice(refsIndex + 1, end).length) {
    return { text: String(text ?? ''), removed: false }
  }
  const next = [...lines.slice(0, refsIndex), ...(kept.length > 0 ? ['refs:', ...kept] : []), ...lines.slice(end)]
  return { text: next.join('\n').replace(/\n{3,}/g, '\n\n'), removed: true }
}

/**
 * Read this plugin's configuration back out of a patch document.
 *
 * Used to drive an authentication check from the configuration that is
 * actually installed, rather than from arguments repeated by hand. It reads
 * the shape {@link renderPluginRow} writes; anything hand-edited into a
 * different style is reported as absent rather than mis-parsed.
 *
 * @param {string} text - `cordis.patch.yml` contents.
 * @returns {object|null} the configuration, or null when the row is missing.
 */
export function readPluginRowConfig(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${ROW_ID}\\s*$`).test(line))
  if (start === -1) return null
  const markerIndent = lines[start].length - lines[start].trimStart().length
  const config = {}
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent <= markerIndent) break
    // Only keys nested under `config:` belong to the configuration.
    if (indent < markerIndent + 4) continue
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    config[match[1]] = unquoteScalar(match[2])
  }
  return config
}

/** Turn a scalar written by {@link yamlScalar}, or a plain YAML scalar, back into a value. */
export function unquoteScalar(raw) {
  const text = String(raw ?? '').trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'")
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return text.slice(1, -1)
  return text
}

/**
 * Read a stored credential reference's value.
 *
 * Callers must never print the result: this is the one function in the package
 * whose return value is a secret.
 *
 * @param {string} text - `.credentials.yaml` contents.
 * @param {string} ref - reference name to look up.
 * @returns {string|null} the value, or null when the reference is absent.
 */
export function readCredentialRef(text, ref) {
  const lines = String(text ?? '').split(/\r?\n/)
  const refsIndex = lines.findIndex((line) => /^refs:\s*$/.test(line))
  if (refsIndex === -1) return null

  const target = new RegExp(`^\\s+${ref}\\s*:\\s*(.*)$`)
  for (let index = refsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    // A key at column zero ends the `refs:` section.
    if (line.length - line.trimStart().length === 0) break
    const match = target.exec(line)
    if (match) {
      const value = unquoteScalar(match[1])
      return typeof value === 'string' && value !== '' ? value : null
    }
  }
  return null
}
