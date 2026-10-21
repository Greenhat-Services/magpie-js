import { gzipSync } from 'node:zlib';
import { type Dsn, endpoint, type Payload, type Transport, type TransportResult } from '@greenhat-services/magpie-core';

/** Bodies above this are gzip-compressed, which Magpie accepts. */
const COMPRESS_FROM = 4096;

/**
 * Delivers payloads from a server. There is no CORS to avoid here, so the key goes in the `X-Magpie-Auth` header,
 * the same as the Laravel SDK, and the body is JSON, compressed when it is large.
 */
export function nodeTransport(dsn: Dsn, fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args), timeoutMs = 3000): Transport {
    return {
        async send(payload: Payload): Promise<TransportResult> {
            try {
                const path = (payload as { type?: string }).type === 'transaction' ? 'transactions' : 'events';
                const json = JSON.stringify(payload);
                const compressed = json.length >= COMPRESS_FROM;

                const response = await fetchImpl(endpoint(dsn, path), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Magpie-Auth': `Magpie magpie_version=1, magpie_key=${dsn.publicKey}, magpie_client=magpie-node`,
                        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
                    },
                    body: compressed ? new Uint8Array(gzipSync(json)) : json,
                    signal: AbortSignal.timeout(timeoutMs),
                });

                const retry = Number(response.headers.get('retry-after'));

                return { ok: response.ok, status: response.status, retryAfter: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : undefined };
            } catch {
                // Unreachable, or too slow: monitoring must never hold a request up, so the payload is dropped.
                return { ok: false };
            }
        },
    };
}
