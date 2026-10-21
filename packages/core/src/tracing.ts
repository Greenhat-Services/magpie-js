import type { Client } from './client';
import type { SpanJSON } from './types';
import { nowSeconds, spanId as newSpanId, traceId as newTraceId, truncate } from './util';

export const TRACE_HEADER = 'magpie-trace';

export interface TraceParent {
    traceId: string;
    spanId: string;
    sampled: boolean | undefined;
}

/** `<32 hex trace id>-<16 hex span id>-<0|1>`, the header the Laravel SDK reads and writes. */
export function parseTraceHeader(value: string | null | undefined): TraceParent | null {
    const m = /^([0-9a-f]{32})-([0-9a-f]{16})(?:-([01]))?$/i.exec((value ?? '').trim());
    if (!m) return null;

    return { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase(), sampled: m[3] === undefined ? undefined : m[3] === '1' };
}

export function formatTraceHeader(traceId: string, spanId: string, sampled: boolean): string {
    return `${traceId}-${spanId}-${sampled ? 1 : 0}`;
}

const MAX_SPANS = 100;
const MAX_DESCRIPTION = 512;

export interface SpanContext {
    op?: string;
    description?: string;
    startTimestamp?: number;
    data?: Record<string, unknown>;
}

/** One timed step inside a transaction: a request, a render, a phase of loading the page. */
export class Span {
    readonly spanId = newSpanId();
    op: string | undefined;
    description: string | undefined;
    startTimestamp: number;
    endTimestamp: number | undefined;
    data: Record<string, unknown> = {};
    /** `ok` unless set; a failed request is `internal_error` or `unknown_error`. */
    status: string | undefined;

    constructor(
        protected readonly transaction: Transaction | null,
        readonly parentSpanId: string | undefined,
        ctx: SpanContext = {},
    ) {
        this.op = ctx.op;
        this.description = ctx.description === undefined ? undefined : truncate(ctx.description, MAX_DESCRIPTION);
        this.startTimestamp = ctx.startTimestamp ?? nowSeconds();
        this.data = ctx.data ?? {};
    }

    setData(key: string, value: unknown): this {
        this.data[key] = value;

        return this;
    }

    setStatus(status: string): this {
        this.status = status;

        return this;
    }

    get ended(): boolean {
        return this.endTimestamp !== undefined;
    }

    startChild(ctx: SpanContext = {}): Span {
        return this.transaction ? this.transaction.startSpan(this.spanId, ctx) : new Span(null, this.spanId, ctx);
    }

    end(timestamp?: number): void {
        if (this.endTimestamp !== undefined) return;
        this.endTimestamp = timestamp ?? nowSeconds();
    }

    toJSON(): SpanJSON {
        const data = { ...this.data, ...(this.status && this.status !== 'ok' ? { status: this.status } : {}) };

        return {
            span_id: this.spanId,
            ...(this.parentSpanId ? { parent_span_id: this.parentSpanId } : {}),
            ...(this.op ? { op: this.op } : {}),
            ...(this.description ? { description: this.description } : {}),
            start_timestamp: this.startTimestamp,
            timestamp: this.endTimestamp ?? nowSeconds(),
            ...(Object.keys(data).length ? { data } : {}),
        };
    }
}

export interface TransactionContext extends SpanContext {
    name: string;
    traceId?: string;
    parentSpanId?: string;
    /** An upstream decision (from a `magpie-trace` header). When absent, the client samples. */
    sampled?: boolean;
}

/**
 * A root span: a page load, a route change or a server request. Only a sampled transaction records spans and is sent,
 * so an unsampled one costs almost nothing.
 */
export class Transaction extends Span {
    readonly traceId: string;
    name: string;
    readonly sampled: boolean;
    readonly spans: Span[] = [];
    droppedSpans = 0;
    private finished = false;

    constructor(
        private readonly client: Client | null,
        ctx: TransactionContext,
    ) {
        super(null, ctx.parentSpanId, ctx);
        this.traceId = ctx.traceId ?? newTraceId();
        this.name = ctx.name;
        this.sampled = ctx.sampled ?? false;
    }

    setName(name: string): this {
        this.name = name;

        return this;
    }

    override startChild(ctx: SpanContext = {}): Span {
        return this.startSpan(this.spanId, ctx);
    }

    /** @internal */
    startSpan(parentSpanId: string, ctx: SpanContext): Span {
        const span = new Span(this, parentSpanId, ctx);

        if (!this.sampled || this.finished) return span;
        if (this.spans.length >= MAX_SPANS) {
            this.droppedSpans++;

            return span;
        }

        this.spans.push(span);

        return span;
    }

    /** The header to put on an outgoing request so the service on the other end continues this trace. */
    traceHeader(): string {
        return formatTraceHeader(this.traceId, this.spanId, this.sampled);
    }

    /** Ends the transaction and, when sampled, sends it. Spans still open are ended at the same moment. */
    override end(timestamp?: number): void {
        if (this.finished) return;
        this.finished = true;

        const at = timestamp ?? nowSeconds();
        super.end(at);
        for (const span of this.spans) span.end(at);

        if (this.sampled) this.client?.sendTransaction(this);
    }
}
