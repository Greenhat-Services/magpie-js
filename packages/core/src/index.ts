import type { Client } from './client';
import type { Scope } from './scope';
import type { Span, SpanContext, Transaction, TransactionContext } from './tracing';
import type { Breadcrumb, EventHint, Level, User } from './types';

export { Client, type Runtime } from './client';
export { endpoint, parseDsn, type Dsn } from './dsn';
export { exceptionValues, fromError, isError } from './event';
export { Scope } from './scope';
export { FILTERED, isSensitiveKey, scrubData, scrubQuery, scrubUrl } from './scrub';
export { defaultInApp, parseStack } from './stack';
export { Span, Transaction, TRACE_HEADER, formatTraceHeader, parseTraceHeader, type SpanContext, type TraceParent, type TransactionContext } from './tracing';
export type * from './types';
export { eventId, matchesAny, normalize, nowSeconds, randomHex, spanId, traceId, truncate } from './util';

export const SDK_VERSION = '0.1.0';

let current: Client | undefined;

/** The client the helpers below talk to. Platform packages call this from their own `init`. */
export function setClient(client: Client | undefined): void {
    current = client;
}

export function getClient(): Client | undefined {
    return current;
}

/** @returns The event id, or undefined when nothing was sent (not initialised, disabled, sampled out, ignored). */
export function captureException(exception: unknown, hint?: EventHint): string | undefined {
    return current?.captureException(exception, hint);
}

export function captureMessage(message: string, level?: Level): string | undefined {
    return current?.captureMessage(message, level);
}

export function addBreadcrumb(breadcrumb: Breadcrumb): void {
    current?.addBreadcrumb(breadcrumb);
}

/** Explicit, so it is always sent: you chose to tell Magpie who this is. */
export function setUser(user: User | null): void {
    current?.scope.setUser(user);
}

export function setTag(key: string, value: string | number | boolean): void {
    current?.scope.setTag(key, value);
}

export function setTags(tags: Record<string, string | number | boolean>): void {
    current?.scope.setTags(tags);
}

export function setExtra(key: string, value: unknown): void {
    current?.scope.setExtra(key, value);
}

export function setContext(name: string, context: Record<string, unknown> | null): void {
    current?.scope.setContext(name, context);
}

export function withScope<T>(callback: (scope: Scope) => T): T | undefined {
    return current ? current.withScope(callback) : undefined;
}

export function startTransaction(ctx: TransactionContext): Transaction | undefined {
    return current?.startTransaction(ctx);
}

export function startSpan<T>(ctx: SpanContext, callback: (span: Span) => T): T | undefined {
    return current ? current.startSpan(ctx, callback) : undefined;
}

export function flush(timeout?: number): Promise<boolean> {
    return current ? current.flush(timeout) : Promise.resolve(true);
}

export function close(timeout?: number): Promise<boolean> {
    const client = current;
    current = undefined;

    return client ? client.close(timeout) : Promise.resolve(true);
}
