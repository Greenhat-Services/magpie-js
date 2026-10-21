/** Random lowercase hex, `bytes` long. Uses the platform's CSPRNG and falls back to Math.random. */
export function randomHex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;

    if (c?.getRandomValues) c.getRandomValues(buf);
    else for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);

    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const eventId = (): string => randomHex(16);
export const spanId = (): string => randomHex(8);
export const traceId = (): string => randomHex(16);

/** Unix seconds with fractions, the unit every Magpie timestamp uses. */
export const nowSeconds = (): number => Date.now() / 1000;

export function matchesAny(value: string, patterns: ReadonlyArray<string | RegExp> | undefined): boolean {
    if (!patterns?.length) return false;

    return patterns.some((p) => (typeof p === 'string' ? value.includes(p) : p.test(value)));
}

export function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/**
 * Copies a value into something safe to serialise: depth and breadth are capped, long strings are cut, circular
 * references become "[Circular]", and anything that cannot be JSON becomes a short description. Never throws.
 */
export function normalize(value: unknown, depth = 4, maxString = 1024, maxKeys = 40, seen: WeakSet<object> = new WeakSet()): unknown {
    try {
        if (value === null || value === undefined) return value ?? null;

        switch (typeof value) {
            case 'string':
                return truncate(value, maxString);
            case 'number':
                return Number.isFinite(value) ? value : String(value);
            case 'boolean':
                return value;
            case 'bigint':
                return `${value}n`;
            case 'symbol':
                return String(value);
            case 'function':
                return `[Function ${(value as { name?: string }).name || 'anonymous'}]`;
        }

        const obj = value as object;
        if (seen.has(obj)) return '[Circular]';
        if (obj instanceof Error) return truncate(`${obj.name}: ${obj.message}`, maxString);
        if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
        if (obj instanceof RegExp) return String(obj);
        if (depth <= 0) return Array.isArray(obj) ? '[Array]' : '[Object]';

        seen.add(obj);
        try {
            if (Array.isArray(obj)) return obj.slice(0, maxKeys).map((v) => normalize(v, depth - 1, maxString, maxKeys, seen));

            const out: Record<string, unknown> = {};
            for (const key of Object.keys(obj).slice(0, maxKeys)) {
                out[key] = normalize((obj as Record<string, unknown>)[key], depth - 1, maxString, maxKeys, seen);
            }

            return out;
        } finally {
            seen.delete(obj);
        }
    } catch {
        return '[Unserializable]';
    }
}
