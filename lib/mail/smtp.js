/**
 * Minimal, dependency-free SMTP client (RFC 5321 + RFC 4954 AUTH) with an
 * explicit error taxonomy.
 *
 * Port of `codex_notify/adapters/mail/smtp_sender.py`, which leaned on
 * `smtplib`; the protocol steps are reproduced here on top of `node:net` and
 * `node:tls` so the package keeps zero runtime dependencies.
 *
 * @module mail/smtp
 */

import os from 'node:os';

import {
  AuthenticationFailed,
  MailError,
  PermanentMailError,
  TransientMailError,
} from './errors.js';
import { buildMessage } from './mime.js';
import {
  createLogSink,
  delay,
  mapSocketError,
  openPlainSocket,
  openTlsSocket,
  upgradeSocketToTls,
} from './transport.js';

/** Default ports per RFC 8314 / common provider practice. */
const DEFAULT_PORTS = { ssl: 465, starttls: 587 };

/** How long the best-effort QUIT is allowed to take before hanging up. */
const QUIT_TIMEOUT_MS = 1000;

/**
 * Turn a completed SMTP reply into the matching typed error.
 *
 * @param {{ code: number, text: string }} response
 * @param {{ phase?: string, permanentMessage?: string }} [options]
 * @returns {MailError}
 */
function classifyResponse(response, options = {}) {
  const { phase = 'command', permanentMessage } = options;
  const detail = response.text;
  if (response.code >= 400 && response.code < 500) {
    return new TransientMailError(`SMTP temporary failure ${response.code}`, { detail });
  }
  if (phase === 'auth') {
    return new AuthenticationFailed('SMTP authentication failed; check the authorization code', { detail });
  }
  if (response.code >= 500) {
    return new PermanentMailError(permanentMessage ?? `SMTP permanent failure ${response.code}`, { detail });
  }
  return new PermanentMailError(`unexpected SMTP response ${response.code}`, { detail });
}

/**
 * @param {string} header Raw header value, e.g. `"DSH" <a@b.com>`.
 * @returns {string} The bare address used for the SMTP envelope.
 */
function envelopeAddress(header) {
  const text = String(header ?? '');
  const angled = /<([^>]*)>/.exec(text);
  return (angled ? angled[1] : text).trim();
}

/**
 * Read a header out of a built message, unfolding continuation lines.
 *
 * @param {string} message
 * @param {string} name
 * @returns {string}
 */
function headerValue(message, name) {
  const headerBlock = message.split(/\r\n\r\n|\n\n/, 1)[0] ?? '';
  // Unfold only genuine continuation lines: a line break followed by
  // whitespace. Matching a bare `\r` here would join every header onto one
  // line and make the lookup below fail for all but the first header.
  const unfolded = headerBlock.replace(/\r\n[ \t]+|\n[ \t]+|\r[ \t]+/g, ' ');
  const match = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(unfolded);
  return match ? match[1].trim() : '';
}

/**
 * A single SMTP conversation: line framing, reply parsing and writes.
 *
 * Replies are queued rather than awaited one-by-one, so a greeting that lands
 * before the first read is never lost.
 */
class SmtpChannel {
  /** @param {import('node:net').Socket} socket */
  constructor(socket, { timeoutMs = 30_000, log = null } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.buffer = Buffer.alloc(0);
    this.current = [];
    this.responses = [];
    this.waiters = [];
    this.failure = null;

    this.onData = (chunk) => this.#handleData(chunk);
    this.onError = (error) => this.#fail(mapSocketError(error, 'SMTP server'));
    this.onClose = () => this.#fail(new TransientMailError('SMTP connection closed unexpectedly'));
    this.onEnd = () => this.#fail(new TransientMailError('SMTP connection closed unexpectedly'));

    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
    socket.on('end', this.onEnd);
  }

  /**
   * Stop watching the socket; used before a STARTTLS upgrade hands the raw
   * socket over to `tls.connect`.
   */
  detach() {
    this.detached = true;
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
   * @returns {Promise<{ code: number, lines: string[], text: string }>}
   */
  async readResponse() {
    if (this.responses.length > 0) return this.responses.shift();
    if (this.failure) throw this.failure;

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.fail(new TransientMailError('SMTP operation timed out', { detail: `no reply within ${this.timeoutMs} ms` }));
        this.socket.destroy();
      }, this.timeoutMs);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /** @param {MailError} error */
  fail(error) {
    this.#fail(error);
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
    let newline = this.buffer.indexOf(0x0a);
    while (newline !== -1) {
      let line = this.buffer.subarray(0, newline).toString('latin1');
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.#handleLine(line);
      newline = this.buffer.indexOf(0x0a);
    }
  }

  /** @param {string} line */
  #handleLine(line) {
    this.log?.('S', line);
    this.current.push(line);
    // `250-text` continues the reply, anything else terminates it. Treating an
    // unrecognisable line as final keeps a malformed server from hanging us.
    if (/^\d{3}-/.test(line)) return;

    const lines = this.current;
    this.current = [];
    const match = /^(\d{3})/.exec(lines[0] ?? '');
    const response = {
      code: match ? Number(match[1]) : 0,
      lines,
      text: lines.join('\r\n'),
    };
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(response);
    } else {
      this.responses.push(response);
    }
  }
}

/**
 * Send notification mail through an SMTP server (implicit TLS or STARTTLS).
 */
export class SmtpMailSender {
  /**
   * @param {object} options
   * @param {string} options.host Server hostname.
   * @param {number} [options.port] Defaults to 465 for `ssl`, 587 for `starttls`.
   * @param {'ssl'|'starttls'} options.security Transport security mode.
   * @param {string} options.username Account / authorization code user.
   * @param {string} options.password Account / authorization code.
   * @param {number} [options.timeoutMs=30000] Idle timeout for connect and each reply.
   * @param {string} [options.senderName='DSH Mail Notify'] Retained for API parity
   *   with the Python adapter, which also never placed it in the `From` header;
   *   the raw sender address is used so replies route back to the mailbox.
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
    timeoutMs = 30_000,
    senderName = 'DSH Mail Notify',
    tlsOptions = {},
    debug = false,
    logger = null,
  } = {}) {
    if (security !== 'ssl' && security !== 'starttls') {
      throw new MailError(`unsupported smtp security: ${security}`);
    }
    if (!host) throw new MailError('smtp host is required');
    this.host = host;
    this.port = port ?? DEFAULT_PORTS[security];
    this.security = security;
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.senderName = senderName;
    this.tlsOptions = tlsOptions ?? {};
    this.debug = debug;
    this.logger = logger;
    this.clientName = (os.hostname() || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  }

  /**
   * Connect, authenticate, send one message and disconnect.
   *
   * @param {object} message
   * @param {string} message.sender `From` header value.
   * @param {string} message.to `To` header value.
   * @param {string} message.subject
   * @param {string} message.body
   * @param {string} [message.messageId]
   * @param {string} [message.kind]
   * @returns {Promise<string>} The Message-ID that was sent.
   * @throws {MailError} Typed failure; see the message taxonomy in `errors.js`.
   */
  async send({ sender, to, subject, body, messageId, kind } = {}) {
    if (!sender || !to) throw new MailError('both sender and recipient are required');
    const message = buildMessage({ sender, to, subject, body, messageId, kind });
    const resolvedId = headerValue(message, 'Message-ID');
    const channel = await this.#open();

    try {
      await this.#expect(channel, `MAIL FROM:<${envelopeAddress(sender)}>`, {
        phase: 'mail',
        accept: (code) => code >= 200 && code < 300,
        permanentMessage: 'SMTP server refused the sender',
      });
      await this.#expect(channel, `RCPT TO:<${envelopeAddress(to)}>`, {
        phase: 'rcpt',
        accept: (code) => code >= 200 && code < 300,
        permanentMessage: 'SMTP server refused the recipient',
      });
      await this.#expect(channel, 'DATA', { phase: 'data', accept: (code) => code === 354 });
      await this.#expect(channel, `${dotStuff(message)}.`, {
        phase: 'data',
        accept: (code) => code >= 200 && code < 300,
      });
      return resolvedId;
    } finally {
      await this.#close(channel);
    }
  }

  /**
   * Connect and authenticate without sending anything; used by setup checks.
   *
   * @returns {Promise<void>}
   * @throws {MailError}
   */
  async test() {
    const channel = await this.#open();
    try {
      await this.#expect(channel, 'NOOP', { phase: 'noop', accept: (code) => code >= 200 && code < 300 });
    } finally {
      await this.#close(channel);
    }
  }

  // -- connection ----------------------------------------------------------

  /**
   * Open a channel and leave it authenticated.
   *
   * @returns {Promise<SmtpChannel>}
   */
  async #open() {
    const socket = await this.#connectSocket();
    let channel = new SmtpChannel(socket, { timeoutMs: this.timeoutMs, log: this.#logSink() });
    try {
      const greeting = await channel.readResponse();
      if (greeting.code !== 220) throw classifyResponse(greeting, { phase: 'greeting' });

      if (this.security === 'starttls') {
        const capabilities = await this.#ehlo(channel);
        if (!capabilities.has('STARTTLS')) {
          throw new PermanentMailError('SMTP server does not advertise STARTTLS');
        }
        await this.#expect(channel, 'STARTTLS', { phase: 'starttls', accept: (code) => code === 220 });
        // Hand the raw socket to TLS: our own listeners must be gone first.
        channel.detach();
        const secured = await upgradeSocketToTls({
          socket,
          host: this.host,
          timeoutMs: this.timeoutMs,
          tlsOptions: this.tlsOptions,
          context: this.#context(),
        });
        channel = new SmtpChannel(secured, { timeoutMs: this.timeoutMs, log: this.#logSink() });
      }

      await this.#authenticate(channel);
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
   * Issue EHLO, falling back to HELO when a server rejects the extended form,
   * and return the advertised keywords.
   *
   * @param {SmtpChannel} channel
   * @returns {Promise<Set<string>>}
   */
  async #ehlo(channel) {
    const response = await this.#command(channel, `EHLO ${this.clientName}`);
    if (response.code >= 200 && response.code < 300) {
      const capabilities = new Set();
      for (const line of response.lines.slice(1)) {
        const value = line.slice(4).trim();
        // `AUTH LOGIN PLAIN` and Exchange's `AUTH=LOGIN PLAIN` are both valid.
        const auth = /^AUTH[= ](.*)$/i.exec(value);
        if (auth) {
          capabilities.add('AUTH');
          for (const mechanism of auth[1].split(/\s+/)) capabilities.add(mechanism.toUpperCase());
        } else {
          capabilities.add(value.split(/\s+/)[0].toUpperCase());
        }
      }
      return capabilities;
    }
    if (response.code >= 500) {
      // RFC 5321 requires a client to retry with HELO when EHLO is rejected.
      await this.#expect(channel, `HELO ${this.clientName}`, { phase: 'helo', accept: (code) => code >= 200 && code < 300 });
      return new Set();
    }
    throw classifyResponse(response, { phase: 'ehlo' });
  }

  /**
   * @param {SmtpChannel} channel
   */
  async #authenticate(channel) {
    const capabilities = await this.#ehlo(channel);
    // LOGIN is the priority; PLAIN is used when the server does not offer it.
    const useLogin = capabilities.size === 0 || capabilities.has('LOGIN') || !capabilities.has('PLAIN');

    if (useLogin) {
      await this.#expect(channel, 'AUTH LOGIN', { phase: 'auth', accept: (code) => code === 334 });
      await this.#expect(channel, Buffer.from(String(this.username ?? ''), 'utf8').toString('base64'), {
        phase: 'auth',
        accept: (code) => code === 334,
      });
      await this.#expect(channel, Buffer.from(String(this.password ?? ''), 'utf8').toString('base64'), {
        phase: 'auth',
        accept: (code) => code >= 200 && code < 300,
      });
      return;
    }

    const payload = Buffer.from(`\u0000${this.username ?? ''}\u0000${this.password ?? ''}`, 'utf8').toString('base64');
    const response = await this.#expect(channel, `AUTH PLAIN ${payload}`, {
      phase: 'auth',
      accept: (code) => code === 334 || (code >= 200 && code < 300),
    });
    if (response.code === 334) {
      // Server discarded the initial response and wants it as a second step.
      await this.#expect(channel, payload, { phase: 'auth', accept: (code) => code >= 200 && code < 300 });
    }
  }

  // -- command helpers -----------------------------------------------------

  /**
   * @param {SmtpChannel} channel
   * @param {string} command
   * @returns {Promise<{ code: number, lines: string[], text: string }>}
   */
  async #command(channel, command) {
    channel.write(`${command}\r\n`);
    return channel.readResponse();
  }

  /**
   * Send a command and fail with a typed error unless the reply is acceptable.
   *
   * @param {SmtpChannel} channel
   * @param {string} command
   * @param {{ phase: string, accept: (code: number) => boolean, permanentMessage?: string }} options
   * @returns {Promise<{ code: number, lines: string[], text: string }>}
   */
  async #expect(channel, command, { phase, accept, permanentMessage }) {
    const response = await this.#command(channel, command);
    if (!accept(response.code)) throw classifyResponse(response, { phase, permanentMessage });
    return response;
  }

  /**
   * Say goodbye and drop the socket. Never throws: closing must not mask the
   * outcome of the operation that triggered it.
   *
   * @param {SmtpChannel} channel
   */
  async #close(channel) {
    try {
      channel.write('QUIT\r\n');
      await Promise.race([channel.readResponse(), delay(QUIT_TIMEOUT_MS)]);
    } catch {
      // Best effort only.
    } finally {
      channel.detach();
      channel.socket.destroy();
    }
  }

  /**
   * @returns {((direction: string, line: string) => void)|null}
   */
  #logSink() {
    return createLogSink({ logger: this.logger, debug: this.debug });
  }
}

/**
 * Escape a message for the DATA phase: CRLF line endings and a doubled leading
 * dot on every line (RFC 5321 §4.5.2), terminated by the caller.
 *
 * @param {string} message
 * @returns {string}
 */
function dotStuff(message) {
  const normalized = String(message ?? '').replace(/\r\n|\r|\n/g, '\r\n');
  const stuffed = normalized
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
  return stuffed.endsWith('\r\n') ? stuffed : `${stuffed}\r\n`;
}
