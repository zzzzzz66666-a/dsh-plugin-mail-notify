/**
 * Minimal, dependency-free IMAP4rev1 client (RFC 3501) with an explicit error
 * taxonomy.
 *
 * Port of `codex_notify/adapters/mail/imap_receiver.py`, which leaned on
 * `imaplib`; the protocol steps (literals, tagged/untagged responses, UID
 * variants) are reproduced here on top of `node:net` and `node:tls`.
 *
 * @module mail/imap
 */

import {
  AuthenticationFailed,
  MailError,
  PermanentMailError,
  TransientMailError,
} from './errors.js';
import { parseMessage } from './mime.js';
import {
  createLogSink,
  delay,
  mapSocketError,
  openPlainSocket,
  openTlsSocket,
  upgradeSocketToTls,
} from './transport.js';

/** Default ports per RFC 8314 / common provider practice. */
const DEFAULT_PORTS = { ssl: 993, starttls: 143 };

/** How long the best-effort LOGOUT is allowed to take before hanging up. */
const LOGOUT_TIMEOUT_MS = 1000;

/**
 * Restrict the search to mail addressed to this plugin; otherwise every
 * newsletter in the mailbox would be fetched (and could be marked read) on
 * every poll.
 *
 * Deliberately **not** `UNSEEN`. A reply can arrive already seen — a client
 * that keeps a conversation open marks the arriving message read, and QQ web
 * mail does exactly that — and an unseen-only search then never sees it at all.
 * That failure is silent and total: the reply simply never exists as far as the
 * plugin is concerned. Message-ID de-duplication is what keeps the wider search
 * cheap, and {@link buildSearchCriteria} bounds it by date.
 *
 * @type {string[]}
 */
const DEFAULT_SEARCH_CRITERIA = ['SUBJECT', '"[DSH]"'];

/** English month abbreviations; IMAP dates are locale-independent by definition. */
const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a date the way `IMAP SEARCH` expects: `dd-Mon-yyyy`, always English.
 *
 * @param {Date} date
 * @returns {string}
 */
export function imapDate(date) {
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${day}-${IMAP_MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/**
 * Build the search this plugin runs each poll.
 *
 * `SINCE` keeps the wider, unseen-independent search bounded: the one-time code
 * is only valid for a day, so mail older than the lookback can never be
 * accepted, and skipping it keeps each poll's fetch small even after months of
 * notifications have piled up in the mailbox.
 *
 * @param {object} [options]
 * @param {string} [options.subjectTag] - the queue tag, e.g. `[DSH]`.
 * @param {Date} [options.now] - clock injection for tests.
 * @param {number} [options.lookbackDays] - how far back to search.
 * @returns {string[]} flat IMAP search tokens.
 */
export function buildSearchCriteria({ subjectTag = '[DSH]', now = new Date(), lookbackDays = 3 } = {}) {
  const from = new Date(now.getTime() - Math.max(1, lookbackDays) * 24 * 60 * 60 * 1000);
  return ['SINCE', imapDate(from), 'SUBJECT', `"${subjectTag}"`];
}

/** Runaway-response guard; a tagged reply must arrive long before this. */
const MAX_RESPONSE_LINES = 100_000;

/**
 * Encode an IMAP `astring`: quoted for printable ASCII, a literal for anything
 * else. CR/LF/NUL would let a caller inject commands, so they are rejected.
 *
 * @param {string} value
 * @returns {string|Buffer} `Buffer` means "send as a synchronising literal".
 */
function imapString(value) {
  const text = String(value ?? '');
  if (/[\u0000\r\n]/.test(text)) {
    throw new MailError('IMAP argument may not contain CR, LF or NUL');
  }
  if (/^[\x20-\x7e]*$/.test(text)) return `"${text.replace(/[\\"]/g, '\\$&')}"`;
  return Buffer.from(text, 'utf8');
}

/**
 * Pull UIDs out of `* SEARCH ...` responses.
 *
 * @param {{ text: string }[]} lines
 * @returns {string[]}
 */
function parseSearchUids(lines) {
  for (const line of lines) {
    const match = /^\* SEARCH(?: (.*))?$/i.exec(line.text);
    if (match) return (match[1] ?? '').split(/\s+/).filter((uid) => uid.length > 0);
  }
  return [];
}

/**
 * @param {{ text: string }[]} lines
 * @returns {number} Message count from `* n EXISTS`, or 0.
 */
function parseExists(lines) {
  let exists = 0;
  for (const line of lines) {
    const match = /^\* (\d+) EXISTS\b/i.exec(line.text);
    if (match) exists = Number(match[1]);
  }
  return exists;
}

/**
 * Extract a folder name from one `* LIST` response, including literal names.
 *
 * @param {{ text: string, literals: Buffer[] }} line
 * @returns {string|null}
 */
function parseListLine(line) {
  const match = /^\* LIST \([^)]*\)\s+(?:"[^"]*"|NIL)\s+(.*)$/i.exec(line.text);
  if (!match) return null;
  let raw = match[1].trim();

  if (/\{\d+\}$/.test(raw) && line.literals.length > 0) {
    return line.literals[line.literals.length - 1].toString('utf8');
  }
  if (raw.startsWith('"')) {
    const end = raw.lastIndexOf('"');
    raw = end > 0 ? raw.slice(1, end) : raw.slice(1);
  }
  return raw.replace(/\\(.)/g, '$1').trim();
}

/**
 * One IMAP connection: response framing (including literals), tagged-command
 * dispatch and the command writer used for synchronising literals.
 */
class ImapChannel {
  /** @param {import('node:net').Socket} socket */
  constructor(socket, { timeoutMs = 30_000, log = null } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.buffer = Buffer.alloc(0);
    this.lines = [];
    this.waiters = [];
    this.failure = null;
    this.tagCounter = 0;

    this.onData = (chunk) => this.#handleData(chunk);
    this.onError = (error) => this.#fail(mapSocketError(error, 'IMAP server'));
    this.onClose = () => this.#fail(new TransientMailError('IMAP connection closed unexpectedly'));
    this.onEnd = () => this.#fail(new TransientMailError('IMAP connection closed unexpectedly'));

    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.on('end', this.onEnd);
  }

  /** Stop watching the socket; used before a STARTTLS upgrade. */
  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    this.socket.off('end', this.onEnd);
  }

  /** @param {string} text */
  write(text) {
    this.log?.('C', text.replace(/\r\n$/, ''));
    this.socket.write(text, 'utf8');
  }

  /**
   * Send a command and read its tagged completion.
   *
   * `Buffer` entries in `parts` are transmitted as synchronising literals
   * (`{n}` then CRLF, wait for `+`, then the raw bytes), which is what RFC 3501
   * requires for non-ASCII credentials and mailbox names.
   *
   * @param {(string|Buffer)[]} parts
   * @returns {Promise<{ status: string, text: string, lines: { text: string, literals: Buffer[] }[] }>}
   */
  async run(parts) {
    const tag = `a${(this.tagCounter += 1)}`;
    let pending = `${tag} `;

    for (const part of parts) {
      if (typeof part === 'string') {
        pending += part;
        continue;
      }
      this.write(`${pending}{${part.length}}\r\n`);
      pending = '';
      const early = await this.#awaitContinuation(tag);
      if (early) return early; // server refused the literal
      this.log?.('C', `<${part.length} bytes literal>`);
      this.socket.write(part);
    }

    this.write(`${pending}\r\n`);
    return this.readTagged(tag);
  }

  /**
   * @returns {Promise<{ text: string, literals: Buffer[] }>}
   */
  async readLine() {
    const queued = this.lines.shift();
    if (queued) return queued;
    if (this.failure) throw this.failure;

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.fail(new TransientMailError('IMAP operation timed out', { detail: `no reply within ${this.timeoutMs} ms` }));
        this.socket.destroy();
      }, this.timeoutMs);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /**
   * Read until the tagged completion for `tag` arrives.
   *
   * @param {string} tag
   * @returns {Promise<{ status: string, text: string, lines: { text: string, literals: Buffer[] }[] }>}
   */
  async readTagged(tag) {
    const lines = [];
    while (lines.length < MAX_RESPONSE_LINES) {
      const line = await this.readLine();
      lines.push(line);
      const match = /^(\S+) (OK|NO|BAD)\b/i.exec(line.text);
      if (match && match[1] === tag) {
        return { status: match[2].toUpperCase(), text: line.text, lines };
      }
    }
    throw new TransientMailError('IMAP response exceeded the line limit');
  }

  /** @param {MailError} error */
  fail(error) {
    this.#fail(error);
  }

  /**
   * Wait for a `+` continuation, unless the server answers the command first.
   *
   * @param {string} tag
   * @returns {Promise<{ status: string, text: string, lines: { text: string, literals: Buffer[] }[] }|null>}
   */
  async #awaitContinuation(tag) {
    while (true) {
      const line = await this.readLine();
      if (line.text.startsWith('+')) return null;
      const match = /^(\S+) (OK|NO|BAD)\b/i.exec(line.text);
      if (match && match[1] === tag) {
        return { status: match[2].toUpperCase(), text: line.text, lines: [line] };
      }
    }
  }

  /** @param {MailError} error */
  #fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  /** @param {Buffer} chunk */
  #handleData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let line = this.#extractLine();
    while (line) {
      this.log?.('S', line.text);
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        this.lines.push(line);
      }
      line = this.#extractLine();
    }
  }

  /**
   * Take one complete logical response line off the buffer, following literals
   * (`{n}` CRLF then exactly n raw bytes) until the terminating CRLF.
   *
   * @returns {{ text: string, literals: Buffer[] }|null} `null` when more bytes are needed.
   */
  #extractLine() {
    let cursor = 0;
    let text = '';
    const literals = [];

    while (true) {
      const newline = this.buffer.indexOf(0x0a, cursor);
      if (newline === -1) return null; // incomplete line

      let segment = this.buffer.subarray(cursor, newline).toString('latin1');
      if (segment.endsWith('\r')) segment = segment.slice(0, -1);
      text += segment;

      // `{n}` may be followed by nothing else on the line; `{n+}` is the
      // non-synchronising form a few servers still emit.
      const literal = /\{(\d+)\+?\}$/.exec(segment);
      if (!literal) return this.#consume(newline + 1, text, literals);

      const size = Number(literal[1]);
      const start = newline + 1;
      if (this.buffer.length < start + size) return null; // literal still in flight
      literals.push(this.buffer.subarray(start, start + size));
      cursor = start + size;
      if (size === 0) cursor = start; // zero-length literal consumes no bytes
    }
  }

  /**
   * @param {number} end Offset just past the line terminator.
   * @param {string} text Response text with `{n}` markers left in place.
   * @param {Buffer[]} literals
   * @returns {{ text: string, literals: Buffer[] }}
   */
  #consume(end, text, literals) {
    this.buffer = this.buffer.subarray(end);
    return { text, literals };
  }
}

/**
 * Fetch replies from an IMAP mailbox (implicit TLS or STARTTLS).
 */
export class ImapMailReceiver {
  /**
   * @param {object} options
   * @param {string} options.host Server hostname.
   * @param {number} [options.port] Defaults to 993 for `ssl`, 143 for `starttls`.
   * @param {'ssl'|'starttls'} options.security Transport security mode.
   * @param {string} options.username Account / authorization code user.
   * @param {string} options.password Account / authorization code.
   * @param {string} [options.mailbox='INBOX'] Mailbox to poll.
   * @param {number} [options.timeoutMs=30000] Idle timeout for connect and each reply.
   * @param {string[]} [options.searchCriteria] Flat IMAP search tokens.
   * @param {number} [options.maxPerPoll=25] Newest matches fetched per poll.
   * @param {object} [options.tlsOptions] Merged into `tls.connect`.
   * @param {boolean} [options.debug=false] Log the conversation to `logger` or stderr.
   * @param {((direction: string, line: string) => void)|{debug?: Function}} [options.logger]
   *   Injectable sink for the debug trace; nothing is logged without it.
   */
  constructor({
    host,
    port,
    security,
    username,
    password,
    mailbox = 'INBOX',
    timeoutMs = 30_000,
    searchCriteria,
    maxPerPoll = 25,
    sinceUid = 0,
    tlsOptions = {},
    debug = false,
    logger = null,
  } = {}) {
    if (security !== 'ssl' && security !== 'starttls') {
      throw new MailError(`unsupported imap security: ${security}`);
    }
    if (!host) throw new MailError('imap host is required');
    this.host = host;
    this.port = port ?? DEFAULT_PORTS[security];
    this.security = security;
    this.username = username;
    this.password = password;
    this.mailbox = mailbox;
    this.timeoutMs = timeoutMs;
    this.searchCriteria = searchCriteria ?? DEFAULT_SEARCH_CRITERIA;
    this.maxPerPoll = Math.max(1, Number(maxPerPoll) || 1);
    // UID high-water mark: fetch only mail that arrived since the last poll.
    // Without it a poll re-downloads the whole search window every cycle — and
    // because the newest message sits last in ascending UID order, a reply waits
    // behind every older message before it is even looked at.
    this.sinceUid = Math.max(0, Number(sinceUid) || 0);
    /** True when the last `receive()` saw the mailbox's UIDs move backwards. */
    this.uidReset = false;
    /** Highest UID fetched by the last `receive()`, for the caller to persist. */
    this.lastUid = 0;
    this.tlsOptions = tlsOptions ?? {};
    this.debug = debug;
    this.logger = logger;
  }

  /**
   * Fetch the newest messages matching the search criteria.
   *
   * @returns {Promise<ReturnType<typeof parseMessage>[]>} Newest last, as IMAP returns them.
   * @throws {MailError}
   */
  async receive() {
    const channel = await this.#open();
    try {
      const selected = await this.#select(channel, this.mailbox, false);
      if (selected.status !== 'OK') {
        throw new PermanentMailError(`IMAP SELECT failed for ${this.mailbox}`, { detail: selected.text });
      }
      const search = await channel.run([`UID SEARCH ${this.searchCriteria.join(' ')}`]);
      if (search.status !== 'OK') {
        throw new TransientMailError('IMAP SEARCH for mail failed', { detail: search.text });
      }
      const uids = this.#uidsSince(parseSearchUids(search.lines));
      const messages = await this.#fetchMany(channel, uids);
      // Advance the mark only past what was actually fetched, so a message that
      // was missed — because the batch cap trimmed it, or its FETCH failed — is
      // picked up next cycle instead of being silently skipped forever. After a
      // UID reset the old mark is meaningless and must not seed the new one.
      const seed = this.uidReset ? 0 : this.sinceUid;
      this.lastUid = messages.reduce((max, message) => Math.max(max, Number(message.uid) || 0), seed);
      return messages;
    } catch (error) {
      throw this.#translate(error, 'IMAP connection failed during fetch');
    } finally {
      await this.#logout(channel);
    }
  }

  /**
   * Narrow a search result to the messages this poll actually needs.
   *
   * @param {string[]} matches - every UID the search returned, ascending.
   * @returns {string[]} at most `maxPerPoll` UIDs, newest last.
   */
  #uidsSince(matches) {
    this.uidReset = false;
    if (!this.sinceUid) return matches.slice(-this.maxPerPoll);

    const newer = matches.filter((uid) => Number(uid) > this.sinceUid);
    if (newer.length > 0) return newer.slice(-this.maxPerPoll);

    // Nothing newer than the mark. Either the mailbox is quiet, or its UIDs
    // restarted — a moved-back range is the signal for that, and re-scanning
    // the window for one cycle is how the caller recovers without any extra
    // round trip to read UIDVALIDITY.
    const highest = matches.reduce((max, uid) => Math.max(max, Number(uid) || 0), 0);
    if (matches.length > 0 && highest < this.sinceUid) {
      this.uidReset = true;
      return matches.slice(-this.maxPerPoll);
    }
    return [];
  }

  /**
   * Mark several messages as seen over a single connection.
   *
   * @param {string[]} uids
   * @returns {Promise<void>}
   * @throws {MailError}
   */
  async acknowledgeMany(uids) {
    const pending = (uids ?? []).map((uid) => String(uid ?? '')).filter((uid) => uid.length > 0);
    if (pending.length === 0) return;

    const channel = await this.#open();
    try {
      await this.#select(channel, this.mailbox, false);
      for (const uid of pending) {
        const stored = await channel.run([`UID STORE ${uid} +FLAGS (\\Seen)`]);
        if (stored.status !== 'OK') {
          throw new TransientMailError('IMAP STORE failed', { detail: stored.text });
        }
      }
    } catch (error) {
      throw this.#translate(error, 'IMAP connection failed while marking mail seen');
    } finally {
      await this.#logout(channel);
    }
  }

  /**
   * Connect, log in and select the mailbox without fetching anything.
   *
   * @returns {Promise<void>}
   * @throws {MailError}
   */
  async testConnection() {
    const channel = await this.#open();
    try {
      const selected = await this.#select(channel, this.mailbox, false);
      if (selected.status !== 'OK') {
        throw new PermanentMailError('IMAP mailbox could not be selected', { detail: selected.text });
      }
    } catch (error) {
      throw this.#translate(error, 'IMAP connection failed during select');
    } finally {
      await this.#logout(channel);
    }
  }

  /**
   * List folders with their message counts; used to locate mail that a provider
   * files away from the inbox.
   *
   * @returns {Promise<{ name: string, count: number }[]>} `count` is -1 when unknown.
   * @throws {MailError}
   */
  async listFolders() {
    const channel = await this.#open();
    const folders = [];
    try {
      const listed = await channel.run(['LIST "" "*"']);
      if (listed.status !== 'OK') {
        throw new TransientMailError('IMAP LIST failed', { detail: listed.text });
      }
      for (const line of listed.lines) {
        const name = parseListLine(line);
        if (name === null) continue;
        let count = -1;
        try {
          const examined = await this.#select(channel, name, true);
          if (examined.status === 'OK') count = examined.exists;
        } catch {
          count = -1; // a folder we cannot examine is still worth listing
        }
        folders.push({ name, count });
      }
      return folders;
    } catch (error) {
      throw this.#translate(error, 'IMAP connection failed while listing folders');
    } finally {
      await this.#logout(channel);
    }
  }

  /**
   * Fetch the newest messages regardless of read state (diagnostics).
   *
   * @param {number} [limit=10]
   * @returns {Promise<ReturnType<typeof parseMessage>[]>}
   * @throws {MailError}
   */
  async recent(limit = 10) {
    const channel = await this.#open();
    try {
      const selected = await this.#select(channel, this.mailbox, false);
      if (selected.status !== 'OK') {
        throw new PermanentMailError(`IMAP SELECT failed for ${this.mailbox}`, { detail: selected.text });
      }
      const search = await channel.run(['UID SEARCH ALL']);
      if (search.status !== 'OK') {
        throw new TransientMailError('IMAP SEARCH ALL failed', { detail: search.text });
      }
      const uids = parseSearchUids(search.lines).slice(-Math.max(1, limit));
      return await this.#fetchMany(channel, uids);
    } catch (error) {
      throw this.#translate(error, 'IMAP connection failed during fetch');
    } finally {
      await this.#logout(channel);
    }
  }

  // -- connection ----------------------------------------------------------

  /**
   * Open a channel that is connected, (optionally) secured and logged in.
   *
   * @returns {Promise<ImapChannel>}
   */
  async #open() {
    const socket = await this.#connectSocket();
    let channel = new ImapChannel(socket, { timeoutMs: this.timeoutMs, log: this.#logSink() });
    try {
      const greeting = await channel.readLine();
      if (!/^\*\s+(OK|PREAUTH)\b/i.test(greeting.text)) {
        throw new TransientMailError('unexpected IMAP greeting', { detail: greeting.text });
      }

      if (this.security === 'starttls') {
        const before = await this.#capability(channel);
        if (!before.has('STARTTLS')) {
          throw new PermanentMailError('IMAP server does not advertise STARTTLS');
        }
        const started = await channel.run(['STARTTLS']);
        if (started.status !== 'OK') {
          throw new TransientMailError('IMAP STARTTLS was refused', { detail: started.text });
        }
        channel.detach();
        const secured = await upgradeSocketToTls({
          socket,
          host: this.host,
          timeoutMs: this.timeoutMs,
          tlsOptions: this.tlsOptions,
          context: this.#context(),
        });
        channel = new ImapChannel(secured, { timeoutMs: this.timeoutMs, log: this.#logSink() });
        // Capabilities after STARTTLS differ from the plaintext advertisement.
        await this.#capability(channel);
      }

      if (!/PREAUTH/i.test(greeting.text)) {
        const login = await channel.run(['LOGIN ', imapString(this.username), ' ', imapString(this.password)]);
        if (login.status !== 'OK') {
          throw new AuthenticationFailed('IMAP authentication failed; check the authorization code', {
            detail: login.text,
          });
        }
      }
      return channel;
    } catch (error) {
      channel.detach();
      socket.destroy();
      throw error;
    }
  }

  /** @returns {string} `host:port`, used in error messages. */
  #context() {
    return `${this.host}:${this.port}`;
  }

  /**
   * @returns {Promise<import('node:net').Socket>}
   */
  async #connectSocket() {
    const context = this.#context();
    if (this.security === 'ssl') {
      return openTlsSocket({
        host: this.host,
        port: this.port,
        timeoutMs: this.timeoutMs,
        tlsOptions: this.tlsOptions,
        context,
      });
    }
    return openPlainSocket({ host: this.host, port: this.port, timeoutMs: this.timeoutMs, context });
  }

  /**
   * @param {ImapChannel} channel
   * @returns {Promise<Set<string>>} Upper-cased capability tokens.
   */
  async #capability(channel) {
    const response = await channel.run(['CAPABILITY']);
    const capabilities = new Set();
    for (const line of response.lines) {
      const match = /^\* CAPABILITY (.*)$/i.exec(line.text);
      if (!match) continue;
      for (const token of match[1].split(/\s+/)) capabilities.add(token.toUpperCase());
    }
    return capabilities;
  }

  /**
   * @param {ImapChannel} channel
   * @param {string} mailbox
   * @param {boolean} readonly
   * @returns {Promise<{ status: string, exists: number, text: string }>}
   */
  async #select(channel, mailbox, readonly) {
    // EXAMINE leaves the \Recent and \Seen flags untouched, which matters when
    // we only want a folder's message count.
    const response = await channel.run([`${readonly ? 'EXAMINE' : 'SELECT'} `, imapString(mailbox)]);
    return { status: response.status, exists: parseExists(response.lines), text: response.text };
  }

  /**
   * @param {ImapChannel} channel
   * @param {string[]} uids
   * @returns {Promise<ReturnType<typeof parseMessage>[]>}
   */
  async #fetchMany(channel, uids) {
    const messages = [];
    for (const uid of uids) {
      const raw = await this.#fetch(channel, uid);
      if (raw) messages.push(parseMessage(raw, { uid }));
    }
    return messages;
  }

  /**
   * @param {ImapChannel} channel
   * @param {string} uid
   * @returns {Promise<Buffer|null>} Raw RFC822 bytes, or `null` when unavailable.
   */
  async #fetch(channel, uid) {
    const response = await channel.run([`UID FETCH ${uid} (RFC822)`]);
    if (response.status !== 'OK') return null;
    for (const line of response.lines) {
      if (line.literals.length === 0) continue;
      // Locate the literal that belongs to RFC822/BODY[] by counting the `{n}`
      // markers that precede it in the response text.
      const marker = /(?:RFC822|BODY(?:\.PEEK)?\[\])\s*\{(\d+)\+?\}/i.exec(line.text);
      if (!marker) continue;
      const markersBefore = (line.text.slice(0, marker.index).match(/\{\d+\+?\}/g) ?? []).length;
      const literal = line.literals[markersBefore];
      if (literal) return literal;
    }
    return null;
  }

  /**
   * Say goodbye and drop the socket. Never throws: closing must not mask the
   * outcome of the operation that triggered it.
   *
   * @param {ImapChannel} channel
   */
  async #logout(channel) {
    try {
      await Promise.race([channel.run(['LOGOUT']), delay(LOGOUT_TIMEOUT_MS)]);
    } catch {
      // Best effort only.
    } finally {
      channel.detach();
      channel.socket.destroy();
    }
  }

  /**
   * Wrap transport-level surprises in the mail taxonomy while letting real
   * programming errors surface unchanged.
   *
   * @param {unknown} error
   * @param {string} message Fallback summary.
   * @returns {unknown}
   */
  #translate(error, message) {
    if (error instanceof MailError) return error;
    if (typeof error?.code === 'string' || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return new TransientMailError(message, { detail: String(error.message ?? error), cause: error });
    }
    return error;
  }

  /**
   * @returns {((direction: string, line: string) => void)|null}
   */
  #logSink() {
    return createLogSink({ logger: this.logger, debug: this.debug });
  }
}
