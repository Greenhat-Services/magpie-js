import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, type Payload, type Runtime, type TransactionEvent, type Transport, type TransportResult, type MagpieEvent } from '../src';

class FakeTransport implements Transport {
    payloads: Payload[] = [];
    result: TransportResult = { ok: true, status: 200 };

    async send(payload: Payload): Promise<TransportResult> {
        this.payloads.push(payload);

        return this.result;
    }

    get events(): MagpieEvent[] {
        return this.payloads.filter((p): p is MagpieEvent => (p as TransactionEvent).type !== 'transaction');
    }

    get transactions(): TransactionEvent[] {
        return this.payloads.filter((p): p is TransactionEvent => (p as TransactionEvent).type === 'transaction');
    }
}

const runtime = (extra: Partial<Runtime> = {}): Runtime => ({
    sdk: { name: 'magpie.javascript.test', version: '9.9.9' },
    platform: 'javascript',
    createTransport: () => new FakeTransport(),
    ...extra,
});

function make(options: Record<string, unknown> = {}, rt: Partial<Runtime> = {}) {
    const transport = new FakeTransport();
    const client = new Client({ transport, release: 'web@1.2.3', environment: 'production', ...options }, runtime(rt));

    return { client, transport };
}

const boom = (message = 'boom') => {
    const e = new Error(message);
    e.stack = `Error: ${message}\n    at load (https://app.example.com/assets/app-3f2a1.js:1:48213)`;

    return e;
};

describe('captureException', () => {
    it('sends the event Magpie expects', async () => {
        const { client, transport } = make();

        const id = client.captureException(boom());
        await client.flush();

        const [event] = transport.events;
        expect(id).toBe(event.event_id);
        expect(event).toMatchObject({
            platform: 'javascript',
            level: 'error',
            environment: 'production',
            release: 'web@1.2.3',
            sdk: { name: 'magpie.javascript.test', version: '9.9.9' },
        });
        expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
        expect(event.timestamp).toBeGreaterThan(1_700_000_000);
        expect(event.exception?.values[0]).toMatchObject({
            type: 'Error',
            value: 'boom',
            mechanism: { type: 'generic', handled: true },
            stacktrace: { frames: [{ filename: 'https://app.example.com/assets/app-3f2a1.js', lineno: 1, colno: 48213, function: 'load', in_app: true }] },
        });
    });

    it('does nothing without a DSN, with an invalid one, or when disabled', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(new Client({}, runtime()).captureException(boom())).toBeUndefined();
        expect(new Client({ dsn: 'nonsense', debug: true }, runtime()).enabled).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('DSN is not valid'), '');
        expect(make({ enabled: false }).client.captureException(boom())).toBeUndefined();

        warn.mockRestore();
    });

    it('reports the same error object once, however many handlers see it', async () => {
        const { client, transport } = make({ maxEventsPerMinute: 100 });
        const error = boom('seen twice');

        expect(client.captureException(error)).toBeDefined();
        expect(client.captureException(error, { mechanism: { type: 'onerror', handled: false } })).toBeUndefined();
        await client.flush();

        expect(transport.events).toHaveLength(1);
    });

    it('sends a message with its level', async () => {
        const { client, transport } = make();

        client.captureMessage('deploy finished', 'info');
        await client.flush();

        expect(transport.events[0]).toMatchObject({ message: 'deploy finished', level: 'info' });
    });

    it('honours the sample rate', async () => {
        expect(make({ sampleRate: 0 }).client.captureException(boom())).toBeUndefined();

        vi.spyOn(Math, 'random').mockReturnValue(0.4);
        expect(make({ sampleRate: 0.5 }).client.captureException(boom())).toBeDefined();
        vi.spyOn(Math, 'random').mockReturnValue(0.6);
        expect(make({ sampleRate: 0.5 }).client.captureException(boom())).toBeUndefined();
        vi.restoreAllMocks();
    });

    it('drops ignored errors, denied script URLs and, with an allow list, everything else', () => {
        expect(make({ ignoreErrors: ['ResizeObserver loop'] }).client.captureException(boom('ResizeObserver loop limit exceeded'))).toBeUndefined();
        expect(make({ ignoreErrors: [/^Error: boom$/] }).client.captureException(boom())).toBeUndefined();
        expect(make({ denyUrls: [/app-3f2a1/] }).client.captureException(boom())).toBeUndefined();
        expect(make({ allowUrls: ['other.example.com'] }).client.captureException(boom())).toBeUndefined();
        expect(make({ allowUrls: ['app.example.com'] }).client.captureException(boom())).toBeDefined();
    });

    it('applies beforeSend, and a null drops the event', async () => {
        const { client, transport } = make({ beforeSend: (e: MagpieEvent) => ({ ...e, tags: { ...e.tags, seen: 'yes' } }) });
        client.captureException(boom());
        await client.flush();
        expect(transport.events[0].tags).toEqual({ seen: 'yes' });

        expect(make({ beforeSend: () => null }).client.captureException(boom())).toBeUndefined();
    });
});

describe('flood control', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('drops the same error repeated within five seconds, then lets it through again', async () => {
        const { client, transport } = make();

        expect(client.captureException(boom())).toBeDefined();
        expect(client.captureException(boom())).toBeUndefined();
        expect(client.captureException(boom('a different one'))).toBeDefined();

        vi.advanceTimersByTime(6_000);
        expect(client.captureException(boom())).toBeDefined();
        await client.flush();
        expect(transport.events).toHaveLength(3);
    });

    it('caps events per minute so a render loop cannot flood Magpie', () => {
        const { client } = make({ maxEventsPerMinute: 3 });

        const sent = [1, 2, 3, 4, 5].map((n) => client.captureException(boom(`error ${n}`)));

        expect(sent.filter(Boolean)).toHaveLength(3);

        vi.advanceTimersByTime(61_000);
        expect(client.captureException(boom('after a minute'))).toBeDefined();
    });

    it('stops sending while Magpie says 429, for as long as Retry-After asked', async () => {
        const { client, transport } = make();
        transport.result = { ok: false, status: 429, retryAfter: 30 };

        client.captureException(boom('first'));
        await vi.advanceTimersByTimeAsync(0);
        await client.flush();

        expect(client.captureException(boom('while blocked'))).toBeUndefined();

        vi.advanceTimersByTime(31_000);
        transport.result = { ok: true, status: 200 };
        expect(client.captureException(boom('after the wait'))).toBeDefined();
    });
});

describe('never breaks the host application', () => {
    it('swallows a transport that throws or rejects', async () => {
        const throwing: Transport = {
            send: () => {
                throw new Error('sync failure');
            },
        };
        const rejecting: Transport = { send: () => Promise.reject(new Error('async failure')) };

        expect(() => new Client({ transport: throwing }, runtime()).captureException(boom())).not.toThrow();
        const client = new Client({ transport: rejecting }, runtime());
        expect(() => client.captureException(boom())).not.toThrow();
        await expect(client.flush()).resolves.toBe(true);
    });

    it('swallows a beforeSend or beforeBreadcrumb that throws', () => {
        const bad = () => {
            throw new Error('hook failure');
        };
        const { client } = make({ beforeSend: bad, beforeBreadcrumb: bad });

        expect(() => client.captureException(boom())).not.toThrow();
        expect(() => client.addBreadcrumb({ message: 'x' })).not.toThrow();
    });

    it('flush reports false when delivery is slower than the timeout', async () => {
        const slow: Transport = { send: () => new Promise(() => {}) };
        const client = new Client({ transport: slow }, runtime());
        client.captureException(boom());

        await expect(client.flush(20)).resolves.toBe(false);
    });
});

describe('scope and breadcrumbs', () => {
    it('attaches tags, extra, context and the user you set', async () => {
        const { client, transport } = make();
        client.scope.setTag('plan', 'pro').setExtra('cart', { items: 2 }).setContext('device', { dpr: 2 }).setUser({ id: 42, email: 'jo@example.com' });

        client.captureException(boom());
        await client.flush();

        expect(transport.events[0]).toMatchObject({ tags: { plan: 'pro' }, extra: { cart: { items: 2 } }, contexts: { device: { dpr: 2 } }, user: { id: 42, email: 'jo@example.com' } });
    });

    it('sends no user unless one was set', async () => {
        const { client, transport } = make();
        client.captureException(boom());
        await client.flush();

        expect(transport.events[0].user).toBeUndefined();
    });

    it('withScope tags one operation and leaves the rest alone', async () => {
        const { client, transport } = make();

        client.withScope((scope) => {
            scope.setTag('step', 'checkout');
            client.captureException(boom('inside'));
        });
        client.captureException(boom('outside'));
        await client.flush();

        expect(transport.events[0].tags).toEqual({ step: 'checkout' });
        expect(transport.events[1].tags).toBeUndefined();
    });

    it('keeps only the newest breadcrumbs, scrubs their data and lets beforeBreadcrumb drop some', async () => {
        const { client, transport } = make({ maxBreadcrumbs: 3, beforeBreadcrumb: (b: { category?: string }) => (b.category === 'noise' ? null : b) });

        for (let i = 1; i <= 5; i++) client.addBreadcrumb({ category: 'log', message: `m${i}`, data: { token: 'secret', page: i } });
        client.addBreadcrumb({ category: 'noise', message: 'dropped' });
        client.captureException(boom());
        await client.flush();

        const crumbs = transport.events[0].breadcrumbs!;
        expect(crumbs.map((c) => c.message)).toEqual(['m3', 'm4', 'm5']);
        expect(crumbs[0].data).toEqual({ token: '[Filtered]', page: 3 });
        expect(crumbs[0].timestamp).toBeGreaterThan(1_700_000_000);
    });

    it('scrubs the page URL and extra data it sends', async () => {
        const { client, transport } = make({}, { request: () => ({ url: 'https://app.example.com/cb?token=abc&page=1', method: 'GET' }) });
        client.scope.setExtra('form', { password: 'hunter2', name: 'Jo' });

        client.captureException(boom());
        await client.flush();

        expect(transport.events[0].request?.url).toBe('https://app.example.com/cb?token=%5BFiltered%5D&page=1');
        expect(transport.events[0].extra).toEqual({ form: { password: '[Filtered]', name: 'Jo' } });
        expect(JSON.stringify(transport.events[0])).not.toContain('hunter2');
    });

    it('merges the runtime contexts (browser, os) without overriding the event', async () => {
        const { client, transport } = make({}, { contexts: () => ({ browser: { name: 'Chrome', version: '155' }, os: { name: 'Windows' } }) });
        client.captureException(boom());
        await client.flush();

        expect(transport.events[0].contexts).toMatchObject({ browser: { name: 'Chrome' }, os: { name: 'Windows' } });
    });
});

describe('tracing', () => {
    it('sends nothing for an unsampled transaction and a full one for a sampled transaction', async () => {
        const off = make({ tracesSampleRate: 0 });
        off.client.startTransaction({ name: '/home', op: 'pageload' }).end();
        await off.client.flush();
        expect(off.transport.payloads).toHaveLength(0);

        const { client, transport } = make({ tracesSampleRate: 1 });
        const tx = client.startTransaction({ name: '/users/:id', op: 'navigation' });
        tx.startChild({ op: 'http.client', description: 'GET /api/users/7' }).end();
        tx.end();
        await client.flush();

        const [event] = transport.transactions;
        expect(event).toMatchObject({ type: 'transaction', transaction: '/users/:id', platform: 'javascript', release: 'web@1.2.3' });
        expect(event.contexts?.trace).toMatchObject({ trace_id: tx.traceId, span_id: tx.spanId, op: 'navigation', status: 'ok' });
        expect(event.spans).toHaveLength(1);
        expect(event.spans[0]).toMatchObject({ op: 'http.client', description: 'GET /api/users/7', parent_span_id: tx.spanId });
        expect(event.timestamp).toBeGreaterThanOrEqual(event.start_timestamp);
        expect(event.breadcrumbs).toBeUndefined();
    });

    it('follows an upstream sampling decision and keeps the trace id', async () => {
        const { client, transport } = make({ tracesSampleRate: 0 });

        const tx = client.startTransaction({ name: 'GET /x', traceId: 'c'.repeat(32), parentSpanId: 'd'.repeat(16), sampled: true });
        tx.end();
        await client.flush();

        expect(transport.transactions[0].contexts?.trace).toMatchObject({ trace_id: 'c'.repeat(32), parent_span_id: 'd'.repeat(16) });
        expect(tx.traceHeader()).toBe(`${'c'.repeat(32)}-${tx.spanId}-1`);
    });

    it('sends a transaction once, ends open spans with it, and caps spans at 100', async () => {
        const { client, transport } = make({ tracesSampleRate: 1 });
        const tx = client.startTransaction({ name: '/busy' });

        for (let i = 0; i < 130; i++) tx.startChild({ op: 'work' });
        tx.end();
        tx.end();
        await client.flush();

        expect(transport.transactions).toHaveLength(1);
        expect(transport.transactions[0].spans).toHaveLength(100);
        expect(transport.transactions[0].contexts?.trace?.dropped_spans).toBe(30);
        expect(transport.transactions[0].spans.every((s) => s.timestamp >= s.start_timestamp)).toBe(true);
    });

    it('startSpan times sync and async work and marks a rejection as failed', async () => {
        const { client, transport } = make({ tracesSampleRate: 1 });
        const tx = client.startTransaction({ name: '/work' });
        client.activeTransaction = tx;

        expect(client.startSpan({ op: 'a' }, () => 42)).toBe(42);
        await expect(client.startSpan({ op: 'b' }, async () => 'ok')).resolves.toBe('ok');
        await expect(client.startSpan({ op: 'c' }, () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
        tx.end();
        await client.flush();

        const spans = transport.transactions[0].spans;
        expect(spans.map((s) => s.op)).toEqual(['a', 'b', 'c']);
        expect(spans[2].data).toMatchObject({ status: 'internal_error' });
        expect(spans[0].data).toBeUndefined();
    });

    it('runs the callback even with no active transaction', () => {
        expect(make().client.startSpan({ op: 'x' }, () => 'still runs')).toBe('still runs');
    });

    it('decides who gets the trace header from the allow list', () => {
        const { client } = make({ tracePropagationTargets: ['api.example.com', /^https:\/\/other\.test\//] });

        expect(client.shouldPropagate('https://api.example.com/v1/x')).toBe(true);
        expect(client.shouldPropagate('https://other.test/y')).toBe(true);
        expect(client.shouldPropagate('https://third-party.com/z')).toBe(false);
    });
});
