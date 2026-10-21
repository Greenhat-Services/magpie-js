// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { getClient, init, type MagpieEvent, type Payload, routeName, type TransactionEvent, type Transport } from '../src';

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
let mountEl: HTMLElement;

beforeEach(() => {
    transport = new FakeTransport();
    mountEl = document.createElement('div');
    document.body.append(mountEl);
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    await getClient()?.close(0);
    mountEl.remove();
    vi.restoreAllMocks();
});

// A function, because the transport is created fresh in beforeEach, after this module loads.
const base = () => ({ transport, release: 'web@1.0.0', breadcrumbs: false, captureUnhandled: false, maxEventsPerMinute: 100 });

const Throwing = defineComponent({
    name: 'SlotPicker',
    props: { secret: { type: String, default: 'card-4111-1111' } },
    setup() {
        throw new Error('setup exploded');
    },
    render: () => null,
});

describe('Vue error handler', () => {
    it('reports an error from a component with the component, the lifecycle step and where it sits in the tree', async () => {
        const Parent = defineComponent({ name: 'BookingPage', render: () => h(Throwing, { secret: 'card-4111-1111' }) });
        const app = createApp(defineComponent({ name: 'App', render: () => h(Parent) }));
        const client = init({ ...base(), app })!;

        app.mount(mountEl);
        await client.flush();

        const event = transport.events[0];
        expect(event.sdk.name).toBe('magpie.javascript.vue');
        expect(event.exception!.values[0]).toMatchObject({ type: 'Error', value: 'setup exploded', mechanism: { type: 'vue', handled: false } });
        expect(event.contexts?.vue).toMatchObject({ componentName: 'SlotPicker', lifecycleHook: 'setup function', hierarchy: 'SlotPicker > BookingPage > App' });
        expect(event.tags).toEqual({ 'vue.component': 'SlotPicker' });
    });

    it('never sends props or state, which can hold personal data', async () => {
        const app = createApp(defineComponent({ render: () => h(Throwing, { secret: 'card-4111-1111' }) }));
        const client = init({ ...base(), app })!;

        app.mount(mountEl);
        await client.flush();

        expect(JSON.stringify(transport.events[0])).not.toContain('card-4111-1111');
    });

    it('reports an error thrown in an event handler', async () => {
        const Clicker = defineComponent({
            name: 'PayButton',
            render: () =>
                h('button', {
                    type: 'button',
                    onClick() {
                        throw new Error('click exploded');
                    },
                }),
        });
        const app = createApp(Clicker);
        const client = init({ ...base(), app })!;
        app.mount(mountEl);

        mountEl.querySelector('button')!.click();
        await client.flush();

        expect(transport.events[0].exception!.values[0].value).toBe('click exploded');
        expect(transport.events[0].contexts?.vue).toMatchObject({ componentName: 'PayButton', lifecycleHook: 'native event handler' });
    });

    it('keeps the handler the app already had', async () => {
        const previous = vi.fn();
        const app = createApp(Throwing);
        app.config.errorHandler = previous;
        const client = init({ ...base(), app })!;

        app.mount(mountEl);
        await client.flush();

        expect(previous).toHaveBeenCalledTimes(1);
        expect(previous.mock.calls[0][0]).toMatchObject({ message: 'setup exploded' });
        expect(transport.events).toHaveLength(1);
    });

    it('still logs to the console when the app had no handler, since Vue stops doing that once one is set', async () => {
        const app = createApp(Throwing);
        const client = init({ ...base(), app })!;

        app.mount(mountEl);
        await client.flush();

        expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'setup exploded' }));
    });

    it('does not break the app when reporting itself fails', async () => {
        const app = createApp(Throwing);
        const client = init({ ...base(), app, beforeSend: () => { throw new Error('hook failure'); } })!;

        expect(() => app.mount(mountEl)).not.toThrow();
        await client.flush();
        expect(console.error).toHaveBeenCalled();
    });
});

describe('routerTracing', () => {
    const Page = defineComponent({ render: () => h('div') });
    const makeRouter = () =>
        createRouter({
            history: createMemoryHistory(),
            routes: [
                { path: '/', component: Page },
                { path: '/users/:id', name: 'user', component: Page },
                { path: '/lazy', component: () => Promise.reject(new Error('Failed to fetch dynamically imported module')) },
            ],
        });

    it('names the page load by its route pattern, and each later navigation as its own transaction', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const router = makeRouter();
        const client = init({ ...base(), tracesSampleRate: 1, router })!;

        await router.push('/users/7');
        await router.push('/users/8');
        await vi.advanceTimersByTimeAsync(1500);
        await client.flush();
        vi.useRealTimers();

        expect(transport.transactions.map((t) => [t.transaction, t.contexts?.trace?.op, t.contexts?.trace?.status])).toEqual([
            ['/users/:id', 'pageload', 'ok'],
            ['/users/:id', 'navigation', 'ok'],
        ]);
        expect(client.scope.transactionName).toBe('/users/:id');
    });

    it('tags errors with the route they happened on', async () => {
        const router = makeRouter();
        const client = init({ ...base(), tracesSampleRate: 1, router })!;

        await router.push('/users/7');
        client.captureMessage('on the user page');
        await client.flush();

        expect(transport.events[0].transaction).toBe('/users/:id');
    });

    it('reports a router error, such as a lazy route that failed to download, as handled', async () => {
        const router = makeRouter();
        const client = init({ ...base(), router })!;

        await router.push('/lazy').catch(() => {});
        await client.flush();

        const value = transport.events[0].exception!.values[0];
        expect(value.value).toBe('Failed to fetch dynamically imported module');
        expect(value.mechanism).toEqual({ type: 'vue-router', handled: true });
    });
});

describe('routeName', () => {
    it('prefers the full pattern, then the route name, then the path', () => {
        expect(routeName({ path: '/users/7', matched: [{ path: '/users' }, { path: '/users/:id' }] })).toBe('/users/:id');
        expect(routeName({ path: '/x', name: 'named', matched: [] })).toBe('named');
        expect(routeName({ path: '/plain', matched: [] })).toBe('/plain');
    });
});
