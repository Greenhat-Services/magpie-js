/**
 * Anything that can carry a credential is cleaned before it leaves the page. The same list as the Laravel SDK's
 * RequestContext, so a key that is filtered on the server is filtered in the browser too.
 */
const SENSITIVE_KEY =
    /(pass(word|wd)?|secret|token|api[_-]?key|credential|session|csrf|xsrf|otp|cvv|ssn|signature|private[_-]?key)|^(auth|authorization|sig|pin|code|key|card(_?number)?|credit_?card|cc)$/i;

export const FILTERED = '[Filtered]';

export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key);

/** `a=1&token=x` with the values of sensitive keys replaced. Keeps the order and the keys. */
export function scrubQuery(query: string): string {
    const raw = query.startsWith('?') ? query.slice(1) : query;
    if (!raw) return '';

    return raw
        .split('&')
        .map((pair) => {
            const eq = pair.indexOf('=');
            if (eq < 0) return pair;
            const key = safeDecode(pair.slice(0, eq));

            return isSensitiveKey(key) ? `${pair.slice(0, eq)}=${encodeURIComponent(FILTERED)}` : pair;
        })
        .join('&');
}

/**
 * A URL with credentials removed, sensitive query values filtered, and a fragment that looks like parameters
 * (an OAuth callback's `#access_token=...`) filtered the same way. A plain `#section` fragment is kept.
 */
export function scrubUrl(url: string): string {
    try {
        const u = new URL(url, 'http://placeholder.invalid');
        const relative = !/^[a-z][a-z0-9+.-]*:/i.test(url);

        u.username = '';
        u.password = '';
        u.search = scrubQuery(u.search);
        if (u.hash.includes('=')) u.hash = `#${scrubQuery(u.hash.slice(1))}`;

        return relative ? `${u.pathname}${u.search}${u.hash}` : u.toString();
    } catch {
        return url;
    }
}

/** Replaces the values of sensitive keys at any depth. Used for breadcrumb data and extra context. */
export function scrubData<T>(value: T, depth = 6): T {
    if (depth <= 0 || value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) return value.map((v) => scrubData(v, depth - 1)) as unknown as T;

    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        out[key] = isSensitiveKey(key) ? FILTERED : scrubData(v, depth - 1);
    }

    return out as T;
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
        return value;
    }
}
