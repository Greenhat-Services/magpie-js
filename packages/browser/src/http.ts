import { type Client, formatTraceHeader, type Integration, scrubUrl, TRACE_HEADER, type Span } from '@greenhat-services/magpie-core';
import { idleFor } from './idle';

interface RequestInfo {
    method: string;
    url: string;
}

/**
 * Times `fetch` and `XMLHttpRequest`. Each request becomes a breadcrumb (so the issue shows what the page was
 * fetching), a span of the active page load or navigation, and, when tracing is on, carries the `magpie-trace` header
 * so the backend (the Laravel SDK, or the Nitro server) continues the same trace.
 *
 * Requests to Magpie itself are skipped, so delivering an event can never create more events.
 */
export function httpIntegration(): Integration {
    return {
        name: 'Http',
        setup(client: Client) {
            if (typeof window === 'undefined') return;

            const restore: Array<() => void> = [];
            const skip = (url: string) => !!client.dsn && absolute(url).startsWith(client.dsn.origin);

            // ---- fetch
            if (typeof window.fetch === 'function') {
                const original = window.fetch;

                window.fetch = function patchedFetch(this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit) {
                    const info = describe(input, init);
                    if (skip(info.url)) return original.call(this, input, init);

                    const call = begin(client, info);
                    let args: [Parameters<typeof fetch>[0], RequestInit | undefined] = [input, init];

                    if (call.header) {
                        const headers = new Headers(init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
                        if (!headers.has(TRACE_HEADER)) headers.set(TRACE_HEADER, call.header);
                        args = [input, { ...init, headers }];
                    }

                    return original.apply(this, args).then(
                        (response) => {
                            call.finish(response.status);

                            return response;
                        },
                        (error) => {
                            call.finish(0);
                            throw error;
                        },
                    );
                } as typeof fetch;

                restore.push(() => {
                    window.fetch = original;
                });
            }

            // ---- XMLHttpRequest
            if (typeof XMLHttpRequest !== 'undefined') {
                const proto = XMLHttpRequest.prototype;
                const open = proto.open;
                const send = proto.send;
                const state = new WeakMap<XMLHttpRequest, RequestInfo>();

                proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
                    state.set(this, { method: String(method).toUpperCase(), url: String(url) });

                    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
                } as typeof proto.open;

                proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
                    const info = state.get(this);
                    if (info && !skip(info.url)) {
                        const call = begin(client, info);
                        if (call.header) {
                            try {
                                this.setRequestHeader(TRACE_HEADER, call.header);
                            } catch {
                                // Headers cannot be set once the request is sent; the trace just continues without it.
                            }
                        }
                        this.addEventListener('loadend', () => call.finish(this.status));
                    }

                    return send.call(this, body);
                };

                restore.push(() => {
                    proto.open = open;
                    proto.send = send;
                });
            }

            return () => restore.forEach((r) => r());
        },
    };
}

/** Starts the breadcrumb timer, the span and the trace header for one request. */
function begin(client: Client, info: RequestInfo): { header: string | undefined; finish: (status: number) => void } {
    const started = performance.now();
    const parent = client.activeTransaction;
    const idle = parent ? idleFor(parent) : undefined;
    const tracing = (client.options.tracesSampleRate ?? 0) > 0 && parent !== undefined;

    let span: Span | undefined;
    if (parent?.sampled) {
        span = parent.startChild({ op: 'http.client', description: `${info.method} ${stripQuery(info.url)}`, data: { method: info.method } });
        idle?.requestStarted();
    } else if (parent) {
        idle?.requestStarted();
    }

    // The header names the request's own span, so the server's transaction is its child. Sent to same-origin
    // requests, and to the hosts listed in `tracePropagationTargets`, so third parties never see it.
    const target = absolute(info.url);
    const header = tracing && parent && (sameOrigin(target) || client.shouldPropagate(target))
        ? formatTraceHeader(parent.traceId, span?.spanId ?? parent.spanId, parent.sampled)
        : undefined;

    return {
        header,
        finish(status) {
            const duration = Math.round(performance.now() - started);
            const failed = status === 0 || status >= 400;

            if (span) {
                if (status) span.setData('status_code', status);
                span.setStatus(status === 0 ? 'unknown_error' : status >= 500 ? 'internal_error' : 'ok');
                span.end();
            }
            if (parent) idle?.requestFinished();

            client.addBreadcrumb({
                category: 'http',
                type: 'http',
                level: status >= 500 || status === 0 ? 'error' : failed ? 'warning' : 'info',
                message: `${info.method} ${scrubUrl(info.url)}`,
                data: { method: info.method, ...(status ? { status_code: status } : { status_code: 'failed' }), duration_ms: duration },
            });
        },
    };
}

function describe(input: Parameters<typeof fetch>[0], init?: RequestInit): RequestInfo {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : isRequest ? (input as Request).url : String(input);

    return { method: (init?.method ?? (isRequest ? (input as Request).method : 'GET')).toUpperCase(), url };
}

function absolute(url: string): string {
    try {
        return new URL(url, location.href).href;
    } catch {
        return url;
    }
}

function sameOrigin(absoluteUrl: string): boolean {
    try {
        return new URL(absoluteUrl).origin === location.origin;
    } catch {
        return false;
    }
}

/** A request's span is named by its path: the query string would make every call a different description. */
function stripQuery(url: string): string {
    return scrubUrl(url).split(/[?#]/)[0];
}
