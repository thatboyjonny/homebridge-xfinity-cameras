/**
 * Everything that might leave this process (logs, error messages, diagnostics)
 * goes through these helpers so tokens, PINs and session headers never leak.
 */

const SECRET_KEYS = [
  'access_token', 'refresh_token', 'id_token', 'token', 'xhauth', 'xh-auth',
  'sessionheadervalue', 'authorization', 'cookie', 'set-cookie', 'password',
  'code', 'pin', 'client_secret', 'videotoken', 'streamtoken',
];

const isSecretKey = (key: string): boolean => {
  const k = key.toLowerCase();
  return SECRET_KEYS.includes(k) || /token$|secret$|password$|^xh-?auth/.test(k);
};

/** Mask a single secret: keep only its length so logs can still tell values apart. */
export const mask = (value: unknown): string =>
  typeof value === 'string' && value.length ? `[redacted:${value.length}]` : '[redacted]';

/** Deep-copy an object with every secret-looking field masked. */
export function redact<T>(input: T, depth = 0): T {
  if (depth > 8 || input === null || typeof input !== 'object') {
    return typeof input === 'string' ? (redactString(input) as unknown as T) : input;
  }
  if (Array.isArray(input)) {
    return input.map(v => redact(v, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? mask(v) : redact(v, depth + 1);
  }
  return out as T;
}

/** Scrub secrets embedded in free text: form bodies, bearer headers, JWTs. */
export function redactString(text: string): string {
  return text
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(refresh_token|access_token|id_token|code|pin|password|client_secret)=([^&\s"]+)/gi, '$1=[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]');
}
