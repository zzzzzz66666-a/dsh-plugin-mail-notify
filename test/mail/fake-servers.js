/**
 * Local TLS stand-ins for the SMTP and IMAP tests.
 *
 * The mail clients are exercised against a real TLS handshake and a real
 * socket conversation, because the failure modes that matter here — literal
 * framing, multi-line replies, dot-stuffing, STARTTLS — only appear on the
 * wire. `rejectUnauthorized: false` is how the tests accept the self-signed
 * fixture certificate; the client code path itself is unchanged.
 */

import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Self-signed certificate and key used by every fake server. */
export const TLS_CERT = readFileSync(join(here, '..', 'fixtures', 'tls-cert.pem'))
export const TLS_KEY = readFileSync(join(here, '..', 'fixtures', 'tls-key.pem'))

/** Options the clients need in order to trust the fixture certificate. */
export const INSECURE_TLS = Object.freeze({ rejectUnauthorized: false })

/** Base64 of `Username:` and `Password:`, the AUTH LOGIN challenges. */
const CHALLENGE_USER = Buffer.from('Username:').toString('base64')
const CHALLENGE_PASSWORD = Buffer.from('Password:').toString('base64')

/** Start a TLS server on an ephemeral loopback port. */
export async function startTlsServer(onConnection) {
  const server = tls.createServer({ cert: TLS_CERT, key: TLS_KEY }, onConnection)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * Split an incoming stream into CRLF-terminated lines.
 *
 * Returns a function that accepts a chunk and invokes `onLine` for every
 * complete line, keeping the remainder buffered.
 */
function lineReader(onLine) {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\r\n')
      if (index < 0) return
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      onLine(line)
    }
  }
}

/**
 * A fake SMTP server implementing the subset the client uses.
 *
 * @param {object} [options]
 * @param {boolean} [options.failAuth] Answer 535 to the credential exchange.
 * @param {boolean} [options.failRcpt] Answer 550 to RCPT TO.
 * @param {boolean} [options.failData] Answer 451 to the final DATA dot.
 */
export async function startSmtpServer({ failAuth = false, failRcpt = false, failData = false } = {}) {
  /** Every command line received, in order. */
  const commands = []
  /** Every accepted DATA payload, CRLF-normalised. */
  const messages = []
  /** Credentials the client presented. */
  const credentials = { username: null, password: null }

  const base = await startTlsServer((socket) => {
    socket.setEncoding('utf8')
    socket.write('220 fake ESMTP ready\r\n')

    let inData = false
    let dataLines = []
    let authStage = null

    const read = lineReader((line) => {
      if (inData) {
        if (line === '.') {
          inData = false
          messages.push(dataLines.join('\r\n'))
          dataLines = []
          socket.write(failData ? '451 4.3.0 Temporary failure\r\n' : '250 2.0.0 Ok: queued\r\n')
          return
        }
        dataLines.push(line)
        return
      }

      if (authStage === 'user') {
        credentials.username = Buffer.from(line, 'base64').toString('utf8')
        authStage = 'password'
        socket.write(`334 ${CHALLENGE_PASSWORD}\r\n`)
        return
      }
      if (authStage === 'password') {
        credentials.password = Buffer.from(line, 'base64').toString('utf8')
        authStage = null
        socket.write(failAuth ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 Authentication successful\r\n')
        return
      }

      commands.push(line)
      const verb = line.split(/\s+/)[0].toUpperCase()
      switch (verb) {
        case 'EHLO':
          socket.write('250-fake greets you\r\n250-AUTH LOGIN PLAIN\r\n250-SIZE 35882577\r\n250 OK\r\n')
          return
        case 'HELO':
          socket.write('250 fake\r\n')
          return
        case 'AUTH':
          if (/^AUTH\s+LOGIN/i.test(line)) {
            authStage = 'user'
            socket.write(`334 ${CHALLENGE_USER}\r\n`)
          } else {
            socket.write('235 2.7.0 Authentication successful\r\n')
          }
          return
        case 'MAIL':
          socket.write('250 2.1.0 Ok\r\n')
          return
        case 'RCPT':
          socket.write(failRcpt ? '550 5.1.1 No such user here\r\n' : '250 2.1.5 Ok\r\n')
          return
        case 'DATA':
          inData = true
          dataLines = []
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
          return
        case 'NOOP':
          socket.write('250 2.0.0 Ok\r\n')
          return
        case 'QUIT':
          socket.write('221 2.0.0 Bye\r\n')
          socket.end()
          return
        default:
          socket.write('250 2.0.0 Ok\r\n')
      }
    })

    socket.on('data', read)
    socket.on('error', () => {
      // A client that hangs up mid-conversation is a test outcome, not a fault.
    })
  })

  return { ...base, commands, messages, credentials }
}

/**
 * A fake IMAP server implementing the subset the client uses.
 *
 * @param {object} [options]
 * @param {Array<{uid: string|number, raw: string|Buffer}>} [options.messages]
 * @param {boolean} [options.failLogin] Answer NO to LOGIN.
 * @param {boolean} [options.failSelect] Answer NO to SELECT.
 */
export async function startImapServer({ messages = [], failLogin = false, failSelect = false } = {}) {
  const commands = []
  const stored = []

  const base = await startTlsServer((socket) => {
    socket.setEncoding('utf8')
    socket.write('* OK [CAPABILITY IMAP4rev1] fake IMAP ready\r\n')

    const read = lineReader((line) => {
      commands.push(line)
      const match = /^(\S+)\s+(.*)$/.exec(line)
      if (!match) return
      const [, tag, rest] = match
      const verb = rest.split(/\s+/)[0].toUpperCase()
      const ok = (text = 'completed') => socket.write(`${tag} OK ${text}\r\n`)

      switch (verb) {
        case 'CAPABILITY':
          socket.write('* CAPABILITY IMAP4rev1\r\n')
          ok()
          return
        case 'LOGIN':
        case 'AUTHENTICATE':
          if (failLogin) socket.write(`${tag} NO LOGIN failed\r\n`)
          else ok('LOGIN completed')
          return
        case 'SELECT':
        case 'EXAMINE':
          if (failSelect) {
            socket.write(`${tag} NO SELECT failed\r\n`)
            return
          }
          socket.write(`* ${messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n`)
          ok('[READ-WRITE] SELECT completed')
          return
        case 'UID': {
          const sub = rest.split(/\s+/)[1]?.toUpperCase()
          if (sub === 'SEARCH') {
            socket.write(`* SEARCH${messages.length ? ` ${messages.map((entry) => entry.uid).join(' ')}` : ''}\r\n`)
            ok('SEARCH completed')
            return
          }
          if (sub === 'FETCH') {
            const uid = rest.split(/\s+/)[2]
            const found = messages.find((entry) => String(entry.uid) === String(uid))
            if (!found) {
              ok('FETCH completed')
              return
            }
            const raw = Buffer.isBuffer(found.raw) ? found.raw : Buffer.from(found.raw, 'utf8')
            // A literal is announced by its exact byte length, then written raw.
            socket.write(`* 1 FETCH (UID ${uid} RFC822 {${raw.length}}\r\n`)
            socket.write(raw)
            socket.write(')\r\n')
            ok('FETCH completed')
            return
          }
          if (sub === 'STORE') {
            stored.push(rest.split(/\s+/)[2])
            ok('STORE completed')
            return
          }
          ok()
          return
        }
        case 'LIST':
          socket.write('* LIST (\\HasNoChildren) "." "INBOX"\r\n')
          socket.write('* LIST (\\HasNoChildren) "." "Archive"\r\n')
          ok('LIST completed')
          return
        case 'LOGOUT':
          socket.write('* BYE\r\n')
          socket.write(`${tag} OK LOGOUT completed\r\n`)
          socket.end()
          return
        default:
          ok()
      }
    })

    socket.on('data', read)
    socket.on('error', () => {
      // See above: a dropped connection is an expected test outcome.
    })
  })

  return { ...base, commands, stored }
}
