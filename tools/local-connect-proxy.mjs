/**
 * Minimal HTTP CONNECT proxy that dials a fixed, reachable address.
 *
 * Why this exists: on some networks `github.com` resolves to an address whose
 * 443 is blocked, while other GitHub addresses answer normally. Git has no
 * per-host "connect here instead" option, so a tiny CONNECT proxy is used to
 * point the transport at a working address without touching the system hosts
 * file, DNS, or TLS verification. The certificate is still validated end to end
 * because the TLS session runs between git and the real server — this process
 * only forwards bytes.
 *
 * Usage:
 *   node tools/local-connect-proxy.mjs --listen 8899 --host github.com:443 \
 *        --to 140.82.113.4 --to 140.82.112.3
 *
 *   git -c http.proxy=http://127.0.0.1:8899 push -u origin HEAD:main
 *
 * It is a development aid, not part of the plugin: it lives under `tools/`,
 * which the packager excludes.
 *
 * @module tools/local-connect-proxy
 */

import net from 'node:net'

/** Parse `--key value` / `--key=value` pairs, collecting repeated `--to`. */
function parseArgs(argv) {
  const flags = { listen: 8899, host: 'github.com:443', to: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=')
    const value = inline ?? argv[++index]
    if (name === 'to') flags.to.push(value)
    else if (name === 'listen') flags.listen = Number(value)
    else if (name === 'host') flags.host = value
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
if (flags.to.length === 0) {
  process.stderr.write('need at least one --to <ip>\n')
  process.exit(2)
}

const [, portText] = flags.host.split(':')
const targetPort = Number(portText ?? 443)

/** Rotate through the candidate addresses so one dead host does not stall a push. */
let nextTarget = 0
const pickTarget = () => flags.to[nextTarget++ % flags.to.length]

const server = net.createServer((client) => {
  client.on('error', () => client.destroy())
  let buffer = Buffer.alloc(0)
  let settled = false

  const onData = (chunk) => {
    if (settled) return
    buffer = Buffer.concat([buffer, chunk])
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) {
      if (buffer.length > 64 * 1024) {
        client.destroy()
      }
      return
    }
    settled = true
    client.off('data', onData)

    const header = buffer.subarray(0, headerEnd).toString('latin1')
    const requestLine = header.split('\r\n')[0]
    const leftover = buffer.subarray(headerEnd + 4)
    const method = requestLine.split(' ')[0]?.toUpperCase()

    if (method !== 'CONNECT') {
      // Only tunnelling is needed here; refusing is clearer than proxying plain
      // HTTP by accident.
      client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n')
      return
    }

    const target = pickTarget()
    const upstream = net.connect({ host: target, port: targetPort }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (leftover.length > 0) upstream.write(leftover)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => {
      try {
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
      } catch {
        // The client may already be gone; nothing useful to do with that.
      }
      client.destroy()
    })
  }

  client.once('data', onData)
})

server.on('error', (error) => {
  process.stderr.write(`proxy error: ${error.message}\n`)
  process.exit(1)
})

server.listen(flags.listen, '127.0.0.1', () => {
  process.stdout.write(`CONNECT proxy 127.0.0.1:${flags.listen} -> ${flags.host} via ${flags.to.join(', ')}\n`)
})
