import { type Client, parseTraceHeader, scrubQuery, TRACE_HEADER, type Transaction } from '@greenhat-services/magpie-core';
import { runWithRequest } from './context';

export interface RequestInfo {
    method: string;
    /** The path (and query string), or a full URL. */
    url: string;
    /** The request's headers, lower-case names. Only a short allow-list of them is ever attached to an event. */
    headers?: Record<string, string | string[] | undefined>;
    /** The matched route pattern (`/users/:id`) when the framework already knows it. */
    route?: string;
}

/** Headers worth having on an event. Everything else, cookies and authorization above all, is dropped, not filtered. */
const SAFE_HEADERS = ['user-agent', 'accept', 'accept-language', 'content-type', 'host', 'referer', 'x-forwarded-proto'];

export interface RequestHandle {
    transaction: Transaction;
    /** Ends the request's transaction. Pass the route pattern when it is only known now, so `/users/7` becomes `/users/:id`. */
    finish(statusCode: number, route?: string): void;
}

/**
 * Runs `fn` as one request: its own scope and transaction, the request attached to every event raised inside it, and a
 * trace that continues the caller's `magpie-trace` header (so a page load in the browser and this server render are one
 * trace). Call `finish` when the response is done.
 */
export function trackRequest<T>(client: Client, info: RequestInfo, fn: (handle: RequestHandle) => T): T {
    const { path, query } = splitUrl(info.url);
    const request = {
        url: info.headers?.host ? `${firstHeader(info.headers['x-forwarded-proto']) ?? 'http'}://${firstHeader(info.headers.host)}${path}` : path,
        method: info.method.toUpperCase(),
        ...(query ? { query_string: scrubQuery(query) } : {}),
        headers: safeHeaders(info.headers),
    };

    return runWithRequest(client, request, () => {
        const parent = parseTraceHeader(firstHeader(info.headers?.[TRACE_HEADER]));
        const method = info.method.toUpperCase();
        const name = (route?: string) => `${method} ${route ?? info.route ?? path}`;

        const transaction = client.startTransaction({
            name: name(),
            op: 'http.server',
            ...(parent ? { traceId: parent.traceId, parentSpanId: parent.spanId, sampled: parent.sampled } : {}),
        });
        client.activeTransaction = transaction;
        client.scope.setTransactionName(transaction.name);

        const finish = (statusCode: number, route?: string) => {
            transaction.setName(name(route));
            transaction.setData('http.status_code', statusCode);
            // Magpie counts any status but "ok" as a failure, so only a server error is one. A 404 is a success.
            if (statusCode >= 500) transaction.setStatus('internal_error');
            transaction.end();
        };

        return fn({ transaction, finish });
    });
}

function splitUrl(url: string): { path: string; query: string } {
    let target = url;
    try {
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
            const u = new URL(url);
            target = `${u.pathname}${u.search}`;
        }
    } catch {
        // Keep it as given.
    }
    const q = target.indexOf('?');

    return q < 0 ? { path: target, query: '' } : { path: target.slice(0, q), query: target.slice(q + 1) };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function safeHeaders(headers: RequestInfo['headers']): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of SAFE_HEADERS) {
        const value = firstHeader(headers?.[name]);
        if (value) out[name] = value;
    }

    return out;
}
