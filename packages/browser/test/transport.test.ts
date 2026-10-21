import { describe, expect, it, vi } from 'vitest';
import { fetchTransport, parseDsn } from '../src';

const dsn = parseDsn('https://abc123@ingest.magpie.example.com/7')!;
const event = { event_id: 'a'.repeat(32), timestamp: 1, platform: 'javascript', sdk: { name: 'x', version: '1' }, message: 'hi' };

const respond = (status: number, headers: Record<string, string> = {}) => vi.fn(async () => new Response('{}', { status, headers }));

describe('fetchTransport', () => {
    it('posts as a CORS simple request: key in the query, text/plain body, no custom headers', async () => {
        const fetchMock = respond(200);

        const result = await fetchTransport(dsn, fetchMock as unknown as typeof fetch).send(event);

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://ingest.magpie.example.com/api/7/events?magpie_key=abc123');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ 'Content-Type': 'text/plain' });
        expect(init).toMatchObject({ keepalive: true, credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer' });
        expect(JSON.parse(init.body as string)).toEqual(event);
        expect(result).toEqual({ ok: true, status: 200, retryAfter: undefined });
    });

    it('sends transactions to the transactions endpoint', async () => {
        const fetchMock = respond(200);

        await fetchTransport(dsn, fetchMock as unknown as typeof fetch).send({ ...event, type: 'transaction', transaction: '/x', start_timestamp: 1, spans: [] } as never);

        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://ingest.magpie.example.com/api/7/transactions?magpie_key=abc123');
    });

    it('reports a rejection with the wait Magpie asked for, capped at an hour', async () => {
        expect(await fetchTransport(dsn, respond(429, { 'retry-after': '120' }) as unknown as typeof fetch).send(event)).toMatchObject({ ok: false, status: 429, retryAfter: 120 });
        expect((await fetchTransport(dsn, respond(429, { 'retry-after': '99999' }) as unknown as typeof fetch).send(event)).retryAfter).toBe(3600);
        expect(await fetchTransport(dsn, respond(403) as unknown as typeof fetch).send(event)).toMatchObject({ ok: false, status: 403 });
    });

    it('drops the payload instead of throwing when the network, an ad blocker or CORS stops it', async () => {
        const failing = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        });

        await expect(fetchTransport(dsn, failing as unknown as typeof fetch).send(event)).resolves.toEqual({ ok: false });
    });

    it('does not use keepalive for a body too large for it', async () => {
        const fetchMock = respond(200);

        await fetchTransport(dsn, fetchMock as unknown as typeof fetch).send({ ...event, message: 'x'.repeat(70_000) });

        expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].keepalive).toBe(false);
    });
});
