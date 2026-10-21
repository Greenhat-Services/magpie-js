import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClient, init, type MagpieEvent, nodeTransport, parseDsn, type Payload, trackRequest, type TransactionEvent, type Transport } from '../src';

class FakeTransport implements Transport {
    payloads: Payload[] = [];
    async send(payload: Payload) {
        this.payloads.push(payload);

        return { ok: true, status: 200 };
    }
    get events() {
        return this.payloads.filter((p) => (p as TransactionEvent).type !== 'transaction') as MagpieEvent[];
    }
    get transactions() {
        return this.payloads.filter((p) => (p as TransactionEvent).type === 'transaction') as TransactionEvent[];
    }
}

let transport: FakeTransport;
const base = () => ({ transport, release: 'web@1.0.0', captureUnhandled: false, http: false, maxEventsPerMinute: 1000 });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
    transport = new FakeTransport();
});
afterEach(async () => {
    await getClient()?.close(0);
    vi.restoreAllMocks();
});

describe('per-request isolation', () => {
    it('keeps overlapping requests apart across awaits', async () => {
        const client = init({ ...base(), tracesSampleRate: 1 });
        client.scope.setTag('process', 'shared');

        const serve = (id: string, delay: number) =>
            trackRequest(client, { method: 'GET', url: `/orders/${id}` }, async ({ finish }) => {
                client.scope.setTag('order', id);
                client.addBreadcrumb({ category: 'log', message: `start ${id}` });
                await tick(delay);
                client.captureMessage(`done ${id}`);
                finish(200, '/orders/:id');
            });

        await Promise.all([serve('A', 20), serve('B', 5), serve('C', 10)]);
        await client.flush();

        for (const id of ['A', 'B', 'C']) {
            const event = transport.events.find((e) => e.message === `done ${id}`)!;
            expect(event.tags).toEqual({ process: 'shared', order: id });
            expect(event.breadcrumbs!.map((b) => b.message)).toEqual([`start ${id}`]);
            expect(event.request?.url).toBe(`/orders/${id}`);
        }
        expect(client.scope.tags).toEqual({ process: 'shared' });
        expect(client.scope.breadcrumbs).toEqual([]);
    });

    it('keeps a withScope swap inside the request that made it', async () => {
        const client = init(base());

        await Promise.all([
            trackRequest(client, { method: 'GET', url: '/a' }, async () => {
                client.withScope((scope) => {
                    scope.setTag('temp', 'a');
                    client.captureMessage('in a');
                });
                await tick(5);
                client.captureMessage('after a');
            }),
            trackRequest(client, { method: 'GET', url: '/b' }, async () => {
                await tick(1);
                client.captureMessage('in b');
            }),
        ]);
        await client.flush();

        const tags = (m: string) => transport.events.find((e) => e.message === m)!.tags;
        expect(tags('in a')).toEqual({ temp: 'a' });
        expect(tags('after a')).toBeUndefined();
        expect(tags('in b')).toBeUndefined();
    });
});

describe('trackRequest', () => {
    it('times the request under its route pattern and counts only a server error as a failure', async () => {
        const client = init({ ...base(), tracesSampleRate: 1 });

        await trackRequest(client, { method: 'get', url: '/users/7?page=2' }, async ({ finish }) => finish(200, '/users/:id'));
        await trackRequest(client, { method: 'GET', url: '/nope' }, async ({ finish }) => finish(404));
        await trackRequest(client, { method: 'POST', url: '/boom' }, async ({ finish }) => finish(500));
        await client.flush();

        expect(transport.transactions.map((t) => [t.transaction, t.contexts?.trace?.op, t.contexts?.trace?.status])).toEqual([
            ['GET /users/:id', 'http.server', 'ok'],
            ['GET /nope', 'http.server', 'ok'],
            ['POST /boom', 'http.server', 'internal_error'],
        ]);
    });

    it('continues the trace the browser started', async () => {
        const client = init({ ...base(), tracesSampleRate: 0.0001 });
        const header = `${'a'.repeat(32)}-${'b'.repeat(16)}-1`;

        await trackRequest(client, { method: 'GET', url: '/page', headers: { 'magpie-trace': header } }, async ({ transaction, finish }) => {
            expect(transaction.traceId).toBe('a'.repeat(32));
            finish(200);
        });
        await client.flush();

        expect(transport.transactions[0].contexts?.trace).toMatchObject({ trace_id: 'a'.repeat(32), parent_span_id: 'b'.repeat(16) });
    });

    it('attaches a safe view of the request: allow-listed headers only, tokens in the query scrubbed', async () => {
        const client = init(base());

        await trackRequest(
            client,
            {
                method: 'POST',
                url: '/checkout?token=abc&step=2',
                headers: { host: 'shop.example.com', 'x-forwarded-proto': 'https', 'user-agent': 'Mozilla', cookie: 'session=SECRET', authorization: 'Bearer SECRET', 'x-api-key': 'SECRET' },
            },
            async () => client.captureMessage('boom'),
        );
        await client.flush();

        const event = transport.events[0];
        expect(event.request).toEqual({
            url: 'https://shop.example.com/checkout',
            method: 'POST',
            query_string: 'token=%5BFiltered%5D&step=2',
            headers: { host: 'shop.example.com', 'user-agent': 'Mozilla', 'x-forwarded-proto': 'https' },
        });
        expect(JSON.stringify(event)).not.toContain('SECRET');
    });

    it('describes the runtime and the server on every event', async () => {
        const client = init({ ...base(), serverName: 'web-1' });
        client.captureMessage('hello');
        await client.flush();

        expect(transport.events[0]).toMatchObject({ platform: 'node', server_name: 'web-1', sdk: { name: 'magpie.javascript.node' } });
        expect(transport.events[0].contexts?.runtime).toMatchObject({ name: 'node', version: process.version.replace(/^v/, '') });
        expect(transport.events[0].contexts?.os?.name).toBeTypeOf('string');
    });
});

describe('outgoing requests', () => {
    let original: typeof fetch;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        original = globalThis.fetch;
        fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;
    });
    afterEach(() => {
        globalThis.fetch = original;
    });

    const header = (call: number) => ((fetchMock.mock.calls[call] as unknown[])[1] as RequestInit | undefined)?.headers as Headers | undefined;

    it('makes each call a span and passes the trace to the API it calls', async () => {
        const client = init({ ...base(), http: true, tracesSampleRate: 1 });

        await trackRequest(client, { method: 'GET', url: '/page' }, async ({ transaction, finish }) => {
            await fetch('https://api.example.com/v1/slots?token=abc');
            finish(200);
            const span = transaction.spans[0];
            expect(span).toMatchObject({ op: 'http.client', description: 'GET https://api.example.com/v1/slots' });
            expect(header(0)!.get('magpie-trace')).toBe(`${transaction.traceId}-${span.spanId}-1`);
        });
        await client.flush();
    });

    it('sends no header when tracePropagationTargets is empty, or to a host not on the list', async () => {
        const none = init({ ...base(), http: true, tracesSampleRate: 1, tracePropagationTargets: [] });
        await trackRequest(none, { method: 'GET', url: '/p' }, async ({ finish }) => {
            await fetch('https://api.example.com/x');
            finish(200);
        });
        expect(header(0)?.get('magpie-trace') ?? null).toBeNull();

        const some = init({ ...base(), http: true, tracesSampleRate: 1, tracePropagationTargets: ['api.mine.com'] });
        await trackRequest(some, { method: 'GET', url: '/p' }, async ({ finish }) => {
            await fetch('https://api.mine.com/x');
            await fetch('https://third-party.com/x');
            finish(200);
        });
        expect(header(1)!.get('magpie-trace')).toBeTruthy();
        expect(header(2)?.get('magpie-trace') ?? null).toBeNull();
    });

    it('records a breadcrumb on the request that made the call, and none on another', async () => {
        const client = init({ ...base(), http: true });

        await Promise.all([
            trackRequest(client, { method: 'GET', url: '/a' }, async () => {
                await fetch('https://api.example.com/only-a');
                client.captureMessage('from a');
            }),
            trackRequest(client, { method: 'GET', url: '/b' }, async () => {
                await tick(5);
                client.captureMessage('from b');
            }),
        ]);
        await client.flush();

        expect(transport.events.find((e) => e.message === 'from a')!.breadcrumbs![0]).toMatchObject({ category: 'http', message: 'GET https://api.example.com/only-a', data: { status_code: 200 } });
        expect(transport.events.find((e) => e.message === 'from b')!.breadcrumbs).toBeUndefined();
    });

    it('restores fetch when closed', async () => {
        const client = init({ ...base(), http: true });
        expect(globalThis.fetch).not.toBe(fetchMock);

        await client.close(0);

        expect(globalThis.fetch).toBe(fetchMock);
    });
});

describe('nodeTransport', () => {
    const dsn = parseDsn('https://abc123@ingest.magpie.example.com/7')!;
    const event = { event_id: 'a'.repeat(32), timestamp: 1, platform: 'node', sdk: { name: 'x', version: '1' } };

    it('authenticates with the header the Laravel SDK uses, and compresses a large body', async () => {
        const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
        const transportUnderTest = nodeTransport(dsn, fetchMock as unknown as typeof fetch);

        await transportUnderTest.send({ ...event, message: 'small' });
        await transportUnderTest.send({ ...event, message: 'x'.repeat(10_000) });

        const [smallUrl, small] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const [, large] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        expect(smallUrl).toBe('https://ingest.magpie.example.com/api/7/events');
        expect((small.headers as Record<string, string>)['X-Magpie-Auth']).toBe('Magpie magpie_version=1, magpie_key=abc123, magpie_client=magpie-node');
        expect((small.headers as Record<string, string>)['Content-Encoding']).toBeUndefined();
        expect((large.headers as Record<string, string>)['Content-Encoding']).toBe('gzip');
        expect(JSON.parse(gunzipSync(large.body as Uint8Array).toString()).message).toHaveLength(10_000);
    });

    it('drops the payload rather than throwing or hanging a request', async () => {
        const failing = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        });

        await expect(nodeTransport(dsn, failing as unknown as typeof fetch).send(event)).resolves.toEqual({ ok: false });
    });
});

describe('process handlers', () => {
    it('reports an uncaught exception and an unhandled rejection as unhandled', async () => {
        vi.spyOn(process, 'listenerCount').mockReturnValue(2); // someone else owns the crash, so nothing exits or rethrows
        const client = init({ ...base(), captureUnhandled: true });

        const emitter = process as unknown as NodeJS.EventEmitter;
        emitter.emit('uncaughtException', new Error('late crash'), 'uncaughtException');
        emitter.emit('unhandledRejection', new Error('forgotten promise'), Promise.resolve());
        await client.flush();

        expect(transport.events.map((e) => [e.exception!.values[0].value, e.exception!.values[0].mechanism!.type, e.exception!.values[0].mechanism!.handled])).toEqual([
            ['late crash', 'onuncaughtexception', false],
            ['forgotten promise', 'onunhandledrejection', false],
        ]);
    });

    it('removes its listeners when closed', async () => {
        const before = process.listenerCount('unhandledRejection');
        const client = init({ ...base(), captureUnhandled: true });
        expect(process.listenerCount('unhandledRejection')).toBe(before + 1);

        await client.close(0);

        expect(process.listenerCount('unhandledRejection')).toBe(before);
    });
});

describe('init', () => {
    it('takes the release from MAGPIE_RELEASE when none is passed', async () => {
        process.env.MAGPIE_RELEASE = 'from-env';
        const client = init({ transport, captureUnhandled: false, http: false });
        client.captureMessage('x');
        await client.flush();

        expect(transport.events[0].release).toBe('from-env');
        delete process.env.MAGPIE_RELEASE;
    });
});
