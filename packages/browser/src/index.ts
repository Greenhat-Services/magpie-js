import {
    Client,
    getClient,
    type Integration,
    type Options,
    setClient,
} from '@greenhat-services/magpie-core';
import { clickBreadcrumbs, consoleBreadcrumbs, historyBreadcrumbs } from './breadcrumbs';
import { globalHandlers } from './globalHandlers';
import { httpIntegration } from './http';
import { browserRuntime } from './runtime';
import { tracingIntegration, type TracingOptions } from './tracing';

export * from '@greenhat-services/magpie-core';
export { clickBreadcrumbs, consoleBreadcrumbs, describeElement, historyBreadcrumbs } from './breadcrumbs';
export { globalHandlers } from './globalHandlers';
export { httpIntegration } from './http';
export { renameActiveTransaction, startNavigation, tracingIntegration, type TracingOptions } from './tracing';
export { fetchTransport } from './transport';
export { parseUserAgent } from './uaparse';

export interface BreadcrumbOptions {
    console?: boolean;
    clicks?: boolean;
    history?: boolean;
    /** Requests made with `fetch` and XMLHttpRequest. */
    http?: boolean;
}

export interface BrowserOptions extends Options {
    /** Report `window.onerror` and unhandled promise rejections. Default true. */
    captureUnhandled?: boolean;
    /** `false` for none, or choose: console, clicks, history and http are all on by default. */
    breadcrumbs?: boolean | BreadcrumbOptions;
    /** Page load and route tracing. On whenever `tracesSampleRate` is above zero; `false` turns it off. */
    tracing?: boolean | TracingOptions;
    /** What this SDK calls itself in events. The framework packages set it. */
    sdkName?: string;
}

/** The release a build script put on the page, for apps that do not pass one. Vite users write `import.meta.env.VITE_MAGPIE_RELEASE`. */
const injectedRelease = (): string | undefined => (globalThis as { __MAGPIE_RELEASE__?: string }).__MAGPIE_RELEASE__;

/**
 * Starts Magpie in the browser. Call it once, as early as you can, before the app mounts. On the server (no `window`)
 * it does nothing and returns undefined, so the same entry file is safe in server-rendered apps.
 */
export function init(options: BrowserOptions = {}): Client | undefined {
    if (typeof window === 'undefined') return undefined;

    // Initialising twice (hot reload, a second entry point) replaces the first client instead of doubling every handler.
    const previous = getClient();
    if (previous) void previous.close(0);

    const { captureUnhandled = true, breadcrumbs = true, tracing, sdkName, integrations = [], ...rest } = options;
    const crumbs: BreadcrumbOptions = breadcrumbs === false ? {} : { console: true, clicks: true, history: true, http: true, ...(breadcrumbs === true ? {} : breadcrumbs) };
    const tracesOn = (rest.tracesSampleRate ?? 0) > 0 && tracing !== false;

    // Taken before the http integration patches it, so delivering an event is never itself traced.
    const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : undefined;

    const client = new Client(
        { ...rest, release: rest.release ?? injectedRelease() },
        browserRuntime({ sendDefaultPii: rest.sendDefaultPii, sdkName, fetch: nativeFetch }),
    );

    const defaults: Integration[] = [
        ...(captureUnhandled ? [globalHandlers()] : []),
        ...(crumbs.console ? [consoleBreadcrumbs()] : []),
        ...(crumbs.clicks ? [clickBreadcrumbs()] : []),
        ...(crumbs.history ? [historyBreadcrumbs()] : []),
        // Request breadcrumbs and spans share one patch, and tracing needs it, so it runs when either is wanted.
        ...(crumbs.http || tracesOn ? [httpIntegration()] : []),
        ...(tracesOn ? [tracingIntegration(typeof tracing === 'object' ? tracing : {})] : []),
    ];

    setClient(client);
    // Tracing runs after http so the page load exists before the first request is made.
    client.scope.setTransactionName(location.pathname);
    client.setupIntegrations([...defaults.filter((i) => i.name !== 'Tracing'), ...defaults.filter((i) => i.name === 'Tracing'), ...integrations]);

    return client;
}
