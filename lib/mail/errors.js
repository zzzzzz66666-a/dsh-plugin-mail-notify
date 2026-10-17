/**
 * Mail error taxonomy used to decide retry versus user-visible failure.
 *
 * Port of `codex_notify/adapters/mail/errors.py`.
 *
 * @module mail/errors
 */

/**
 * Base class for mail transport failures.
 *
 * The taxonomy is carried on the class itself (`MailError.category`) *and* on
 * every instance (`err.category`), so callers may narrow on either without
 * needing to instantiate an error first.
 */
export class MailError extends Error {
  /** @type {string} */
  static category = 'mail_error';

  /** @type {boolean} */
  static retryable = false;

  /**
   * @param {string} message Human readable summary safe to show to a user.
   * @param {{ detail?: string, cause?: unknown }} [options]
   *   `detail` carries the raw server or socket text that must not be lost;
   *   `cause` is the original error, preserved like `Error`'s own `cause`.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    /** @type {string|undefined} Raw server reply / socket error text. */
    this.detail = options.detail;
  }

  /** @returns {string} Stable machine readable failure category. */
  get category() {
    return /** @type {typeof MailError} */ (this.constructor).category;
  }

  /** @returns {boolean} True when retrying the same operation may succeed. */
  get retryable() {
    return /** @type {typeof MailError} */ (this.constructor).retryable;
  }
}

/** Network or server-side temporary failure; safe to retry later. */
export class TransientMailError extends MailError {
  static category = 'transient';
  static retryable = true;
}

/** Permanent server rejection; retrying will not help. */
export class PermanentMailError extends MailError {
  static category = 'permanent';
  static retryable = false;
}

/** Authorization code or login was rejected. */
export class AuthenticationFailed extends PermanentMailError {
  static category = 'authentication';
}

/** TLS negotiation failed. */
export class CertificateError extends PermanentMailError {
  static category = 'tls';
}
