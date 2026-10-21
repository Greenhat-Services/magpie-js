// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClient, init, type MagpieEvent, type Payload, renameActiveTransaction, startNavigation, type TransactionEvent, type Transport } from '../src';

class FakeTransport implements Transport {
    payloads: Payload[] = [];
    async send(payload: Payload) {
        this.payloads.push(payload);

        return { ok: true, status: 200 };
    }
    get transactions() {
        return this.payloads.filter((p) => (p as TransactionEvent).type === 'transaction') as TransactionEvent[];
    }
    get events() {
        return this.payloads.filter((p) => (p as TransactionEvent).type !== 'transaction') as MagpieEvent[];
    }
}

const ORIGIN = 1_760_000_000_000; // ms
let transport: FakeTransport;

function stubPerformance() {
    Object.defineProperty(performance, 'timeOrigin', { value: ORIGIN, configurable: true });
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(((type: string) => {
        if (type === 'navigation') {
            return [{ domainLookupStart: 2, domainLookupEnd: 12, connectStart: 12, connectEnd: 40, requestStart: 41, responseStart: 120, responseEnd: 150, domContentLoadedEventEnd: 300, loadEventEnd: 420 }];
        }
        if (type === 'resource') {
            return [
                { name: 'http://localhost:3000/assets/app.js?v=1', initiatorType: 'script', startTime: 160, responseEnd: 260 },
                { name: 'http://localhost:3000/api/slots', initiatorType: 'fetch', startTime: 300, responseEnd: 360 },
            ];
        }

        return [];
    }) as never);
    vi.spyOn(performance, 'getEntriesByName').mockImplementation(((name: string) => (name === 'first-contentful-paint' ? [{ startTime: 180 }] : [])) as never);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(ORIGIN + 500);
    transport = new FakeTransport();
    stubPerformance();
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    document.head.innerHTML = '';
});

afterEach(async () => {
    await getClient()?.close(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const start = (options: Record<string, unknown> = {}) => init({ transport, tracesSampleRate: 1, release: 'web@1.0.0', breadcrumbs: false, captureUnhandled: false, ...options })!;

describe('page load tracing', () => {
    it('measures the page load and sends it once the page is quiet, back-dated to the last activity', async () => {
        const client = start();

        expect(client.activeTransaction).toMatchObject({ name: '/', op: 'pageload', sampled: true });
        await vi.advanceTimersByTimeAsync(1100);
        await client.flush();

        const [tx] = transport.transactions;
        expect(tx).toMatchObject({ type: 'transaction', transaction: '/', release: 'web@1.0.0' });
        expect(tx.contexts?.trace).toMatchObject({ op: 'pageload', status: 'ok' });
        expect(tx.start_timestamp).toBe(ORIGIN / 1000);
        expect(client.activeTransaction).toBeUndefined();
    });

    it('turns the browser timings into spans', async () => {
        const client = start();
        await vi.advanceTimersByTimeAsync(1100);
        await client.flush();

        const spans = transport.transactions[0].spans;
        expect(spans.map((s) => `${s.op}: ${s.description}`)).toEqual([
            'browser.dns: DNS lookup',
            'browser.connect: Connection',
            'browser.request: Waiting for the first byte',
            'browser.response: Downloading the document',
            'browser.dom: Building the page',
            'browser.load: Loading everything else',
            'ui.paint: first-contentful-paint',
            'resource.script: http://localhost:3000/assets/app.js',
        ]);
        const request = spans.find((s) => s.op === 'browser.request')!;
        expect(request.start_timestamp).toBeCloseTo((ORIGIN + 41) / 1000, 3);
        expect(request.timestamp).toBeCloseTo((ORIGIN + 120) / 1000, 3);
    });

    it('stays open while a request is in flight', async () => {
        const client = start();
        const idle = await import('../src/idle');
        const tx = client.activeTransaction!;

        idle.idleFor(tx)!.requestStarted();
        await vi.advanceTimersByTimeAsync(5000);
        expect(transport.transactions).toHaveLength(0);

        idle.idleFor(tx)!.requestFinished();
        await vi.advanceTimersByTimeAsync(1100);
        await client.flush();
        expect(transport.transactions).toHaveLength(1);
    });

    it('ends at the deadline, and neither that nor leaving the tab counts as a failure', async () => {
        const slow = start({ tracing: { maxDuration: 3000 } });
        const idle = await import('../src/idle');
        idle.idleFor(slow.activeTransaction!)!.requestStarted(); // never finishes

        await vi.advanceTimersByTimeAsync(3100);
        await slow.flush();
        expect(transport.transactions[0].contexts?.trace?.status).toBe('ok');

        const hidden = start();
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        await hidden.flush();
        expect(transport.transactions).toHaveLength(2);
        expect(transport.transactions[1].contexts?.trace?.status).toBe('ok');
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });

    it('does nothing when tracing is off', async () => {
        const client = start({ tracesSampleRate: 0 });

        expect(client.activeTransaction).toBeUndefined();
        await vi.advanceTimersByTimeAsync(2000);
        expect(transport.transactions).toHaveLength(0);
    });

    it('continues a trace the server rendered into the page', async () => {
        const meta = document.createElement('meta');
        meta.name = 'magpie-trace';
        meta.content = `${'e'.repeat(32)}-${'f'.repeat(16)}-1`;
        document.head.append(meta);

        // The server already decided to sample this trace, which wins over the browser's own (tiny) rate.
        const client = start({ tracesSampleRate: 0.0001 });
        await vi.advanceTimersByTimeAsync(1100);
        await client.flush();

        expect(transport.transactions[0].contexts?.trace).toMatchObject({ trace_id: 'e'.repeat(32), parent_span_id: 'f'.repeat(16) });
    });
});

describe('navigation', () => {
    it('ends the page load it interrupts and times the route change under its pattern', async () => {
        const client = start();

        const nav = startNavigation(client, '/users/:id');
        expect(nav).toMatchObject({ name: '/users/:id', op: 'navigation' });
        expect(client.scope.transactionName).toBe('/users/:id');

        await vi.advanceTimersByTimeAsync(1100);
        await client.flush();

        expect(transport.transactions.map((t) => [t.transaction, t.contexts?.trace?.op])).toEqual([
            ['/', 'pageload'],
            ['/users/:id', 'navigation'],
        ]);
    });

    it('lets a router rename the page load from the address to the route pattern', async () => {
        const client = start();

        renameActiveTransaction(client, '/users/:id');
        await vi.advanceTimersByTimeAsync(1100);
        await client.flush();

        expect(transport.transactions[0].transaction).toBe('/users/:id');
    });

    it('tags errors with the route they happened on', async () => {
        const client = start();
        startNavigation(client, '/checkout');

        client.captureMessage('payment failed');
        await client.flush();

        expect(transport.events[0].transaction).toBe('/checkout');
    });
});

describe('init', () => {
    it('describes the browser and page on every event', async () => {
        const client = start({ tracesSampleRate: 0 });
        client.captureMessage('hello');
        await client.flush();

        const event = transport.events[0];
        expect(event.platform).toBe('javascript');
        expect(event.sdk.name).toBe('magpie.javascript.browser');
        expect(event.request).toMatchObject({ url: 'http://localhost:3000/', headers: { 'User-Agent': expect.any(String) } });
        expect(event.contexts?.browser).toBeDefined();
        expect(event.contexts?.os).toBeDefined();
        expect(event.request?.headers?.Referer).toBeUndefined();
    });

    it('replaces the previous client instead of doubling every handler', () => {
        const first = start();
        const second = start();

        expect(getClient()).toBe(second);
        expect(getClient()).not.toBe(first);
    });

    it('takes the release a build injected when none is passed', async () => {
        (globalThis as { __MAGPIE_RELEASE__?: string }).__MAGPIE_RELEASE__ = 'built-abc123';
        const client = init({ transport, breadcrumbs: false, captureUnhandled: false })!;
        client.captureMessage('x');
        await client.flush();

        expect(transport.events[0].release).toBe('built-abc123');
        delete (globalThis as { __MAGPIE_RELEASE__?: string }).__MAGPIE_RELEASE__;
    });
});
