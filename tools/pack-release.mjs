/**
 * Assemble the release folder a user actually receives.
 *
 * The plugin archive alone is not a delivery: a user also needs the install
 * skill (so their assistant can drive the setup), a manual written for a human,
 * an unpacked copy of the sources they can read, and a record proving all of it
 * came from one verified build.
 *
 * Everything here is deterministic except the `created_at` field, so
 * `--check` can rebuild in memory and compare against what is on disk. That is
 * the release gate: a folder that does not match a fresh build must not be
 * shipped.
 *
 * Usage:
 *   node tools/pack-release.mjs --out "<release folder>"
 *   node tools/pack-release.mjs --out "<release folder>" --check
 *
 * @module tools/pack-release
 */

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildArchive, buildZip, collectFiles, packageManifest, readZip } from './pack-plugin.mjs'

const root = path.resolve(import.meta.dirname, '..')
const deliverables = path.join(root, 'deliverables')
const skillDir = path.join(deliverables, 'skill', 'dsh-mail-notify-install')

/** Release-folder entries that are generated rather than copied from the repo. */
const GENERATED = new Set(['packaging-check.json'])

/**
 * Symbolic link through `readdir` order for a deterministic walk.
 *
 * @param {string} directory
 * @param {string} [prefix]
 * @returns {Promise<{name: string, bytes: Buffer}[]>}
 */
async function collectTree(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectTree(absolute, relative)))
      continue
    }
    if (!entry.isFile()) continue
    files.push({ name: relative, bytes: await readFile(absolute) })
  }
  return files.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/** sha256 of a buffer, upper-case hex like the rest of the release channel. */
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase()
}

/**
 * Build the whole release in memory.
 *
 * @returns {Promise<{files: Map<string, Buffer>, summary: object}>}
 */
export async function buildRelease() {
  await access(skillDir)
  const manifest = await packageManifest()
  const version = manifest.version
  const archiveName = `${manifest.name}-${version}.zip`
  const skillName = `${manifest.name}-install-${version}-skill.zip`

  const { bytes: pluginBytes, files: pluginFiles } = await buildArchive()
  const pluginSha = digest(pluginBytes)

  const skillFiles = await collectTree(skillDir)
  for (const required of ['SKILL.md', 'references/troubleshooting.md', 'scripts/install_plugin.ps1']) {
    if (!skillFiles.some((file) => file.name === required)) {
      throw new Error(`the install skill is incomplete: missing ${required}`)
    }
  }
  const skillBytes = buildZip(skillFiles)
  // Read it back: a zip nobody verified is a zip nobody should trust.
  const skillMembers = readZip(skillBytes)
  if (skillMembers.length !== skillFiles.length) throw new Error('skill archive round-trip lost members')
  for (const member of skillMembers) {
    const source = skillFiles.find((file) => file.name === member.name)
    if (!source || !source.bytes.equals(member.bytes)) throw new Error(`skill archive mismatch: ${member.name}`)
  }
  const skillSha = digest(skillBytes)

  /** @type {Map<string, Buffer>} */
  const files = new Map()

  files.set(archiveName, pluginBytes)
  files.set('SHA256.txt', Buffer.from(`${pluginSha}  ${archiveName}\n`, 'utf8'))
  files.set(
    `${manifest.name}-${version}.sha256.json`,
    Buffer.from(
      `${JSON.stringify(
        {
          package: archiveName,
          version,
          file_count: pluginFiles.length,
          bytes: pluginBytes.length,
          sha256: pluginSha,
        },
        null,
        2,
      )}\n`,
      'utf8',
    ),
  )

  files.set(skillName, skillBytes)
  files.set(`${manifest.name}-install-${version}-skill.sha256`, Buffer.from(`${skillSha}\n`, 'utf8'))

  // Human-facing documents, copied with their names preserved.
  for (const document of ['README.md', '使用说明.md']) {
    files.set(document, await readFile(path.join(deliverables, document)))
  }

  // The unpacked skill, so a user can point their assistant at a folder rather
  // than asking it to unzip something first.
  for (const file of skillFiles) {
    files.set(`skill/dsh-mail-notify-install/${file.name}`, file.bytes)
  }

  // Unpacked sources: lets a reader — human or assistant — inspect the code
  // without unzipping, and makes the release folder self-explanatory.
  for (const file of pluginFiles) {
    files.set(`plugin/${file.name}`, file.bytes)
  }

  const summary = {
    version,
    plugin: { name: archiveName, files: pluginFiles.length, bytes: pluginBytes.length, sha256: pluginSha },
    skill: { name: skillName, files: skillFiles.length, bytes: skillBytes.length, sha256: skillSha },
    entries: [...files.keys()].sort(),
  }

  const record = {
    created_at: new Date().toISOString(),
    ...summary,
    // Determinism matters because a user compares the sha256 they were told
    // against the file they downloaded.
    deterministic: 'rebuild with --check to verify byte-for-byte',
  }
  files.set('packaging-check.json', Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'))

  return { files, summary }
}

/**
 * Run the assembly as a command.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function runCli(argv) {
  const check = argv.includes('--check')
  const outIndex = argv.indexOf('--out')
  const outDir = outIndex >= 0 ? argv[outIndex + 1] : null
  if (!outDir) {
    process.stderr.write('usage: node tools/pack-release.mjs --out "<release folder>" [--check]\n')
    return 1
  }

  const { files, summary } = await buildRelease()

  if (check) {
    let mismatches = 0
    for (const [name, bytes] of files) {
      if (GENERATED.has(name)) continue
      let onDisk
      try {
        onDisk = await readFile(path.join(outDir, name))
      } catch {
        process.stdout.write(`MISSING  ${name}\n`)
        mismatches += 1
        continue
      }
      if (!onDisk.equals(bytes)) {
        process.stdout.write(`DIFFERS  ${name}\n`)
        mismatches += 1
      }
    }
    if (mismatches > 0) {
      process.stderr.write(`\n${mismatches} release entries do not match a fresh build\n`)
      return 1
    }
    process.stdout.write(`ok  ${files.size} release entries match a fresh build\n`)
    process.stdout.write(`    plugin sha256 ${summary.plugin.sha256}\n`)
    process.stdout.write(`    skill  sha256 ${summary.skill.sha256}\n`)
    return 0
  }

  for (const [name, bytes] of files) {
    const target = path.join(outDir, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }

  process.stdout.write(`release written to ${outDir}\n`)
  process.stdout.write(`  plugin  ${summary.plugin.name}  (${summary.plugin.files} files, ${summary.plugin.bytes} B)\n`)
  process.stdout.write(`          sha256 ${summary.plugin.sha256}\n`)
  process.stdout.write(`  skill   ${summary.skill.name}  (${summary.skill.files} files, ${summary.skill.bytes} B)\n`)
  process.stdout.write(`          sha256 ${summary.skill.sha256}\n`)
  process.stdout.write(`  entries ${files.size}\n`)
  return 0
}

// Only act as a CLI when executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await runCli(process.argv.slice(2)))
}
