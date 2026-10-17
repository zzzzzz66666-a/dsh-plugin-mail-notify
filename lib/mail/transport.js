/**
 * Shared socket plumbing for the SMTP and IMAP transports.
 *
 * Internal module: it exists so both clients map TLS/connect failures to the
 * same typed errors and apply the same timeouts. It is not part of the public
 * plugin interface.
 *
 * @module mail/transport
 */

import net from 'node:net';
import tls from 'node:tls';

import { CertificateError, TransientMailError } from './errors.js';

/**
 * TLS/certificate error codes that mean "the handshake or trust check failed",
 * as opposed to a plain transport failure.
 * @type {Set<string>}
 */
export const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
]);

/**
 * Decide whether a socket error belongs to TLS negotiation or to the network.
 *
 * @param {NodeJS.ErrnoException|undefined} error
 * @returns {boolean}
 */
export function isTlsError(error) {
  const code = String(error?.code ?? '');
  if (TLS_ERROR_CODES.has(code)) return true;
  if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) return true;
  // Node surfaces some OpenSSL failures with only a message.
  return /certificate|self[ -]signed|handshake|ssl|tls/i.test(String(error?.message ?? ''));
}

/**
 * Map a low-level socket error onto the mail taxonomy.
 *
 * @param {unknown} error
 * @param {string} context Human readable target, e.g. `smtp.example.com:465`.
 * @returns {import('./errors.js').MailError}
 */
export function mapSocketError(error, context) {
  const detail = String(error?.message ?? error);
  if (isTlsError(error)) {
    return new CertificateError(`TLS negotiation with ${context} failed`, { detail, cause: error });
  }
  if (error?.code === 'ETIMEDOUT') {
    return new TransientMailError(`connection to ${context} timed out`, { detail, cause: error });
  }
  return new TransientMailError(`connection to ${context} failed`, { detail, cause: error });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => {
    // An unref'd timer can never keep the process alive on its own.
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Build the optional protocol trace sink.
 *
 * Nothing is emitted unless a logger is injected or `debug` is on; library code
 * never writes to stdout.
 *
 * @param {{ logger?: Function|{debug?: Function}|null, debug?: boolean }} options
 * @returns {((direction: string, line: string) => void)|null}
 */
export function createLogSink({ logger = null, debug = false } = {}) {
  if (logger) {
    if (typeof logger === 'function') return (direction, line) => logger(direction, line);
    if (typeof logger.debug === 'function') return (direction, line) => logger.debug(`${direction} ${line}`);
  }
  if (!debug) return null;
  return (direction, line) => process.stderr.write(`${direction} ${line}\n`);
}

/**
 * Wait for a socket to reach `event`, rejecting with a typed error otherwise.
 *
 * @param {import('node:net').Socket} socket
 * @param {'connect'|'secureConnect'} event
 * @param {{ timeoutMs: number, context: string }} options
 * @returns {Promise<import('node:net').Socket>}
 */
export function awaitConnected(socket, event, { timeoutMs, context }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(new TransientMailError(`connection to ${context} timed out`, { detail: `no connection within ${timeoutMs} ms` }));
      });
    }, timeoutMs);
    timer.unref?.();

    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('close', onClose);
      action();
    }

    function onError(error) {
      finish(() => reject(mapSocketError(error, context)));
    }

    function onClose() {
      finish(() => reject(new TransientMailError(`cannot connect to ${context}`, { detail: 'socket closed during connect' })));
    }

    socket.once(event, () => finish(() => resolve(socket)));
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

/**
 * The SNI name to offer for `host`.
 *
 * RFC 6066 forbids an IP literal in SNI, and Node deprecates passing one, so
 * an address is offered without a servername — the certificate is still
 * verified against `host`.
 *
 * @param {string} host
 * @returns {string|undefined}
 */
function sniName(host) {
  const text = String(host ?? '').trim();
  if (text === '') return undefined;
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare);
  const isIpv6 = bare.includes(':');
  return isIpv4 || isIpv6 ? undefined : bare;
}

/**
 * Open a plain TCP connection.
 *
 * @param {{ host: string, port: number, timeoutMs: number, context: string }} options
 * @returns {Promise<import('node:net').Socket>}
 */
export function openPlainSocket({ host, port, timeoutMs, context }) {
  const socket = net.connect({ host, port });
  return awaitConnected(socket, 'connect', { timeoutMs, context });
}

/**
 * Open a connection that is TLS from the first byte.
 *
 * @param {{ host: string, port: number, timeoutMs: number, tlsOptions?: object, context: string }} options
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
export function openTlsSocket({ host, port, timeoutMs, tlsOptions = {}, context }) {
  const socket = tls.connect({
    host,
    port,
    servername: tlsOptions.servername ?? sniName(host),
    ...tlsOptions,
  });
  return awaitConnected(socket, 'secureConnect', { timeoutMs, context });
}

/**
 * Upgrade an established plain connection in place (SMTP STARTTLS, IMAP STARTTLS).
 *
 * The caller must detach its own listeners from `socket` first: the wrapped
 * `TLSSocket` owns the stream from here on.
 *
 * @param {{ socket: import('node:net').Socket, host: string, timeoutMs: number, tlsOptions?: object, context: string }} options
 * @returns {Promise<import('node:tls').TLSSocket>}
 */
export function upgradeSocketToTls({ socket, host, timeoutMs, tlsOptions = {}, context }) {
  const secured = tls.connect({
    ...tlsOptions,
    socket,
    servername: tlsOptions.servername ?? sniName(host),
  });
  return awaitConnected(secured, 'secureConnect', { timeoutMs, context });
}
