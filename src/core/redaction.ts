const SECRET_KEY = /(authorization|cookie|token|secret|password|api[-_]?key)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

export function redactValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return (/url$/i.test(key) ? redactUrl(value) : value)
    .replace(BEARER, 'Bearer [REDACTED]').replace(JWT, '[REDACTED_JWT]')
    .replace(/((?:["']?)(?:password|token|secret|api[-_]?key|authorization)(?:["']?)\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED]$2')
    .replace(/(<input\b[^>]*\btype\s*=\s*["']?password["']?[^>]*\bvalue\s*=\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED]$2');
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redactValue(childValue, childKey)]),
    );
  }
  return value;
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Scrubs one or more exact known-secret values (e.g. a configured Vercel bypass token) out of a
 * string. Unlike the key-name and pattern matching above, this catches a secret that a target
 * page echoes back into its own content — something header-name or shape-based redaction cannot
 * anticipate, because the value carries no distinguishing shape of its own. Also matches the
 * HTML-entity-encoded form, since a page that correctly escapes reflected input (e.g. `&` as
 * `&amp;`) would otherwise defeat the exact byte-for-byte match.
 */
export function redactKnownSecrets(value: string, secrets: readonly (string | undefined)[]): string {
  let result = value;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join('[REDACTED]');
    const escaped = htmlEscape(secret);
    if (escaped !== secret) result = result.split(escaped).join('[REDACTED]');
  }
  return result;
}

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    for (const key of url.searchParams.keys()) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    // CDP can provide browser-internal or malformed URL-like values; leave them unchanged.
    return raw;
  }
}
