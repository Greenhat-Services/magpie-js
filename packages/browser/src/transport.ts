import { type Dsn, endpoint, type Payload, type Transport, type TransportResult } from '@greenhat-services/magpie-core';

/** Browsers refuse a keepalive request whose body is much over 64 KB, so larger ones are sent without it. */
const KEEPALIVE_LIMIT = 60_000;

/**
 * Delivers payloads with `fetch`.
 *
 * The key travels in the query string and the body is `text/plain`, which makes this a CORS "simple request": the
 * browser sends it straight away with no preflight, so an event is one round trip instead of two, and `keepalive`
 * lets it finish while the page is closing. The key is public by design (it ships in every bundle), and Magpie reads
 * the raw body whatever its content type.
 */
export function fetchTransport(dsn: Dsn, fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)): Transport {
    const url = (payload: Payload) => `${endpoint(dsn, (payload as { type?: string }).type === 'transaction' ? 'transactions' : 'events')}?magpie_key=${encodeURIComponent(dsn.publicKey)}`;

    return {
        async send(payload: Payload): Promise<TransportResult> {
            try {
                const body = JSON.stringify(payload);
                const response = await fetchImpl(url(payload), {
                    method: 'POST',
                    body,
                    headers: { 'Content-Type': 'text/plain' },
                    keepalive: body.length < KEEPALIVE_LIMIT,
                    mode: 'cors',
                    credentials: 'omit',
                    referrerPolicy: 'no-referrer',
                });

                return { ok: response.ok, status: response.status, retryAfter: parseRetryAfter(response.headers.get('retry-after')) };
            } catch {
                // Offline, blocked by an ad blocker, or CORS: there is nothing useful to do but drop it.
                return { ok: false };
            }
        },
    };
}

function parseRetryAfter(value: string | null): number | undefined {
    const seconds = Number(value);

    return value !== null && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : undefined;
}
