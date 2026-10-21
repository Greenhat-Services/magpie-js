import { type Client, formatTraceHeader, type Integration, scrubUrl, type Span, TRACE_HEADER } from '@greenhat-services/magpie-core';

/**
 * Times the server's own outgoing `fetch` calls (an API your pages render from). Each becomes a breadcrumb on the
 * current request and, when that request is being traced, a span of it, and carries the `magpie-trace` header so
 * the service on the other end continues the trace: browser, Nuxt server and Laravel API as one.
 *
 * The header goes to every host unless `tracePropagationTargets` lists the ones that should get it.
 */
export function nodeHttp(): Integration {
    return {
        name: 'NodeHttp',
        setup(client: Client) {
            if (typeof globalThis.fetch !== 'function') return;

            const original = globalThis.fetch;
            const skip = (url: string) => !!client.dsn && url.startsWith(client.dsn.origin);

            globalThis.fetch = function patchedFetch(this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit) {
                const isRequest = typeof Request !== 'undefined' && input instanceof Request;
                const url = typeof input === 'string' ? input : input instanceof URL ? input.href : isRequest ? (input as Request).url : String(input);
                const method = (init?.method ?? (isRequest ? (input as Request).method : 'GET')).toUpperCase();

                if (skip(url)) return original.call(this, input, init);

                const tx = client.activeTransaction;
                const started = performance.now();
                let span: Span | undefined;
                if (tx?.sampled) span = tx.startChild({ op: 'http.client', description: `${method} ${scrubUrl(url).split(/[?#]/)[0]}`, data: { method } });

                const propagate = (client.options.tracesSampleRate ?? 0) > 0 && !!tx && (client.options.tracePropagationTargets === undefined || client.shouldPropagate(url));
                let args: [Parameters<typeof fetch>[0], RequestInit | undefined] = [input, init];
                if (propagate && tx) {
                    const headers = new Headers(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
                    if (!headers.has(TRACE_HEADER)) headers.set(TRACE_HEADER, formatTraceHeader(tx.traceId, span?.spanId ?? tx.spanId, tx.sampled));
                    args = [input, { ...init, headers }];
                }

                const finish = (status: number) => {
                    if (span) {
                        if (status) span.setData('status_code', status);
                        span.setStatus(status === 0 ? 'unknown_error' : status >= 500 ? 'internal_error' : 'ok');
                        span.end();
                    }
                    client.addBreadcrumb({
                        category: 'http',
                        type: 'http',
                        level: status >= 500 || status === 0 ? 'error' : status >= 400 ? 'warning' : 'info',
                        message: `${method} ${scrubUrl(url)}`,
                        data: { method, status_code: status || 'failed', duration_ms: Math.round(performance.now() - started) },
                    });
                };

                return original.apply(this, args).then(
                    (response) => {
                        finish(response.status);

                        return response;
                    },
                    (error) => {
                        finish(0);
                        throw error;
                    },
                );
            } as typeof fetch;

            return () => {
                globalThis.fetch = original;
            };
        },
    };
}
