import { captureException, init, trackRequest } from '@greenhat-services/magpie-node';
import type { H3Event } from 'h3';
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime';

/** Files the browser asks for by name. They are not pages, and timing each one would bury the real routes. */
const STATIC_ASSET = /^\/(_nuxt|__nuxt)|\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|txt|xml|json|webmanifest)$/i;

/**
 * Magpie on the Nitro server. Every request runs in its own context (so overlapping requests never share tags or
 * breadcrumbs), is timed as an `http.server` transaction that continues the browser's trace, and has its errors
 * reported with the request attached. Cookies and authorization headers are never sent.
 */
export default defineNitroPlugin((nitroApp) => {
    const config = useRuntimeConfig().public.magpie as import('../types').PublicConfig | undefined;
    if (!config?.dsn || config.server === false) return;

    const client = init({
        dsn: config.dsn,
        environment: config.environment,
        release: config.release,
        tracesSampleRate: config.tracesSampleRate,
        sampleRate: config.sampleRate,
        sendDefaultPii: config.sendDefaultPii,
        debug: config.debug,
        ignoreErrors: config.ignoreErrors,
        tracePropagationTargets: config.tracePropagationTargets,
        sdkName: 'magpie.javascript.nuxt',
        // `nuxt dev` runs the server in a worker that has its own handlers; production owns the process.
        captureUnhandled: !import.meta.dev,
    });

    // Wrap the root handler, which is the one place every request passes through, so the context lives for the whole
    // request including everything awaited inside it.
    const app = nitroApp.h3App as unknown as { handler: (event: H3Event) => Promise<unknown> };
    const original = app.handler;

    app.handler = (event: H3Event) => {
        const e = event;
        if (STATIC_ASSET.test(e.path.split('?')[0])) return original(event);

        return trackRequest(client, { method: e.method, url: e.path, headers: e.node.req.headers }, async ({ transaction, finish }) => {
            e.context.magpieTrace = transaction.traceHeader();
            const route = () => (e.context.magpieRoute as string | undefined) ?? (e.context.matchedRoute as { path?: string } | undefined)?.path?.replace(/^\/\*\*$/, '');

            try {
                const result = await original(event);
                finish(e.node.res.statusCode || 200, route());

                return result;
            } catch (error) {
                finish((error as { statusCode?: number }).statusCode ?? 500, route());
                throw error;
            }
        });
    };

    // A thrown error is reported when it is a server error. A 404 or a validation failure is the app working.
    nitroApp.hooks.hook('error', (error) => {
        const status = (error as { statusCode?: number }).statusCode;
        if (status && status < 500) return;

        captureException(error, { mechanism: { type: 'nitro', handled: false } });
    });

    // Lets the browser's page load continue this server's trace.
    nitroApp.hooks.hook('render:html', (html, { event }) => {
        const header = event.context.magpieTrace as string | undefined;
        if (header) html.head.push(`<meta name="magpie-trace" content="${header}">`);
    });
});

