/**
 * Plugin configuration: defaults, normalisation and validation.
 *
 * The configuration row lives in the profile's `cordis.patch.yml`. It holds
 * mail routing and behaviour only — never the authorization code, which is the
 * job of the secret store.
 *
 * @module dsh-plugin-mail-notify/config
 */

/** Raised when configuration is missing or invalid. */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const SECURITY_MODES = new Set(['ssl', 'starttls'])

/**
 * Shape of the configuration, with the QQ mailbox defaults the reference
 * component also ships: they are correct out of the box for most users here.
 */
export const DEFAULT_CONFIG = Object.freeze({
  senderEmail: '',
  recipientEmail: '',
  allowedReplyEmail: '',
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
  smtpSecurity: 'ssl',
  imapHost: 'imap.qq.com',
  imapPort: 993,
  imapSecurity: 'ssl',
  imapMailbox: 'INBOX',
  /** Queue tag; also the IMAP SUBJECT search token, so replies are found cheaply. */
  subjectPrefix: '[DSH]',
  notificationsEnabled: true,
  continuationEnabled: true,
  replyTokenTtlHours: 24,
  maxReplyLength: 8000,
  includeReplySummary: true,
  replySummaryMaxChars: 600,
  /** Upper bound on replies submitted per minute, as a runaway-mail guard. */
  maxRepliesPerMinute: 20,
  /** How often the IMAP side is polled, in milliseconds. */
  pollIntervalMs: 15000,
  /** Empty means "use the per-user default directory". */
  dataDir: '',
})

/** Fields a user may set, in the order they appear in documentation. */
export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG))

/**
 * Merge user configuration over the defaults.
 *
 * Unknown keys are dropped rather than rejected: a profile row written for a
 * newer version must not stop the plugin from loading.
 */
export function withDefaults(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULT_CONFIG }
  for (const key of CONFIG_KEYS) {
    if (source[key] !== undefined && source[key] !== null) merged[key] = source[key]
  }
  return merged
}

/** True when the three addresses are configured well enough to run. */
export function isConfigured(config) {
  return Boolean(
    config &&
      EMAIL.test(String(config.senderEmail)) &&
      EMAIL.test(String(config.recipientEmail)) &&
      EMAIL.test(String(config.allowedReplyEmail)),
  )
}

/**
 * Validate and normalise a configuration object.
 *
 * @returns {object} the normalised configuration.
 * @throws {ConfigError} when a field is out of range or malformed.
 */
export function validateConfig(raw = {}) {
  const config = withDefaults(raw)
  const requireEmail = (key, required) => {
    const value = String(config[key] ?? '').trim()
    if (!value) {
      if (required) throw new ConfigError(`invalid email: ${key}`)
      return
    }
    if (!EMAIL.test(value)) throw new ConfigError(`invalid email: ${key}`)
  }
  requireEmail('senderEmail', true)
  requireEmail('recipientEmail', true)
  requireEmail('allowedReplyEmail', true)

  for (const key of ['smtpPort', 'imapPort']) {
    const port = Number(config[key])
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`invalid port: ${key}`)
    config[key] = port
  }
  for (const key of ['smtpSecurity', 'imapSecurity']) {
    if (!SECURITY_MODES.has(config[key])) throw new ConfigError(`invalid security: ${key}`)
  }
  for (const key of ['smtpHost', 'imapHost', 'imapMailbox']) {
    if (!String(config[key] ?? '').trim()) throw new ConfigError(`mail host must not be empty: ${key}`)
    config[key] = String(config[key]).trim()
  }
  const prefix = String(config.subjectPrefix ?? '').trim()
  if (!prefix) throw new ConfigError('subjectPrefix must not be empty')
  if (prefix.length > 40) throw new ConfigError('subjectPrefix is too long')
  config.subjectPrefix = prefix

  const ttl = Number(config.replyTokenTtlHours)
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 24 * 30) throw new ConfigError('invalid reply token ttl')
  config.replyTokenTtlHours = ttl

  const maxLength = Number(config.maxReplyLength)
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 100000) {
    throw new ConfigError('invalid max reply length')
  }
  config.maxReplyLength = maxLength

  const summaryChars = Number(config.replySummaryMaxChars)
  if (!Number.isInteger(summaryChars) || summaryChars < 0 || summaryChars > 10000) {
    throw new ConfigError('invalid reply summary length')
  }
  config.replySummaryMaxChars = summaryChars

  const rate = Number(config.maxRepliesPerMinute)
  if (!Number.isInteger(rate) || rate < 1 || rate > 600) throw new ConfigError('invalid reply rate limit')
  config.maxRepliesPerMinute = rate

  const interval = Number(config.pollIntervalMs)
  if (!Number.isInteger(interval) || interval < 5000 || interval > 3600000) {
    throw new ConfigError('invalid poll interval')
  }
  config.pollIntervalMs = interval

  for (const key of ['notificationsEnabled', 'continuationEnabled', 'includeReplySummary']) {
    config[key] = Boolean(config[key])
  }
  config.dataDir = String(config.dataDir ?? '').trim()
  return config
}

/** Public view of a configuration, safe to log: it has no credential field at all. */
export function publicConfig(config) {
  const view = {}
  for (const key of CONFIG_KEYS) if (key !== 'dataDir') view[key] = config[key]
  return view
}
