/**
 * RFC 5322 message building/parsing plus the reply-body helpers used by the
 * notification pipeline.
 *
 * Port of `codex_notify/adapters/mail/smtp_sender.py` (`build_message`) and
 * `codex_notify/adapters/mail/imap_receiver.py` (`parse_message`,
 * `decode_header`, `strip_quoted_history`) plus `_HtmlTextExtractor` from
 * `codex_notify/replies.py`.
 *
 * The parser is deliberately defensive: every entry point tolerates hostile or
 * truncated input and degrades to best-effort values instead of throwing,
 * because a single malformed message must never break a mailbox poll.
 *
 * @module mail/mime
 */

import { randomBytes } from 'node:crypto';

/**
 * Marks plugin-generated mail so the receiver can tell its own notifications
 * apart from a human reply. Required when sender and recipient are the same
 * mailbox, which is the normal single-address setup.
 *
 * @type {string}
 */
export const NOTIFICATION_HEADER = 'X-Agent-Mail-Notify';

/**
 * Domain used by the Message-IDs this plugin generates.
 *
 * A second, header-independent way to recognise our own mail coming back
 * through the mailbox. The header is the primary marker, but a provider that
 * rewrites or drops unknown `X-` headers would otherwise leave a notification
 * looking exactly like a reply — it quotes a task id and a live one-time code,
 * so it would be accepted and fed back into the session.
 */
export const NOTIFICATION_MESSAGE_ID_DOMAIN = '@dsh-mail-notify';

/** Address used in generated Message-IDs; not required to be routable. */
const MESSAGE_ID_DOMAIN = 'dsh-mail-notify';

/** Maximum encoded-word payload in bytes: 45 bytes -> 60 base64 chars -> 72 with wrappers. */
const ENCODED_WORD_BYTES = 45;

/** Longest header line we emit before folding. */
const HEADER_LINE_LIMIT = 78;

/** Guard against pathological/deeply nested multipart bombs. */
const MAX_MIME_DEPTH = 20;

// ---------------------------------------------------------------------------
// Header encoding
// ---------------------------------------------------------------------------

/**
 * Remove CR/LF from a header value so attacker-controlled text (subject, address)
 * cannot inject extra headers into the message we hand to the server.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeHeaderValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ');
}

/**
 * Format a date as an RFC 5322 `date-time` in local time with the numeric zone,
 * matching Python's `email.utils.formatdate(localtime=True)`.
 *
 * @param {Date} date
 * @returns {string} e.g. `Wed, 01 Jan 2025 12:34:56 +0800`
 */
function formatDate(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return (
    `${days[date.getDay()]}, ${pad(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
  );
}

/**
 * Fold a header into lines of at most 78 characters at whitespace boundaries.
 *
 * Encoded words are never split: they are single tokens here, and RFC 2047
 * permits folding only *between* them.
 *
 * @param {string} name Header field name.
 * @param {string} value Sanitized header value.
 * @returns {string} One or more CRLF-separated lines, the first prefixed by `name:`.
 */
function foldHeader(name, value) {
  const tokens = String(value).split(' ');
  const lines = [];
  let current = `${name}:`;
  for (const token of tokens) {
    const candidate = `${current} ${token}`;
    if (candidate.length > HEADER_LINE_LIMIT && current.length > name.length + 1) {
      lines.push(current);
      current = ` ${token}`;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines.join('\r\n');
}

/**
 * Split UTF-8 text into chunks that each hold whole characters, so every
 * RFC 2047 encoded word decodes on its own.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {Buffer[]}
 */
function chunkUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  const chunks = [];
  let start = 0;
  while (start < buffer.length) {
    let end = Math.min(start + maxBytes, buffer.length);
    // Back off to a character boundary so a multi-byte sequence is never cut in half.
    while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
    if (end === start) end = Math.min(start + maxBytes, buffer.length);
    chunks.push(buffer.subarray(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Encode a header value for transport: ASCII passes through, anything else
 * becomes one or more RFC 2047 `B` encoded words.
 *
 * @param {unknown} value
 * @returns {string}
 */
function encodeHeaderValue(value) {
  const text = sanitizeHeaderValue(value);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return chunkUtf8(text, ENCODED_WORD_BYTES)
    .map((chunk) => `=?UTF-8?B?${chunk.toString('base64')}?=`)
    .join(' ');
}

/**
 * Build an RFC 5322 message ready to hand to `DATA`.
 *
 * Headers are emitted in a fixed order and the body is always UTF-8 base64, so
 * any Unicode payload survives 7-bit-clean transports and dot-stuffing.
 *
 * @param {object} message
 * @param {string} message.sender `From` address, e.g. `alerts@example.com`.
 * @param {string} message.to `To` address.
 * @param {string} message.subject Subject; non-ASCII is RFC 2047 encoded.
 * @param {string} message.body Plain text body (UTF-8).
 * @param {string} [message.messageId] Pre-built Message-ID, `<...>` included.
 * @param {string} [message.kind='notification'] Value of {@link NOTIFICATION_HEADER}.
 * @param {Date} [message.date] Message date; defaults to now.
 * @returns {string} Message with CRLF line endings.
 */
export function buildMessage({ sender, to, subject, body, messageId, kind = 'notification', date = new Date() } = {}) {
  const resolvedDate = date instanceof Date ? date : new Date(date);
  const effectiveDate = Number.isNaN(resolvedDate.getTime()) ? new Date() : resolvedDate;
  const resolvedId = messageId ? String(messageId) : `<${randomBytes(16).toString('hex')}@${MESSAGE_ID_DOMAIN}>`;

  const headers = [
    foldHeader('From', sanitizeHeaderValue(sender)),
    foldHeader('To', sanitizeHeaderValue(to)),
    foldHeader('Subject', encodeHeaderValue(subject)),
    foldHeader('Date', formatDate(effectiveDate)),
    foldHeader('Message-ID', sanitizeHeaderValue(resolvedId)),
    foldHeader(NOTIFICATION_HEADER, sanitizeHeaderValue(kind)),
    foldHeader('MIME-Version', '1.0'),
    foldHeader('Content-Type', 'text/plain; charset=utf-8'),
    foldHeader('Content-Transfer-Encoding', 'base64'),
  ];

  const encodedBody = wrapBase64(Buffer.from(String(body ?? ''), 'utf8'));
  return `${headers.join('\r\n')}\r\n\r\n${encodedBody}\r\n`;
}

/**
 * Wrap base64 into lines of 76 characters as required by RFC 2045.
 *
 * @param {Buffer} buffer
 * @returns {string} CRLF separated base64 lines.
 */
function wrapBase64(buffer) {
  const encoded = buffer.toString('base64');
  const lines = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Charset / transfer-encoding decoding
// ---------------------------------------------------------------------------

/** Charsets decoded straight from bytes, where `TextDecoder` would remap them. */
const DIRECT_CHARSETS = new Map([
  ['iso-8859-1', 'latin1'],
  ['iso8859-1', 'latin1'],
  ['iso_8859-1', 'latin1'],
  ['latin1', 'latin1'],
  ['latin-1', 'latin1'],
  ['l1', 'latin1'],
  ['us-ascii', 'ascii'],
  ['ascii', 'ascii'],
  ['ansi_x3.4-1968', 'ascii'],
  ['cp819', 'latin1'],
]);

/** WHATWG label aliases `TextDecoder` does not accept verbatim. */
const CHARSET_ALIASES = new Map([
  ['utf8', 'utf-8'],
  ['utf-8', 'utf-8'],
  ['gb2312', 'gbk'],
  ['gb_2312', 'gbk'],
  ['gb_2312-80', 'gbk'],
  ['chinese', 'gbk'],
  ['csgb2312', 'gbk'],
  ['x-gbk', 'gbk'],
  ['gb18030', 'gb18030'],
  ['big5', 'big5'],
  ['big-5', 'big5'],
  ['cn-big5', 'big5'],
  ['cp936', 'gbk'],
  ['ms936', 'gbk'],
  ['windows-1252', 'windows-1252'],
  ['cp1252', 'windows-1252'],
  ['koi8-r', 'koi8-r'],
  ['shift_jis', 'shift_jis'],
  ['shift-jis', 'shift_jis'],
  ['sjis', 'shift_jis'],
  ['euc-jp', 'euc-jp'],
  ['euc-kr', 'euc-kr'],
  ['iso-2022-jp', 'iso-2022-jp'],
]);

/** Pre-built decoders; `TextDecoder` construction validates the label each time. */
const decoderCache = new Map();

/**
 * Decode bytes with an explicit charset, mirroring Python's
 * `payload.decode(charset, errors="replace")` with a UTF-8 fallback.
 *
 * @param {Buffer} buffer
 * @param {string} [charset]
 * @returns {string}
 */
function decodeCharset(buffer, charset) {
  const raw = String(charset ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
  const direct = DIRECT_CHARSETS.get(raw);
  if (direct === 'latin1') return buffer.toString('latin1');
  if (direct === 'ascii') return decodeAscii(buffer);

  const label = CHARSET_ALIASES.get(raw) ?? raw ?? '';
  if (label === 'utf-8' || label === '') return buffer.toString('utf8');
  try {
    let decoder = decoderCache.get(label);
    if (!decoder) {
      decoder = new TextDecoder(label, { fatal: false, ignoreBOM: false });
      decoderCache.set(label, decoder);
    }
    return decoder.decode(buffer);
  } catch {
    // Unknown label: same fallback Python uses when the codec lookup fails.
    return buffer.toString('utf8');
  }
}

/**
 * Decode as US-ASCII with U+FFFD for every byte above 0x7f, matching Python's
 * `errors="replace"` (which does not silently widen to Latin-1).
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeAscii(buffer) {
  let out = '';
  for (const byte of buffer) {
    out += byte < 0x80 ? String.fromCharCode(byte) : '\uFFFD';
  }
  return out;
}

/**
 * Decode quoted-printable content into raw bytes.
 *
 * Malformed escapes are kept literally so partial corruption never eats data.
 *
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
function decodeQuotedPrintable(buffer) {
  const out = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte !== 0x3d /* = */) {
      out.push(byte);
      continue;
    }
    const next = buffer[index + 1];
    const after = buffer[index + 2];
    if (next === 0x0d && after === 0x0a) {
      index += 2; // soft line break
      continue;
    }
    if (next === 0x0a) {
      index += 1; // soft line break with bare LF
      continue;
    }
    const high = hexDigit(next);
    const low = hexDigit(after);
    if (high >= 0 && low >= 0) {
      out.push(high * 16 + low);
      index += 2;
      continue;
    }
    out.push(byte);
  }
  return Buffer.from(out);
}

/**
 * @param {number|undefined} byte
 * @returns {number} 0-15 for hex digits, -1 otherwise.
 */
function hexDigit(byte) {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

/**
 * Apply a Content-Transfer-Encoding to a raw part body.
 *
 * @param {Buffer} body
 * @param {string} encoding
 * @returns {Buffer}
 */
function decodeContent(body, encoding) {
  const normalized = String(encoding ?? '').split(';')[0].trim().toLowerCase();
  if (normalized === 'base64') {
    // Node's base64 decoder ignores whitespace and unknown characters, which is
    // exactly the leniency real mail needs.
    return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (normalized === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

// ---------------------------------------------------------------------------
// Header value parsing
// ---------------------------------------------------------------------------

/**
 * Split a structured header into its main value and `;`-separated parameters,
 * honouring quoted strings.
 *
 * @param {string} text
 * @returns {string[]} `[mainValue, ...parameterSegments]`
 */
function splitParameters(text) {
  const segments = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && inQuotes && index + 1 < text.length) {
      current += char + text[index + 1];
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === ';' && !inQuotes) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/**
 * Strip one layer of quoting and backslash escapes from a parameter value.
 *
 * @param {string} text
 * @returns {string}
 */
function unquoteParameter(text) {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return trimmed;
}

/**
 * Percent-decode an RFC 2231 value into bytes. Non-escaped characters are
 * assumed to be ASCII and are copied verbatim.
 *
 * @param {string} text
 * @returns {Buffer}
 */
function percentDecodeToBuffer(text) {
  const out = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '%' && index + 2 < text.length) {
      const high = hexDigit(text.charCodeAt(index + 1));
      const low = hexDigit(text.charCodeAt(index + 2));
      if (high >= 0 && low >= 0) {
        out.push(high * 16 + low);
        index += 2;
        continue;
      }
    }
    const code = text.charCodeAt(index);
    out.push(code > 0xff ? 0x3f : code);
  }
  return Buffer.from(out);
}

/**
 * Decode one (possibly RFC 2231 extended) parameter value.
 *
 * @param {string} text Raw value, already unquoted.
 * @param {boolean} extended True when the parameter name ended with `*`.
 * @returns {string}
 */
function decodeParameterValue(text, extended) {
  if (!extended) return text;
  const match = /^([^']*)'([^']*)'(.*)$/s.exec(text);
  const charset = match ? match[1] || 'utf-8' : 'utf-8';
  const payload = match ? match[3] : text;
  return decodeCharset(percentDecodeToBuffer(payload), charset);
}

/**
 * Build the parameter map of a structured header, including RFC 2231
 * continuations (`name*0*=`, `name*1=`) which real clients still emit.
 *
 * @param {string[]} segments Parameter segments from {@link splitParameters}.
 * @returns {Map<string, string>} Lower-cased parameter name to decoded value.
 */
function buildParameterMap(segments) {
  const params = new Map();
  /** @type {Map<string, {text: string, extended: boolean}[]>} */
  const sections = new Map();

  for (const segment of segments) {
    const equals = segment.indexOf('=');
    if (equals <= 0) continue;
    const parsed = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(segment.slice(0, equals).trim().toLowerCase());
    if (!parsed) continue;
    const base = parsed[1];
    const section = parsed[2] === undefined ? null : Number(parsed[2]);
    const extended = parsed[3] === '*';
    const value = unquoteParameter(segment.slice(equals + 1));

    if (section === null) {
      params.set(base, decodeParameterValue(value, extended));
      continue;
    }
    const list = sections.get(base) ?? [];
    list.push({ section, text: value, extended });
    sections.set(base, list);
  }

  for (const [base, list] of sections) {
    list.sort((left, right) => left.section - right.section);
    // RFC 2231 allows a per-segment `*`, but the charset prefix only appears on
    // the first one; decode the joined value so percent escapes survive the join.
    const joined = list.map((entry) => entry.text).join('');
    params.set(base, decodeParameterValue(joined, list.some((entry) => entry.extended)));
  }
  return params;
}

/**
 * Parse `Content-Type` into its type and parameters, defaulting per RFC 2045.
 *
 * @param {string} value
 * @returns {{ type: string, maintype: string, subtype: string, parameters: Map<string, string> }}
 */
function parseContentType(value) {
  const [main = '', ...segments] = splitParameters(String(value ?? ''));
  const type = main.trim().toLowerCase() || 'text/plain';
  const slash = type.indexOf('/');
  return {
    type,
    maintype: slash === -1 ? type : type.slice(0, slash),
    subtype: slash === -1 ? '' : type.slice(slash + 1),
    parameters: buildParameterMap(segments),
  };
}

/**
 * Parse `Content-Disposition`.
 *
 * @param {string} value
 * @returns {{ raw: string, type: string, attachment: boolean, parameters: Map<string, string> }}
 */
function parseContentDisposition(value) {
  const raw = String(value ?? '');
  const [main = '', ...segments] = splitParameters(raw);
  return {
    raw,
    type: main.trim().toLowerCase(),
    // Python tests `"attachment" in disposition.lower()`; keep that leniency so
    // odd casing or trailing comments still count as an attachment.
    attachment: raw.toLowerCase().includes('attachment'),
    parameters: buildParameterMap(segments),
  };
}

/**
 * Split a MIME entity into its header block and body.
 *
 * @param {Buffer} buffer
 * @returns {{ headerBlock: Buffer, body: Buffer }}
 */
function splitHeaderBody(buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { headerBlock: buffer.subarray(0, crlf), body: buffer.subarray(crlf + 4) };
  }
  if (lf !== -1) {
    return { headerBlock: buffer.subarray(0, lf), body: buffer.subarray(lf + 2) };
  }
  return { headerBlock: buffer, body: Buffer.alloc(0) };
}

/**
 * Parse a header block into a case-insensitive multimap, unfolding continuation
 * lines by dropping the line break and keeping the leading whitespace.
 *
 * @param {Buffer} headerBlock
 * @returns {Map<string, string[]>}
 */
function parseHeaderBlock(headerBlock) {
  const headers = new Map();
  let name = null;
  let value = '';

  const flush = () => {
    if (name === null) return;
    const key = name.toLowerCase();
    const existing = headers.get(key);
    if (existing) existing.push(value);
    else headers.set(key, [value]);
  };

  for (const line of headerBlock.toString('latin1').split(/\r\n|\r|\n/)) {
    if (/^[ \t]/.test(line)) {
      if (name !== null) value += line; // unfolded continuation
      continue;
    }
    flush();
    name = null;
    value = '';
    const colon = line.indexOf(':');
    if (colon <= 0) continue; // malformed header line: skip it rather than throw
    name = line.slice(0, colon);
    value = line.slice(colon + 1).trim();
  }
  flush();
  return headers;
}

/**
 * @param {Map<string, string[]>} headers
 * @param {string} name
 * @returns {string} First value of the header, or `''`.
 */
function getHeader(headers, name) {
  return headers.get(name.toLowerCase())?.[0] ?? '';
}

/**
 * Extract the bare address from a `From` header, dropping display names and
 * comments the way Python's `email.utils.parseaddr` does.
 *
 * @param {string} value
 * @returns {string}
 */
function parseAddress(value) {
  const text = String(value ?? '');
  const angled = /<([^>]*)>/.exec(text);
  if (angled) return angled[1].trim();
  return text.replace(/\([^)]*\)/g, ' ').trim();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Obsolete but still common alphabetic zones, in minutes east of UTC. */
const NAMED_ZONES = new Map([
  ['ut', 0],
  ['utc', 0],
  ['gmt', 0],
  ['z', 0],
  ['est', -300],
  ['edt', -240],
  ['cst', -360],
  ['cdt', -300],
  ['mst', -420],
  ['mdt', -360],
  ['pst', -480],
  ['pdt', -420],
]);

/**
 * Parse an RFC 5322 date into a `Date`.
 *
 * Dates without a zone are treated as UTC, matching the Python receiver which
 * assumes UTC for naive `parsedate_to_datetime` results.
 *
 * @param {string} value
 * @returns {Date|null} `null` when the value is not a recognisable date.
 */
function parseRfc5322Date(value) {
  const text = String(value ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  const match =
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[,\s]+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([+-]\d{4}|[A-Za-z]{1,3}))?$/i.exec(
      text,
    );
  if (!match) return null;

  const month = MONTHS.indexOf(match[2].toLowerCase());
  if (month === -1) return null;
  const day = Number(match[1]);
  const year = normalizeYear(Number(match[3]));
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = match[6] === undefined ? 0 : Number(match[6]);
  const zone = parseZone(match[7]);
  if (zone === null) return null;

  const timestamp = Date.UTC(year, month, day, hours, minutes, seconds) - zone * 60_000;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @param {number} year Two or four digit year.
 * @returns {number} Four digit year, using Python's 1970 pivot.
 */
function normalizeYear(year) {
  if (year >= 1000) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

/**
 * @param {string|undefined} zone
 * @returns {number|null} Offset in minutes east of UTC, or `null` if unknown.
 */
function parseZone(zone) {
  if (!zone) return 0;
  if (/^[+-]\d{4}$/.test(zone)) {
    const sign = zone[0] === '-' ? -1 : 1;
    return sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  }
  const named = NAMED_ZONES.get(zone.toLowerCase());
  return named === undefined ? null : named;
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded words
// ---------------------------------------------------------------------------

/**
 * Decode one RFC 2047 encoded word payload.
 *
 * @param {string} charset
 * @param {string} encoding `B` or `Q`.
 * @param {string} payload
 * @returns {string}
 */
function decodeEncodedWord(charset, encoding, payload) {
  let bytes;
  if (encoding.toUpperCase() === 'B') {
    bytes = Buffer.from(payload, 'base64');
  } else {
    // RFC 2047 Q encoding is quoted-printable with `_` standing for a space.
    bytes = decodeQuotedPrintable(Buffer.from(payload.replace(/_/g, ' '), 'latin1'));
  }
  return decodeCharset(bytes, charset);
}

const ENCODED_WORD_RE = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/**
 * Decode every RFC 2047 encoded word in a header value.
 *
 * Whitespace separating two adjacent encoded words is removed, as RFC 2047
 * requires; the input is returned unchanged when it holds no encoded word.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function decodeHeaderValue(value) {
  const text = String(value ?? '');
  if (!text.includes('=?')) return text;

  let result = '';
  let lastIndex = 0;
  let previousWasEncoded = false;
  ENCODED_WORD_RE.lastIndex = 0;
  let match;
  while ((match = ENCODED_WORD_RE.exec(text)) !== null) {
    const between = text.slice(lastIndex, match.index);
    if (!(previousWasEncoded && /^[ \t\r\n]*$/.test(between))) result += between;
    result += decodeEncodedWord(match[1], match[2], match[3]);
    previousWasEncoded = true;
    lastIndex = match.index + match[0].length;
  }
  return result + text.slice(lastIndex);
}

// ---------------------------------------------------------------------------
// MIME entity walking
// ---------------------------------------------------------------------------

/**
 * Parse one MIME entity (headers plus raw body).
 *
 * @param {Buffer} buffer
 * @returns {{ headers: Map<string, string[]>, body: Buffer, contentType: ReturnType<typeof parseContentType>, disposition: ReturnType<typeof parseContentDisposition> }}
 */
function parseEntity(buffer) {
  const { headerBlock, body } = splitHeaderBody(buffer);
  const headers = parseHeaderBlock(headerBlock);
  return {
    headers,
    body,
    contentType: parseContentType(getHeader(headers, 'content-type')),
    disposition: parseContentDisposition(getHeader(headers, 'content-disposition')),
  };
}

/**
 * Locate a MIME boundary that sits at the start of a line.
 *
 * @param {Buffer} body
 * @param {Buffer} dashBoundary `--boundary` as latin1 bytes.
 * @param {number} from Offset to start searching at.
 * @returns {number} Index of the boundary, or -1.
 */
function findBoundary(body, dashBoundary, from) {
  let index = body.indexOf(dashBoundary, from);
  while (index !== -1) {
    const previous = index === 0 ? 0x0a : body[index - 1];
    if (previous === 0x0a || index === 0) return index;
    index = body.indexOf(dashBoundary, index + 1);
  }
  return -1;
}

/**
 * @param {Buffer} body
 * @param {number} from
 * @returns {number} Offset just past the next LF, or `body.length`.
 */
function endOfLine(body, from) {
  const lf = body.indexOf(0x0a, from);
  return lf === -1 ? body.length : lf + 1;
}

/**
 * Split a multipart body into its child entities.
 *
 * @param {Buffer} body
 * @param {string} boundary
 * @returns {Buffer[]}
 */
function splitMultipart(body, boundary) {
  const dashBoundary = Buffer.from(`--${boundary}`, 'latin1');
  const entities = [];
  let start = findBoundary(body, dashBoundary, 0);

  while (start !== -1) {
    const afterBoundary = start + dashBoundary.length;
    if (body.subarray(afterBoundary, afterBoundary + 2).toString('latin1') === '--') break; // closing
    const contentStart = endOfLine(body, afterBoundary);
    const next = findBoundary(body, dashBoundary, contentStart);
    if (next === -1) {
      entities.push(body.subarray(contentStart));
      break;
    }
    let contentEnd = next;
    // Drop the CRLF that belongs to the delimiter, not to the content.
    if (body[contentEnd - 2] === 0x0d && body[contentEnd - 1] === 0x0a) contentEnd -= 2;
    else if (body[contentEnd - 1] === 0x0a) contentEnd -= 1;
    entities.push(body.subarray(contentStart, Math.max(contentStart, contentEnd)));
    start = next;
  }
  return entities;
}

/**
 * @param {{ headers: Map<string, string[]>, contentType: ReturnType<typeof parseContentType>, disposition: ReturnType<typeof parseContentDisposition> }} entity
 * @returns {string} File name from `Content-Disposition` or the `name` parameter.
 */
function entityFilename(entity) {
  const fromDisposition = entity.disposition.parameters.get('filename');
  if (fromDisposition) return fromDisposition;
  return entity.contentType.parameters.get('name') ?? '';
}

/**
 * Decode a leaf part's body using its transfer encoding and charset.
 *
 * @param {{ headers: Map<string, string[]>, body: Buffer, contentType: ReturnType<typeof parseContentType> }} entity
 * @returns {string}
 */
function decodeEntityText(entity) {
  const decoded = decodeContent(entity.body, getHeader(entity.headers, 'content-transfer-encoding'));
  return decodeCharset(decoded, entity.contentType.parameters.get('charset') || 'utf-8');
}

/**
 * Walk an entity tree, collecting text/HTML bodies and attachment sightings.
 *
 * @param {ReturnType<typeof parseEntity>} entity
 * @param {{ textParts: string[], htmlParts: string[], hasAttachments: boolean }} accumulator
 * @param {number} depth
 */
function collectEntity(entity, accumulator, depth) {
  if (depth > MAX_MIME_DEPTH) return;

  if (entity.contentType.maintype === 'multipart') {
    const boundary = entity.contentType.parameters.get('boundary');
    if (!boundary) return; // malformed multipart: nothing safe to descend into
    for (const child of splitMultipart(entity.body, boundary)) {
      collectEntity(parseEntity(child), accumulator, depth + 1);
    }
    return;
  }

  if (entity.disposition.attachment || entityFilename(entity)) {
    accumulator.hasAttachments = true;
    return; // attachment bodies are never part of the reply text
  }
  if (entity.contentType.type === 'text/plain') {
    accumulator.textParts.push(decodeEntityText(entity));
  } else if (entity.contentType.type === 'text/html') {
    accumulator.htmlParts.push(decodeEntityText(entity));
  } else if (entity.contentType.maintype !== 'text') {
    accumulator.hasAttachments = true;
  }
}

/**
 * Normalise loose input into a Buffer.
 *
 * @param {Buffer|Uint8Array|string} raw
 * @returns {Buffer}
 */
function toBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  return Buffer.from(String(raw ?? ''), 'utf8');
}

/**
 * Parse a raw RFC 822 message into the fields the reply validator needs.
 *
 * Never throws: unusable input yields an empty record so a single bad message
 * cannot abort a poll.
 *
 * @param {Buffer|Uint8Array|string} raw Message bytes as delivered by `UID FETCH`.
 * @param {{ uid?: string }} [options]
 * @returns {{
 *   uid: string,
 *   messageId: string,
 *   sender: string,
 *   subject: string,
 *   text: string,
 *   html: string|null,
 *   hasAttachments: boolean,
 *   isNotification: boolean,
 *   receivedAt: Date,
 * }}
 */
export function parseMessage(raw, { uid = '' } = {}) {
  const fallback = {
    uid: String(uid ?? ''),
    messageId: '',
    sender: '',
    subject: '',
    text: '',
    html: null,
    hasAttachments: false,
    isNotification: false,
    receivedAt: new Date(),
  };

  let root;
  try {
    root = parseEntity(toBuffer(raw));
  } catch {
    return fallback;
  }

  const accumulator = { textParts: [], htmlParts: [], hasAttachments: false };
  try {
    collectEntity(root, accumulator, 0);
  } catch {
    // Keep whatever was collected before the malformed branch.
  }

  let receivedAt = fallback.receivedAt;
  try {
    receivedAt = parseRfc5322Date(getHeader(root.headers, 'date')) ?? new Date();
  } catch {
    receivedAt = new Date();
  }

  let subject = '';
  try {
    subject = decodeHeaderValue(getHeader(root.headers, 'subject'));
  } catch {
    subject = getHeader(root.headers, 'subject');
  }

  const messageId = getHeader(root.headers, 'message-id').trim();
  return {
    uid: String(uid ?? ''),
    messageId,
    sender: parseAddress(getHeader(root.headers, 'from')),
    subject,
    text: accumulator.textParts.join('\n').trim(),
    html: accumulator.htmlParts.join('\n').trim() || null,
    hasAttachments: accumulator.hasAttachments,
    // The header is the primary marker; a Message-ID we minted ourselves is a
    // second, independent one, so a provider stripping `X-` headers cannot turn
    // our own notification into an acceptable reply.
    isNotification:
      Boolean(getHeader(root.headers, NOTIFICATION_HEADER)) ||
      messageId.toLowerCase().includes(NOTIFICATION_MESSAGE_ID_DOMAIN),
    receivedAt,
  };
}

// ---------------------------------------------------------------------------
// Reply body helpers
// ---------------------------------------------------------------------------

const QUOTE_PREFIX_RE = /^\s*>/;

/**
 * Markers that end the user's own words and begin the quoted original.
 *
 * `---原始邮件---` followed by `发件人:`/`发送时间:` is what QQ Mail writes above
 * the quoted message. The reference only recognised `在…写道：` and
 * `On … wrote:`, so a QQ or Outlook reply kept its whole quoted original and
 * the session received a wall of the previous mail instead of the sentence the
 * user actually typed. Verified against a real reply, where the entire
 * notification came back as the body.
 */
const QUOTE_SEPARATOR_RE = new RegExp(
  [
    // ---原始邮件--- / ---- 转发邮件 ---- / ----- Original Message -----
    '-{2,}\\s*(?:原始邮件|转发邮件|Original Message)',
    '在.*写道\\s*[:：]',
    'On .* wrote\\s*:',
    // The header block a Chinese client puts under its separator.
    '发件人\\s*[:：]',
    '发送时间\\s*[:：]',
    '_{5,}',
    // A bare horizontal rule.
    '-{3,}\\s*$',
  ].join('|'),
  'i',
);

/**
 * Turn HTML character references back into the characters they stand for.
 *
 * QQ Mail builds the plain-text part of a reply by stripping tags *without*
 * decoding entities, so a body legitimately arrives containing the six
 * characters `&nbsp;`. Left alone they are delivered verbatim into the session,
 * which is both ugly and needless noise for the model.
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&(nbsp|#160|#x0*a0);/gi, ' ')
    .replace(/&(amp|#38|#x0*26);/gi, '&')
    .replace(/&(lt|#60|#x0*3c);/gi, '<')
    .replace(/&(gt|#62|#x0*3e);/gi, '>')
    .replace(/&(quot|#34|#x0*22);/gi, '"')
    .replace(/&(apos|#39|#x0*27);/gi, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const value = Number(code);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    })
    // A non-breaking space is still a space as far as a sentence is concerned.
    .replace(/\u00a0/g, ' ');
}

/**
 * Drop quoted replies, common separators and signature blocks.
 *
 * Port of `strip_quoted_history`: quoted lines are removed wherever they
 * appear, while a reply separator or signature marker ends the body.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripQuotedHistory(text) {
  const lines = [];
  for (const line of String(text ?? '').split(/\r\n|\r|\n/)) {
    if (QUOTE_PREFIX_RE.test(line)) continue;
    if (QUOTE_SEPARATOR_RE.test(line)) break;
    const trimmed = line.trim();
    if (trimmed === '-- ' || trimmed === '--') break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

/** Tags the HTML extractor treats as line breaks. */
const BLOCK_TAGS = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'blockquote']);

/** Elements whose text content is never user-visible prose. */
const SKIP_TAGS = new Set(['script', 'style']);

/** Named character references seen in notification and reply mail. */
const NAMED_ENTITIES = new Map(
  Object.entries({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    iexcl: '\u00a1',
    cent: '\u00a2',
    pound: '\u00a3',
    curren: '\u00a4',
    yen: '\u00a5',
    brvbar: '\u00a6',
    sect: '\u00a7',
    uml: '\u00a8',
    copy: '\u00a9',
    ordf: '\u00aa',
    laquo: '\u00ab',
    not: '\u00ac',
    shy: '\u00ad',
    reg: '\u00ae',
    macr: '\u00af',
    deg: '\u00b0',
    plusmn: '\u00b1',
    sup2: '\u00b2',
    sup3: '\u00b3',
    acute: '\u00b4',
    micro: '\u00b5',
    para: '\u00b6',
    middot: '\u00b7',
    cedil: '\u00b8',
    sup1: '\u00b9',
    ordm: '\u00ba',
    raquo: '\u00bb',
    frac14: '\u00bc',
    frac12: '\u00bd',
    frac34: '\u00be',
    iquest: '\u00bf',
    times: '\u00d7',
    divide: '\u00f7',
    hellip: '\u2026',
    ndash: '\u2013',
    mdash: '\u2014',
    lsquo: '\u2018',
    rsquo: '\u2019',
    sbquo: '\u201a',
    ldquo: '\u201c',
    rdquo: '\u201d',
    bdquo: '\u201e',
    dagger: '\u2020',
    Dagger: '\u2021',
    bull: '\u2022',
    permil: '\u2030',
    prime: '\u2032',
    Prime: '\u2033',
    lsaquo: '\u2039',
    rsaquo: '\u203a',
    oline: '\u203e',
    frasl: '\u2044',
    euro: '\u20ac',
    trade: '\u2122',
    larr: '\u2190',
    uarr: '\u2191',
    rarr: '\u2192',
    darr: '\u2193',
    harr: '\u2194',
    minus: '\u2212',
    lowast: '\u2217',
    radic: '\u221a',
    infin: '\u221e',
    ne: '\u2260',
    le: '\u2264',
    ge: '\u2265',
    loz: '\u25ca',
    spades: '\u2660',
    clubs: '\u2663',
    hearts: '\u2665',
    diams: '\u2666',
  }),
);

/** HTML5 remapping of C1 code points, mirroring the parser in every browser. */
const C1_REMAP = new Map([
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
]);

const CHAR_REF_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)(;?)/g;

/**
 * Decode HTML character references, including the numeric forms and the
 * semicolon-less variants browsers accept.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeCharacterReferences(text) {
  return text.replace(CHAR_REF_RE, (match, body, semicolon) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code)) return match;
      return String.fromCodePoint(sanitizeCodePoint(code));
    }
    const named = NAMED_ENTITIES.get(body);
    // Unknown names are left verbatim; the greedy match already swallows a
    // trailing word like `&ampx`, so no partial entity is ever decoded.
    if (named === undefined) return match;
    return named;
  });
}

/**
 * @param {number} code
 * @returns {number} A code point safe to hand to `String.fromCodePoint`.
 */
function sanitizeCodePoint(code) {
  if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return 0xfffd;
  if (code >= 0xd800 && code <= 0xdfff) return 0xfffd;
  const remapped = C1_REMAP.get(code);
  return remapped === undefined ? code : remapped;
}

/**
 * Extract visible text from HTML with the same rules as `_HtmlTextExtractor`:
 * script/style are ignored, everything inside `blockquote` is dropped, block
 * level tags become line breaks and empty lines are removed.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  const source = String(html ?? '');
  try {
    return extractHtmlText(source);
  } catch {
    // Same fallback as the Python helper: crude tag stripping.
    return source.replace(/<[^>]+>/g, ' ').trim();
  }
}

/**
 * @param {string} source
 * @returns {string}
 */
function extractHtmlText(source) {
  let parts = '';
  let inQuote = false;
  let index = 0;

  const appendText = (text) => {
    if (text && !inQuote) parts += decodeCharacterReferences(text);
  };

  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open === -1) {
      appendText(source.slice(index));
      break;
    }
    appendText(source.slice(index, open));

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', open) || source.startsWith('<?', open)) {
      const end = source.indexOf('>', open + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    // Scan to the closing '>' while respecting quoted attribute values.
    let cursor = open + 1;
    let quote = '';
    while (cursor < source.length) {
      const char = source[cursor];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= source.length) {
      appendText(source.slice(open)); // unterminated tag: treat as data
      break;
    }

    const rawTag = source.slice(open + 1, cursor);
    const closing = rawTag.startsWith('/');
    const name = rawTag
      .replace(/^\//, '')
      .split(/[\s/]/)[0]
      .toLowerCase();
    index = cursor + 1;

    if (SKIP_TAGS.has(name)) {
      if (!closing) {
        // Skip straight to the matching end tag so markup inside a script
        // string cannot swallow the rest of the document.
        const endTag = new RegExp(`</${name}\\s*>`, 'i');
        const rest = source.slice(index);
        const found = endTag.exec(rest);
        index = found ? index + found.index + found[0].length : source.length;
      }
      continue;
    }
    if (name === 'blockquote') {
      inQuote = !closing;
      parts += '\n';
      continue;
    }
    if (BLOCK_TAGS.has(name)) parts += '\n';
  }

  const lines = parts.split(/\r\n|\r|\n/).map((line) => line.trim());
  return lines.filter((line) => line.length > 0).join('\n');
}
