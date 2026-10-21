// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clickBreadcrumbs,
    Client,
    consoleBreadcrumbs,
    describeElement,
    globalHandlers,
    historyBreadcrumbs,
    httpIntegration,
    type Integration,
    type MagpieEvent,
    type Payload,
    type Transport,
    type TransactionEvent,
} from '../src';
import { browserRuntime } from '../src/runtime';

class FakeTransport implements Transport {
    payloads: Payload[] = [];
    async send(payload: Payload) {
        this.payloads.push(payload);

        return { ok: true, status: 200 };
    }
    get events() {
        return this.payloads.filter((p) => (p as TransactionEvent).type !== 'transaction') as MagpieEvent[];
    }
}

function start(integrations: Integration[], options: Record<string, unknown> = {}) {
    const transport = new FakeTransport();
    const client = new Client({ transport, release: 'web@1.0.0', maxEventsPerMinute: 100, ...options }, browserRuntime());
    client.setupIntegrations(integrations);

    return { client, transport };
}

let clients: Client[] = [];
afterEach(async () => {
    for (const c of clients) await c.close(0);
    clients = [];
    document.body.innerHTML = '';
});
const track = <T extends { client: Client }>(t: T) => (clients.push(t.client), t);

describe('globalHandlers', () => {
    it('reports an uncaught error as unhandled, with the stack frames the browser gave', async () => {
        const { client, transport } = track(start([globalHandlers()]));
        const error = new TypeError("Cannot read properties of null (reading 'venue')");
        error.stack = `TypeError: Cannot read properties of null (reading 'venue')\n    at load (https://app.example.com/assets/app-3f2a1.js:1:48213)`;

        window.dispatchEvent(new ErrorEvent('error', { error, message: error.message, filename: 'https://app.example.com/assets/app-3f2a1.js', lineno: 1, colno: 48213 }));
        await client.flush();

        const value = transport.events[0].exception!.values[0];
        expect(value).toMatchObject({ type: 'TypeError', mechanism: { type: 'onerror', handled: false } });
        expect(value.stacktrace!.frames[0]).toMatchObject({ filename: 'https://app.example.com/assets/app-3f2a1.js', lineno: 1, colno: 48213 });
    });

    it('reports an unhandled promise rejection, whether it is an Error or not', async () => {
        const { client, transport } = track(start([globalHandlers()]));

        window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('request failed') }));
        window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'plain rejection' }));
        await client.flush();

        expect(transport.events.map((e) => e.exception!.values[0].value)).toEqual(['request failed', 'plain rejection']);
        expect(transport.events[0].exception!.values[0].mechanism).toEqual({ type: 'onunhandledrejection', handled: false });
    });

    it('points a syntax-style error with no Error object at the file and line', async () => {
        const { client, transport } = track(start([globalHandlers()]));

        window.dispatchEvent(new ErrorEvent('error', { message: 'SyntaxError: Unexpected token', filename: 'https://app.example.com/app.js', lineno: 3, colno: 9 }));
        await client.flush();

        const value = transport.events[0].exception!.values[0];
        expect(value.type).toBe('SyntaxError');
        expect(value.stacktrace!.frames[0]).toMatchObject({ filename: 'https://app.example.com/app.js', lineno: 3, colno: 9 });
    });

    it('ignores the empty "Script error." from a cross-origin script, and a failed image becomes a breadcrumb', async () => {
        const { client, transport } = track(start([globalHandlers()]));

        window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
        const img = document.createElement('img');
        img.src = 'https://cdn.example.com/missing.png';
        document.body.append(img);
        img.dispatchEvent(new Event('error'));

        client.captureMessage('after');
        await client.flush();

        expect(transport.events).toHaveLength(1);
        expect(transport.events[0].breadcrumbs?.[0]).toMatchObject({ category: 'resource', message: expect.stringContaining('missing.png') });
    });

    it('stops listening once the client is closed', async () => {
        const { client } = start([globalHandlers()]);
        const remove = vi.spyOn(window, 'removeEventListener');

        await client.close(0);

        expect(remove.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['error', 'unhandledrejection']));
        remove.mockRestore();
    });
});

describe('breadcrumbs', () => {
    it('records console calls with their level, and still calls the original', async () => {
        const original = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { client, transport } = track(start([consoleBreadcrumbs()]));

        console.warn('slot almost full', { slot: 4 });
        client.captureMessage('x');
        await client.flush();

        expect(original).toHaveBeenCalledWith('slot almost full', { slot: 4 });
        expect(transport.events[0].breadcrumbs?.[0]).toMatchObject({ category: 'log', level: 'warning', message: 'slot almost full {"slot":4}' });
        await client.close(0);
        original.mockRestore();
    });

    it('records a click as the element, never its text', async () => {
        document.body.innerHTML = '<form id="checkout"><button type="button" class="primary big" data-testid="pay">Pay Jo Smith 4111</button></form>';
        const { client, transport } = track(start([clickBreadcrumbs()]));

        document.querySelector('button')!.click();
        client.captureMessage('x');
        await client.flush();

        const crumb = transport.events[0].breadcrumbs![0];
        expect(crumb.category).toBe('ui.click');
        expect(crumb.message).toBe('form#checkout > button.primary.big[data-testid=pay]');
        expect(JSON.stringify(transport.events[0])).not.toContain('Jo Smith');
    });

    it('describes at most three levels and stops at an id', () => {
        document.body.innerHTML = '<div class="a"><section id="main"><div class="b"><ul><li><a class="c">x</a></li></ul></div></section></div>';

        expect(describeElement(document.querySelector('a')!)).toBe('div.b > ul > li > a.c'.split(' > ').slice(-3).join(' > '));
        expect(describeElement(document.querySelector('section')!)).toBe('section#main');
    });

    it('records navigation with query tokens scrubbed', async () => {
        const { client, transport } = track(start([historyBreadcrumbs()]));

        history.pushState({}, '', '/settings?tab=billing&token=abc');
        client.captureMessage('x');
        await client.flush();

        const crumb = transport.events[0].breadcrumbs![0];
        expect(crumb.category).toBe('navigation');
        expect(crumb.data).toMatchObject({ to: expect.stringContaining('/settings?tab=billing&token=%5BFiltered%5D') });
        expect(JSON.stringify(crumb)).not.toContain('abc');
        await client.close(0);
        history.replaceState({}, '', '/');
    });
});

describe('httpIntegration', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    let original: typeof fetch;

    beforeEach(() => {
        original = window.fetch;
        fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
        window.fetch = fetchMock as unknown as typeof fetch;
    });
    afterEach(() => {
        window.fetch = original;
    });

    const headersOf = (call: unknown[]) => (call[1] as RequestInit | undefined)?.headers as Headers | undefined;

    it('records each request as a breadcrumb with its status and timing, tokens scrubbed', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
        const { client, transport } = track(start([httpIntegration()], { dsn: 'https://k@ingest.test/1' }));

        await window.fetch('/api/slots?token=abc');
        client.captureMessage('x');
        await client.flush();

        const crumb = transport.events[0].breadcrumbs![0];
        expect(crumb).toMatchObject({ category: 'http', level: 'error', message: 'GET /api/slots?token=%5BFiltered%5D', data: { method: 'GET', status_code: 503 } });
        expect(crumb.data!.duration_ms).toBeTypeOf('number');
    });

    it('records a network failure and rethrows it', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const { client, transport } = track(start([httpIntegration()]));

        await expect(window.fetch('/api/x')).rejects.toThrow('Failed to fetch');
        client.captureMessage('x');
        await client.flush();

        expect(transport.events[0].breadcrumbs![0]).toMatchObject({ level: 'error', data: { status_code: 'failed' } });
    });

    it('puts the trace header on same-origin requests and on listed hosts, and on nobody else', async () => {
        const { client } = track(start([httpIntegration()], { tracesSampleRate: 1, tracePropagationTargets: ['api.example.com'] }));
        const tx = client.startTransaction({ name: '/home', op: 'pageload' });
        client.activeTransaction = tx;

        await window.fetch('/api/mine');
        await window.fetch('https://api.example.com/v1/x');
        await window.fetch('https://third-party.com/pixel');

        const header = headersOf(fetchMock.mock.calls[0])!.get('magpie-trace')!;
        expect(header).toMatch(new RegExp(`^${tx.traceId}-[0-9a-f]{16}-1$`));
        expect(headersOf(fetchMock.mock.calls[1])!.get('magpie-trace')).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1$/);
        expect(headersOf(fetchMock.mock.calls[2])?.get('magpie-trace') ?? null).toBeNull();
    });

    it('makes each request its own span, and the header names that span', async () => {
        const { client } = track(start([httpIntegration()], { tracesSampleRate: 1 }));
        const tx = client.startTransaction({ name: '/home', op: 'pageload' });
        client.activeTransaction = tx;

        await window.fetch('/api/slots?page=2');

        const span = tx.spans[0];
        expect(span).toMatchObject({ op: 'http.client', description: 'GET /api/slots' });
        expect(span.data).toMatchObject({ method: 'GET', status_code: 200 });
        expect(headersOf(fetchMock.mock.calls[0])!.get('magpie-trace')).toContain(`-${span.spanId}-`);
    });

    it('sends no header when tracing is off, so the backend decides for itself', async () => {
        track(start([httpIntegration()]));

        await window.fetch('/api/x');

        expect(headersOf(fetchMock.mock.calls[0])?.get('magpie-trace') ?? null).toBeNull();
    });

    it('keeps the headers the caller set, and works with a Request object', async () => {
        const { client } = track(start([httpIntegration()], { tracesSampleRate: 1 }));
        client.activeTransaction = client.startTransaction({ name: '/home' });

        await window.fetch('/api/x', { headers: { Authorization: 'Bearer t', 'X-Other': '1' } });
        await window.fetch(new Request('http://localhost:3000/api/y', { headers: { 'X-Req': '2' } }));

        const first = headersOf(fetchMock.mock.calls[0])!;
        expect([first.get('authorization'), first.get('x-other'), first.has('magpie-trace')]).toEqual(['Bearer t', '1', true]);
        const second = headersOf(fetchMock.mock.calls[1])!;
        expect([second.get('x-req'), second.has('magpie-trace')]).toEqual(['2', true]);
    });

    it('leaves requests to Magpie itself alone', async () => {
        const { client } = track(start([httpIntegration()], { dsn: 'https://k@ingest.test/1', tracesSampleRate: 1 }));
        client.activeTransaction = client.startTransaction({ name: '/home' });

        await window.fetch('https://ingest.test/api/1/events?magpie_key=k');

        expect(fetchMock.mock.calls[0]).toHaveLength(2);
        expect(headersOf(fetchMock.mock.calls[0])).toBeUndefined();
        expect(client.activeTransaction.spans).toHaveLength(0);
    });

    describe('an API whose CORS policy refuses the trace header', () => {
        // The browser rejects the whole request with a TypeError when the preflight does not allow a header.
        const refusing = (host: string) => {
            fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
                if (String(input).includes(host) && new Headers(init?.headers).has('magpie-trace')) throw new TypeError('Failed to fetch');

                return new Response('{}', { status: 200 });
            });
        };
        const sentHeader = (call: number) => new Headers(((fetchMock.mock.calls[call] as unknown[])[1] as RequestInit | undefined)?.headers).has('magpie-trace');

        const start2 = (host: string) => {
            const { client } = track(start([httpIntegration()], { tracesSampleRate: 1, tracePropagationTargets: [host], debug: true }));
            client.activeTransaction = client.startTransaction({ name: '/home' });

            return client;
        };

        it('retries a GET once without the header so the app still gets its response, and remembers the host', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            refusing('strict-get.example.com');
            start2('strict-get.example.com');

            const response = await window.fetch('https://strict-get.example.com/data');
            expect(response.status).toBe(200);
            expect([sentHeader(0), sentHeader(1)]).toEqual([true, false]);

            await window.fetch('https://strict-get.example.com/more');
            expect(sentHeader(2)).toBe(false);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('strict-get.example.com rejected the magpie-trace header'));
            warn.mockRestore();
        });

        it('does not repeat a POST, which could happen twice, but stops sending the header to that host', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            refusing('strict-post.example.com');
            start2('strict-post.example.com');

            await expect(window.fetch('https://strict-post.example.com/orders', { method: 'POST', body: '{}' })).rejects.toThrow('Failed to fetch');
            expect(fetchMock).toHaveBeenCalledTimes(1);

            const next = await window.fetch('https://strict-post.example.com/orders', { method: 'POST', body: '{}' });
            expect(next.status).toBe(200);
            expect(sentHeader(1)).toBe(false);
        });

        it('leaves a same-origin failure alone: that is the network, not CORS', async () => {
            fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
            start2('ignored.example.com');

            await expect(window.fetch('/api/x')).rejects.toThrow('Failed to fetch');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });
    it('restores fetch when the client is closed', async () => {
        const { client } = start([httpIntegration()]);
        const patched = window.fetch;

        await client.close(0);

        expect(window.fetch).toBe(fetchMock);
        expect(patched).not.toBe(fetchMock);
    });
});
