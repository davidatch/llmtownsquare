'use strict';
/**
 * Byte-exact re-implementation of Claude Code's <cross-session-message> envelope.
 *
 * Verified against the claude 2.1.238 binary (functions _Nr / TAb / OId / fNr / kZ / kId).
 * The receiver parses the envelope, re-serializes it, and byte-compares the result against
 * what arrived; any deviation makes it drop the origin metadata. So this file must stay in
 * lock-step with the constants below.
 */

const TAG = 'cross-session-message';

// Character class allowed inside an address (everything else is percent-encoded).
const ADDR_SAFE = /[^A-Za-z0-9:_/.\-\\]/gu;
const SESSION_RE = /^[A-Za-z0-9_-]{1,80}$/;
const HOP_RE = /^[0-9a-f]{24}(?:,[0-9a-f]{24}){0,31}$/;
const MODES = ['bypass', 'prompting'];

/** Strip format/control/surrogate/line-separator chars, trim, cap at 64 chars. */
function sanitizeName(input) {
  const stripped = String(input).replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, '').trim();
  const chars = [...stripped];
  return chars.length > 64 ? `${chars.slice(0, 64).join('')}…` : stripped;
}

/** Percent-encode a socket path into the `uds:` address form. */
function encodeAddress(path) {
  const enc = new TextEncoder();
  return String(path).replace(ADDR_SAFE, (ch) =>
    Array.from(enc.encode(ch), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  );
}

function udsAddress(sockPath) {
  return `uds:${encodeAddress(sockPath)}`;
}

/** Inverse of udsAddress(): "uds:%2Ftmp%2F..." -> "/tmp/...". */
function addressToPath(address) {
  const raw = String(address).startsWith('uds:') ? String(address).slice(4) : String(address);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Neutralize nested envelope tags in a body so a message can never forge an envelope.
 * Claude escapes any occurrence of `<` that begins an opening or closing tag as `<\`.
 */
function escapeBody(body) {
  return String(body).replace(new RegExp(`<(?=/?${TAG})`, 'g'), '<\\');
}

function unescapeBody(body) {
  return String(body).replace(new RegExp(`<\\\\(?=/?${TAG})`, 'g'), '<');
}

function buildAttributes({ from, fromName, fromSession, hopChain, fromMode }) {
  const parts = [];
  if (from) parts.push(`from="${from}"`);
  if (fromSession && SESSION_RE.test(fromSession)) parts.push(`from-session="${fromSession}"`);
  if (Array.isArray(hopChain) && hopChain.length > 0) {
    const joined = hopChain.join(',');
    if (HOP_RE.test(joined)) parts.push(`hop-chain="${joined}"`);
  }
  const name = fromName === undefined ? undefined : sanitizeName(String(fromName).replace(/["<>]/g, ''));
  if (name) parts.push(`from-name="${name}"`);
  if (fromMode && MODES.includes(fromMode)) parts.push(`from-mode="${fromMode}"`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** Serialize an envelope. Attribute order is fixed and significant. */
function wrap({ from, fromName, fromSession, hopChain, fromMode, body }) {
  const attrs = buildAttributes({ from, fromName, fromSession, hopChain, fromMode });
  return `<${TAG}${attrs}>\n${escapeBody(body ?? '')}\n</${TAG}>`;
}

const PARSE_RE = new RegExp(
  `^<${TAG}` +
    `(?: from="([A-Za-z0-9%:_/.\\\\-]+)")?` +
    `(?: from-session="([A-Za-z0-9_-]{1,80})")?` +
    `(?: hop-chain="([0-9a-f]{24}(?:,[0-9a-f]{24}){0,31})")?` +
    `(?: from-name="([^"<>\\n\\r]+)")?` +
    `(?: from-mode="(${MODES.join('|')})")?` +
    `>\\n([\\s\\S]*)\\n</${TAG}>$`
);

/**
 * Parse an envelope, mirroring Claude's verification: re-serialize the parsed pieces and
 * require a byte-identical match, otherwise treat the text as un-enveloped.
 */
function parse(text) {
  if (typeof text !== 'string') return undefined;
  const m = text.match(PARSE_RE);
  if (!m) return undefined;
  const hopChain = m[3] !== undefined ? m[3].split(',') : undefined;
  const parsed = {
    from: m[1],
    fromSession: m[2],
    hopChain,
    fromName: m[4],
    fromMode: m[5],
    body: m[6] ?? '',
  };
  if (wrap(parsed) !== text) return undefined;
  return { ...parsed, body: unescapeBody(parsed.body) };
}

module.exports = {
  wrap,
  parse,
  udsAddress,
  addressToPath,
};
