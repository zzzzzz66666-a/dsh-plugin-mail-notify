/**
 * Deterministic packaging for this plugin.
 *
 * Determinism is a requirement, not a nicety: the archive's sha256 is what a
 * user compares against the published value, so two builds of identical sources
 * must produce identical bytes. That rules out `Date.now()` timestamps, entry
 * order that depends on directory listing order, and directory entries.
 *
 * The archive is written by hand with `node:zlib`, because a dependency-free
 * build is one fewer thing that can differ between machines. Two traps live in
 * that choice and both are covered rather than hoped over:
 *
 *   - CRC-32 must be coerced to unsigned (`(crc ^ 0xffffffff) >>> 0`), or
 *     `writeUInt32LE` throws `ERR_OUT_OF_RANGE`;
 *   - a Unix mode shifted into the high 16 bits overflows into a negative int
 *     (`(0o100644 << 16) >>> 0`).
 *
 * The `--check` mode is the release gate: it rebuilds from the current sources
 * and fails if the archive on disk is not byte-identical.
 *
 * Usage:
 *   node tools/pack-plugin.mjs            # dist/<name>-<version>.zip + SHA256.txt + .sha256.json
 *   node tools/pack-plugin.mjs --check    # verify a rebuild matches the file on disk
 *
 * @module tools/pack-plugin
 */

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const root = path.resolve(import.meta.dirname, '..')

/**
 * Excluded from the archive whatever their depth.
 *
 * `deliverables/` holds the release bundle (install skill, user manual) that is
 * copied next to the archive for a human, not part of the plugin the loader
 * mounts. `test/` and `tools/` are development scaffolding.
 */
const EXCLUDED = new Set(['dist', 'node_modules', '.git', 'deliverables', 'test', 'tools', '.pnpm-store'])

/** Extensions kept when walking. Everything else is development scaffolding. */
const KEPT_EXTENSIONS = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md', '.txt'])

/**
 * Extensionless files that still belong in the archive.
 *
 * An extension allow-list keeps the archive honest without a directory-by-
 * directory rule, but `LICENSE` has no extension, and a package shipped without
 * its licence is a packaging defect rather than a tidier archive.
 */
const KEPT_NAMES = new Set(['LICENSE', 'LICENCE', 'NOTICE'])

/** Paths that must be present, so a too-eager filter fails loudly instead of shipping a stub. */
const REQUIRED = [
  'package.json',
  'dsh.plugin.json',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
  'README.zh.md',
  'lib/index.js',
  'lib/bridge.js',
  'lib/service.js',
  'lib/mail/smtp.js',
  'lib/mail/imap.js',
  'lib/mail/mime.js',
  'scripts/configure.mjs',
  'scripts/set-credential.mjs',
  'scripts/verify-install.mjs',
  'scripts/check-mailbox.mjs',
  'scripts/uninstall.mjs',
  'scripts/lib/profile-edit.mjs',
]

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/**
 * CRC-32 of a buffer, as an unsigned 32-bit integer.
 *
 * @param {Buffer} buffer - the bytes.
 * @returns {number} the checksum.
 */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Collect the archive members, sorted, with forward-slash names.
 *
 * @param {string} [directory] - directory to walk.
 * @param {string} [prefix] - path prefix for the entries.
 * @returns {Promise<{name: string, bytes: Buffer}[]>}
 */
export async function collectFiles(directory = root, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (EXCLUDED.has(entry.name)) continue
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute, relative)))
      continue
    }
    if (!entry.isFile()) continue
    if (!KEPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !KEPT_NAMES.has(entry.name)) continue
    files.push({ name: relative, bytes: await readFile(absolute) })
  }
  // Sorted by name: independent of the filesystem's listing order.
  return files.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/** A DOS date/time meaning 1980-01-01 00:00:00, the earliest the format can express. */
const FIXED_DOS_TIME = 0
const FIXED_DOS_DATE = (1 << 5) | 1

/**
 * Build a deterministic zip archive.
 *
 * @param {{name: string, bytes: Buffer}[]} files - already sorted.
 * @returns {Buffer} the archive bytes.
 */
export function buildZip(files) {
  const locals = []
  const central = []
  let offset = 0

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.bytes)
    const deflated = deflateRawSync(file.bytes, { level: 9 })
    const method = deflated.length < file.bytes.length ? 8 : 0
    const payload = method === 8 ? deflated : file.bytes

    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(FIXED_DOS_TIME, 10)
    local.writeUInt16LE(FIXED_DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(file.bytes.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    nameBytes.copy(local, 30)
    locals.push(local, payload)

    const entry = Buffer.alloc(46 + nameBytes.length)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt16LE(FIXED_DOS_TIME, 12)
    entry.writeUInt16LE(FIXED_DOS_DATE, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(payload.length, 20)
    entry.writeUInt32LE(file.bytes.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt16LE(0, 30)
    entry.writeUInt16LE(0, 32)
    entry.writeUInt16LE(0, 34)
    entry.writeUInt16LE(0, 36)
    // Unix mode in the high 16 bits; `>>> 0` keeps the shift out of the sign bit.
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    nameBytes.copy(entry, 46)
    central.push(entry)

    offset += local.length + payload.length
  }

  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBytes, end])
}

/**
 * Read a zip back: parse the central directory, inflate each member, check CRCs.
 *
 * "The archive exists and is not empty" is not a test. This is.
 *
 * @param {Buffer} archive - the zip bytes.
 * @returns {{name: string, bytes: Buffer, crc: number}[]} in central-directory order.
 */
export function readZip(archive) {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endOffset < 0) throw new Error('zip: end-of-central-directory record not found')
  const count = archive.readUInt16LE(endOffset + 10)
  let cursor = archive.readUInt32LE(endOffset + 16)
  const members = []
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`zip: bad central header at ${cursor}`)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataAt = localOffset + 30 + localNameLength + localExtraLength
    const raw = archive.subarray(dataAt, dataAt + compressedSize)
    const bytes = method === 8 ? inflateRawSync(raw) : raw
    if (crc32(bytes) !== crc) throw new Error(`zip: CRC mismatch for ${name}`)
    members.push({ name, bytes, crc })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return members
}

/**
 * Build the archive for the current sources.
 *
 * @returns {Promise<{bytes: Buffer, files: {name: string, bytes: Buffer}[]}>}
 */
export async function buildArchive() {
  for (const required of REQUIRED) await access(path.join(root, required))
  const files = await collectFiles()
  const present = new Set(files.map((file) => file.name))
  for (const required of REQUIRED) {
    if (!present.has(required)) throw new Error(`archive would omit ${required}`)
  }
  for (const file of files) {
    if (file.name.includes('..') || file.name.includes('\\') || /^[A-Za-z]:/.test(file.name)) {
      throw new Error(`unsafe archive path: ${file.name}`)
    }
    if (!/^[\x20-\x7e]+$/.test(file.name)) throw new Error(`non-ASCII archive path: ${file.name}`)
  }
  const bytes = buildZip(files)
  // Read the archive back before anyone is told it is fine.
  const members = readZip(bytes)
  if (members.length !== files.length) throw new Error('archive round-trip lost members')
  for (const member of members) {
    const source = files.find((file) => file.name === member.name)
    if (!source || !source.bytes.equals(member.bytes)) throw new Error(`archive round-trip mismatch: ${member.name}`)
  }
  return { bytes, files }
}

/** The `package.json` of the plugin being packaged. */
export async function packageManifest() {
  return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
}

/**
 * Run the packager as a command.
 *
 * @param {string[]} argv - `process.argv`-shaped arguments.
 * @returns {Promise<number>} the intended exit code.
 */
export async function runCli(argv) {
  const check = argv.includes('--check')
  const manifest = await packageManifest()
  const { bytes, files } = await buildArchive()
  const distDir = path.join(root, 'dist')
  const archiveName = `${manifest.name}-${manifest.version}.zip`
  const archivePath = path.join(distDir, archiveName)
  const sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase()

  if (check) {
    let current
    try {
      current = await readFile(archivePath)
    } catch {
      process.stderr.write(`dist/${archiveName} is missing; run: node tools/pack-plugin.mjs\n`)
      return 1
    }
    if (!current.equals(bytes)) {
      process.stderr.write(`dist/${archiveName} differs from a fresh build; re-run the packager\n`)
      return 1
    }
    process.stdout.write(`ok  dist/${archiveName} matches a fresh build\n    sha256 ${sha256}\n`)
    return 0
  }

  await mkdir(distDir, { recursive: true })
  await writeFile(archivePath, bytes)
  await writeFile(path.join(distDir, 'SHA256.txt'), `${sha256}  ${archiveName}\n`, 'utf8')
  await writeFile(
    path.join(distDir, `${manifest.name}-${manifest.version}.sha256.json`),
    `${JSON.stringify(
      {
        package: archiveName,
        version: manifest.version,
        created_at: new Date().toISOString(),
        file_count: files.length,
        bytes: bytes.length,
        sha256,
        excluded: [...EXCLUDED].sort(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  process.stdout.write(`${files.length} files -> dist/${archiveName} (${bytes.length} bytes)\nsha256 ${sha256}\n`)
  for (const file of files) process.stdout.write(`  ${file.name}\n`)
  return 0
}

// Only act as a CLI when executed directly, not when imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await runCli(process.argv.slice(2)))
}
