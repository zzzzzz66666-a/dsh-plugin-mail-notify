#!/usr/bin/env node
/**
 * Run the whole test suite in one process.
 *
 * `node --test <dir>` cannot be used directly here: the runner spawns a child
 * process per file with piped stdio, which a sandboxed shell refuses to create
 * (`spawn EPERM`). Passing explicit files together with `--test-isolation=none`
 * keeps every test in this process, so the suite runs in the same environment a
 * user has. `stdio: 'inherit'` keeps the child's output off a pipe as well.
 *
 * @module scripts/run-tests
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Collect every `*.test.js` under `directory`, depth first. */
function collect(directory) {
  const found = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...collect(path))
    else if (entry.endsWith('.test.js')) found.push(path)
  }
  return found
}

const files = collect(join(ROOT, 'test')).sort()
if (files.length === 0) {
  process.stderr.write('no test files found\n')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', ...files], {
  stdio: 'inherit',
  cwd: ROOT,
})
process.exit(result.status ?? 1)
