import { type Client, type Integration, parseTraceHeader, type Transaction } from '@greenhat-services/magpie-core';
import { idleFor, trackIdle } from './idle';

export interface TracingOptions {
    /** Trace the first page load. Default true. */
    pageload?: boolean;
    /** Also start a navigation transaction on every history change. Off by default: without a router the path is the
     *  only name there is, and `/users/7` and `/users/8` would be two transactions. Use the Vue router integration. */
    history?: boolean;
    /** Quiet time, in ms, that ends a page load or navigation. Default 1000. */
    idleTimeout?: number;
    /** The longest a page load or navigation may stay open, in ms. Default 15000. */
    maxDuration?: number;
}

const DEFAULTS = { pageload: true, history: false, idleTimeout: 1000, maxDuration: 15_000 };

/** The settings each client was started with, for `startNavigation` to reuse. */
const settings = new WeakMap<Client, Required<TracingOptions>>();

/**
 * Page loads and route changes as transactions. A page load starts at the browser's own time origin and ends when the
 * page is quiet; its spans are the browser's navigation timings (DNS, connect, request, response, DOM, load), the
 * scripts and styles it fetched, and the paint milestones. Every `fetch` and XHR in between becomes a span too.
 */
export function tracingIntegration(options: TracingOptions = {}): Integration {
    return {
        name: 'Tracing',
        setup(client: Client) {
            if (typeof window === 'undefined' || !((client.options.tracesSampleRate ?? 0) > 0)) return;

            const config = { ...DEFAULTS, ...options };
            settings.set(client, config);
            const teardown: Array<() => void> = [];

            if (config.pageload) startPageload(client, config);

            if (config.history) {
                const onChange = () => startNavigation(client, location.pathname);
                window.addEventListener('popstate', onChange);
                teardown.push(() => window.removeEventListener('popstate', onChange));
            }

            return () => {
                idleFor(client.activeTransaction as Transaction)?.finish();
                teardown.forEach((t) => t());
            };
        },
    };
}

/** Begins timing a route change under `name` (use the route pattern, `/users/:id`, not the address). */
export function startNavigation(client: Client, name: string): Transaction | undefined {
    const config = settings.get(client);
    if (!config) return undefined;

    // A navigation that begins while the previous one is still open ends it: the person has moved on.
    if (client.activeTransaction) idleFor(client.activeTransaction)?.finish();

    const tx = client.startTransaction({ name, op: 'navigation' });
    client.activeTransaction = tx;
    client.scope.setTransactionName(name);
    trackIdle(tx, {
        idleTimeout: config.idleTimeout,
        maxDuration: config.maxDuration,
        onEnd: (ended) => {
            if (client.activeTransaction === ended) client.activeTransaction = undefined;
        },
    });

    return tx;
}

/** Renames the page load or navigation in progress, which is how a router swaps `/users/7` for `/users/:id`. */
export function renameActiveTransaction(client: Client, name: string): void {
    client.activeTransaction?.setName(name);
    client.scope.setTransactionName(name);
}

function startPageload(client: Client, config: Required<TracingOptions>): void {
    // A server that rendered this page can hand over its trace in <meta name="magpie-trace">, so the server's work and
    // the browser's load are one trace.
    const meta = document.querySelector('meta[name="magpie-trace"]')?.getAttribute('content');
    const parent = parseTraceHeader(meta);

    const tx = client.startTransaction({
        name: location.pathname,
        op: 'pageload',
        startTimestamp: performance.timeOrigin / 1000,
        ...(parent ? { traceId: parent.traceId, parentSpanId: parent.spanId, sampled: parent.sampled } : {}),
    });
    client.activeTransaction = tx;
    client.scope.setTransactionName(tx.name);

    const lcp = observeLargestPaint();

    trackIdle(tx, {
        idleTimeout: config.idleTimeout,
        maxDuration: config.maxDuration,
        waitForLoad: true,
        beforeEnd: (t) => addPageloadSpans(client, t, lcp()),
        onEnd: (ended) => {
            if (client.activeTransaction === ended) client.activeTransaction = undefined;
        },
    });
}

/** The most recent largest-contentful-paint time, in ms from the time origin. */
function observeLargestPaint(): () => number | undefined {
    let value: number | undefined;

    try {
        const observer = new PerformanceObserver((list) => {
            const last = list.getEntries().at(-1);
            if (last) value = last.startTime;
        });
        observer.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
        // Not every browser reports it.
    }

    return () => value;
}

function addPageloadSpans(client: Client, tx: Transaction, lcp: number | undefined): void {
    if (!tx.sampled) return;

    try {
        const origin = performance.timeOrigin;
        const at = (ms: number) => (origin + ms) / 1000;
        const add = (op: string, description: string, from: number, to: number) => {
            if (!(to > from) && !(op === 'ui.paint' && to === from)) return;
            const span = tx.startChild({ op, description, startTimestamp: at(from) });
            span.end(at(to));
        };

        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (nav) {
            add('browser.dns', 'DNS lookup', nav.domainLookupStart, nav.domainLookupEnd);
            add('browser.connect', 'Connection', nav.connectStart, nav.connectEnd);
            add('browser.request', 'Waiting for the first byte', nav.requestStart, nav.responseStart);
            add('browser.response', 'Downloading the document', nav.responseStart, nav.responseEnd);
            add('browser.dom', 'Building the page', nav.responseEnd, nav.domContentLoadedEventEnd);
            add('browser.load', 'Loading everything else', nav.domContentLoadedEventEnd, nav.loadEventEnd);
        }

        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        if (fcp) add('ui.paint', 'first-contentful-paint', fcp.startTime, fcp.startTime);
        if (lcp !== undefined) add('ui.paint', 'largest-contentful-paint', lcp, lcp);

        // Scripts, styles and images the page fetched. Requests made by fetch and XHR already have their own spans.
        const ingest = client.dsn?.origin;
        performance
            .getEntriesByType('resource')
            .filter((r) => {
                const entry = r as PerformanceResourceTiming;

                return ['script', 'link', 'css', 'img'].includes(entry.initiatorType) && entry.responseEnd > 0 && !(ingest && entry.name.startsWith(ingest));
            })
            .slice(0, 25)
            .forEach((r) => {
                const entry = r as PerformanceResourceTiming;
                add(`resource.${entry.initiatorType}`, entry.name.split(/[?#]/)[0], entry.startTime, entry.responseEnd);
            });
    } catch {
        // Timing APIs are best effort: a page load without spans is still a page load.
    }
}
