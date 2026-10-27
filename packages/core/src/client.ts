import { type Dsn, parseDsn } from './dsn';
import { exceptionValues } from './event';
import { Scope } from './scope';
import { scrubData, scrubUrl } from './scrub';
import { type Span, type SpanContext, Transaction, type TransactionContext } from './tracing';
import type {
    Breadcrumb,
    EventHint,
    Integration,
    Level,
    MagpieEvent,
    Mechanism,
    Options,
    Payload,
    Transport,
    TransactionEvent,
} from './types';
import { defaultInApp } from './stack';
import { eventId, matchesAny, normalize, nowSeconds, truncate } from './util';

/** What differs between a browser and a server: how to deliver, and what to say about where the code runs. */
export interface Runtime {
    sdk: { name: string; version: string };
    platform: 'javascript' | 'node';
    createTransport(dsn: Dsn): Transport;
    /** `browser`, `os`, `runtime`: cheap to compute, read once per event. */
    contexts?(): Record<string, Record<string, unknown>>;
    request?(): MagpieEvent['request'] | undefined;
}

/** `value` as a number between `min` and `max`, or `fallback` when it is not a real number. */
function number(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

    return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

const DEDUPE_WINDOW_MS = 5_000;
const DEFAULT_MAX_EVENTS_PER_MINUTE = 30;
const MAX_TRANSACTIONS_PER_MINUTE = 60;
const DEFAULT_RETRY_AFTER_S = 60;
const MAX_STRING = 8192;
/** Environments that send nothing unless `disabledEnvironments` says otherwise: a developer's machine is noise in Magpie. */
const DEFAULT_DISABLED_ENVIRONMENTS = ['local'];

/**
 * Builds events, applies the scope and the options, and hands them to a transport. It never throws into the host
 * application: every failure becomes a dropped event and, with `debug`, a console warning.
 */
export class Client {
    readonly options: Options;
    readonly dsn: Dsn | null;
    scope = new Scope();
    /** The page load, route change or request currently being timed. Set by integrations. */
    activeTransaction: Transaction | undefined;

    private readonly transport: Transport | null;
    private readonly environmentDisabled: boolean;
    private readonly inApp: (filename: string) => boolean;
    private readonly pending = new Set<Promise<unknown>>();
    private readonly recent = new Map<string, number>();
    /** Errors already reported, so the same object seen by two handlers (Vue's and window.onerror) is sent once. */
    private readonly reported = new WeakSet<object>();
    private readonly sentAt: number[] = [];
    private readonly transactionsAt: number[] = [];
    private blockedUntil = 0;
    private teardowns: Array<() => void> = [];

    constructor(options: Options, readonly runtime: Runtime) {
        // Options can arrive from config files, environment variables and framework runtime config, where an unset
        // number is often an empty string or null. A rate that is not a number falls back to its default instead of
        // silently dropping everything ('' < 1 is true).
        this.options = {
            ...options,
            sampleRate: number(options.sampleRate, 1, 0, 1),
            tracesSampleRate: number(options.tracesSampleRate, 0, 0, 1),
            maxEventsPerMinute: number(options.maxEventsPerMinute, DEFAULT_MAX_EVENTS_PER_MINUTE, 0, Infinity),
            maxBreadcrumbs: number(options.maxBreadcrumbs, 100, 0, 1000),
        };
        this.dsn = parseDsn(options.dsn);
        this.inApp = options.inApp ?? defaultInApp;
        this.transport = options.transport ?? (this.dsn ? runtime.createTransport(this.dsn) : null);

        const disabled = Array.isArray(options.disabledEnvironments) ? options.disabledEnvironments : DEFAULT_DISABLED_ENVIRONMENTS;
        const environment = typeof options.environment === 'string' ? options.environment.toLowerCase() : '';
        this.environmentDisabled = environment !== '' && disabled.some((name) => String(name).toLowerCase() === environment);

        if (this.environmentDisabled) this.log(`Magpie is disabled in the "${options.environment}" environment. Change disabledEnvironments to send from it.`);
        else if (options.dsn && !this.dsn && !options.transport) this.log('The DSN is not valid, so Magpie is disabled. Expected https://<key>@<host>/<project>.');
        else if (this.enabled) this.log(`Started${this.dsn ? ` for ${this.dsn.origin}, project ${this.dsn.project}` : ''}, release ${options.release ?? '(none)'}, environment ${options.environment ?? '(none)'}.`);
    }

    get enabled(): boolean {
        return this.options.enabled !== false && this.transport !== null && !this.environmentDisabled;
    }

    // ------------------------------------------------------------------ errors

    /** @returns The event id, or undefined when the event was dropped (disabled, sampled out, ignored, duplicate, over the rate limit). */
    captureException(exception: unknown, hint: EventHint = {}): string | undefined {
        try {
            if (!this.enabled) return this.dropped('Magpie is disabled (no valid DSN, or enabled: false)');
            if (typeof exception === 'object' && exception !== null && this.reported.has(exception)) return this.dropped('this error object was already reported');

            const mechanism: Mechanism = hint.mechanism ?? { type: 'generic', handled: true };
            const { values, extra } = exceptionValues(exception, { mechanism, inApp: this.inApp });
            const thrown = values[values.length - 1];
            const frames = thrown?.stacktrace?.frames ?? [];

            if (this.isIgnored(thrown?.type, thrown?.value, frames.map((f) => f.filename))) return this.dropped(`the error matches ignoreErrors, denyUrls or allowUrls: ${thrown?.type}: ${thrown?.value}`);

            const event = this.baseEvent({ exception: { values }, level: 'error', ...(extra ? { extra } : {}) });
            const top = frames[frames.length - 1];

            const id = this.process(event, { originalException: exception, ...hint, mechanism }, `${thrown?.type}|${thrown?.value}|${top?.filename}:${top?.lineno}:${top?.colno}`);
            if (id && typeof exception === 'object' && exception !== null) this.reported.add(exception);

            return id;
        } catch (e) {
            this.log('captureException failed', e);

            return undefined;
        }
    }

    captureMessage(message: string, level: Level = 'info', hint: EventHint = {}): string | undefined {
        try {
            if (!this.enabled) return undefined;

            const event = this.baseEvent({ message: truncate(String(message), MAX_STRING), level });

            return this.process(event, hint, `message|${level}|${message}`);
        } catch (e) {
            this.log('captureMessage failed', e);

            return undefined;
        }
    }

    addBreadcrumb(breadcrumb: Breadcrumb): void {
        try {
            if (!this.enabled) return;

            let crumb: Breadcrumb | null = { ...breadcrumb };
            if (crumb.message) crumb.message = truncate(crumb.message, 500);
            if (crumb.data) crumb.data = scrubData(normalize(crumb.data, 3, 256, 20) as Record<string, unknown>);
            if (this.options.beforeBreadcrumb) crumb = this.options.beforeBreadcrumb(crumb);
            if (!crumb) return;

            this.scope.addBreadcrumb(crumb, this.options.maxBreadcrumbs ?? 100);
        } catch (e) {
            this.log('addBreadcrumb failed', e);
        }
    }

    /** Runs `callback` with a copy of the scope that is thrown away afterwards, for tags that belong to one operation. */
    withScope<T>(callback: (scope: Scope) => T): T {
        const previous = this.scope;
        this.scope = previous.clone();

        try {
            return callback(this.scope);
        } finally {
            this.scope = previous;
        }
    }

    // ------------------------------------------------------------------ tracing

    /**
     * Starts a page load, route change or request. Sampling follows an upstream decision when there is one, so a trace
     * is either complete or absent. An unsampled transaction is returned too, inert, so callers need no branching.
     */
    startTransaction(ctx: TransactionContext): Transaction {
        const rate = this.options.tracesSampleRate ?? 0;
        const sampled = ctx.sampled ?? (this.enabled && rate > 0 && Math.random() < rate);

        return new Transaction(this, { ...ctx, sampled: this.enabled && sampled });
    }

    /** Times `callback` as a child of the active transaction. Handles sync and async callbacks, and always ends the span. */
    startSpan<T>(ctx: SpanContext, callback: (span: Span) => T): T {
        const span = (this.activeTransaction ?? this.startTransaction({ name: '', sampled: false })).startChild(ctx);

        const finish = (status?: string) => {
            if (status) span.setStatus(status);
            span.end();
        };

        try {
            const result = callback(span);
            if (result && typeof (result as { then?: unknown }).then === 'function') {
                return (result as unknown as Promise<unknown>).then(
                    (v) => (finish(), v),
                    (e) => {
                        finish('internal_error');
                        throw e;
                    },
                ) as unknown as T;
            }
            finish();

            return result;
        } catch (e) {
            finish('internal_error');
            throw e;
        }
    }

    /** @internal Called by `Transaction.end()`. */
    sendTransaction(tx: Transaction): void {
        try {
            if (!this.enabled || !this.withinRate(this.transactionsAt, MAX_TRANSACTIONS_PER_MINUTE) || Date.now() < this.blockedUntil) return;

            const base = this.baseEvent({});
            let event: TransactionEvent | null = {
                ...base,
                type: 'transaction',
                transaction: tx.name,
                start_timestamp: tx.startTimestamp,
                timestamp: tx.endTimestamp ?? nowSeconds(),
                contexts: {
                    ...base.contexts,
                    trace: {
                        trace_id: tx.traceId,
                        span_id: tx.spanId,
                        ...(tx.parentSpanId ? { parent_span_id: tx.parentSpanId } : {}),
                        ...(tx.op ? { op: tx.op } : {}),
                        status: tx.status ?? 'ok',
                        ...(tx.droppedSpans ? { dropped_spans: tx.droppedSpans } : {}),
                    },
                },
                spans: tx.spans.map((s) => s.toJSON()),
            };

            delete (event as Partial<MagpieEvent>).breadcrumbs;
            if (this.options.beforeSendTransaction) event = this.options.beforeSendTransaction(event);
            if (event) this.deliver(event);
        } catch (e) {
            this.log('sendTransaction failed', e);
        }
    }

    /** True when `url` should get the `magpie-trace` header: same-origin is decided by the platform, the rest by the option. */
    shouldPropagate(url: string): boolean {
        return matchesAny(url, this.options.tracePropagationTargets);
    }

    // ------------------------------------------------------------------ lifecycle

    setupIntegrations(integrations: Integration[]): void {
        for (const integration of integrations) {
            try {
                const teardown = integration.setup(this);
                if (typeof teardown === 'function') this.teardowns.push(teardown);
            } catch (e) {
                this.log(`The ${integration.name} integration failed to start`, e);
            }
        }
    }

    /** Resolves true when everything pending was delivered, false when `timeout` ms passed first. */
    async flush(timeout = 2000): Promise<boolean> {
        if (this.pending.size === 0) return true;

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeout);
        });

        try {
            return await Promise.race([Promise.allSettled([...this.pending]).then(() => true as const), timedOut]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async close(timeout = 2000): Promise<boolean> {
        const ok = await this.flush(timeout);
        for (const teardown of this.teardowns.splice(0)) {
            try {
                teardown();
            } catch {
                // Undoing a patch must never throw into the page.
            }
        }

        return ok;
    }

    // ------------------------------------------------------------------ internals

    private baseEvent(partial: Partial<MagpieEvent>): MagpieEvent {
        const req = this.runtime.request?.();

        const event: MagpieEvent = {
            event_id: eventId(),
            timestamp: nowSeconds(),
            platform: this.runtime.platform,
            sdk: this.runtime.sdk,
            ...(this.options.environment ? { environment: this.options.environment } : {}),
            ...(this.options.release ? { release: this.options.release } : {}),
            ...(this.options.serverName ? { server_name: this.options.serverName } : {}),
            ...(req ? { request: { ...req, ...(req.url ? { url: scrubUrl(req.url) } : {}) } } : {}),
            ...partial,
        };

        const contexts = this.runtime.contexts?.();
        if (contexts && Object.keys(contexts).length) event.contexts = { ...contexts, ...event.contexts };

        return event;
    }

    private process(event: MagpieEvent, hint: EventHint, dedupeKey: string): string | undefined {
        const rate = this.options.sampleRate ?? 1;
        const cap = this.options.maxEventsPerMinute ?? DEFAULT_MAX_EVENTS_PER_MINUTE;
        if (rate < 1 && !(rate > 0 && Math.random() < rate)) return this.dropped(`sampled out (sampleRate ${rate})`);
        if (this.isDuplicate(dedupeKey)) return this.dropped('the same error was reported in the last 5 seconds');
        if (Date.now() < this.blockedUntil) return this.dropped('Magpie asked us to slow down (HTTP 429), so events are paused');
        if (!this.withinRate(this.sentAt, cap)) return this.dropped(`more than ${cap} events in a minute`);

        this.scope.applyTo(event);
        if (event.extra) event.extra = scrubData(normalize(event.extra) as Record<string, unknown>);
        if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.slice(-(this.options.maxBreadcrumbs ?? 100));

        let result: MagpieEvent | null = event;
        if (this.options.beforeSend) result = this.options.beforeSend(event, hint);
        if (!result) return this.dropped('beforeSend returned null');

        this.deliver(result);

        return result.event_id;
    }

    private deliver(payload: Payload): void {
        if (!this.transport) return;

        let promise: Promise<unknown>;
        try {
            promise = this.transport
                .send(payload)
                .then((r) => {
                    if (r.status === 429) this.blockedUntil = Date.now() + (r.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000;
                    if (!r.ok) this.log(`Magpie did not accept the payload (HTTP ${r.status ?? 'no response'}).`);
                })
                .catch((e) => this.log('Delivery failed', e));
        } catch (e) {
            this.log('Delivery failed', e);

            return;
        }

        this.pending.add(promise);
        void promise.finally(() => this.pending.delete(promise));
    }

    private isIgnored(type: string | undefined, value: string | undefined, filenames: Array<string | undefined>): boolean {
        const text = `${type ?? ''}: ${value ?? ''}`;
        if (matchesAny(text, this.options.ignoreErrors)) return true;

        const urls = filenames.filter((f): f is string => !!f && /^[a-z][a-z0-9+.-]*:/i.test(f));
        if (this.options.denyUrls?.length && urls.some((u) => matchesAny(u, this.options.denyUrls))) return true;
        if (this.options.allowUrls?.length && urls.length && !urls.some((u) => matchesAny(u, this.options.allowUrls))) return true;

        return false;
    }

    private isDuplicate(key: string): boolean {
        const now = Date.now();
        for (const [k, at] of this.recent) if (now - at > DEDUPE_WINDOW_MS) this.recent.delete(k);

        if (this.recent.has(key)) return true;
        this.recent.set(key, now);

        return false;
    }

    /** A sliding one-minute window: records this send and says whether it is still under the cap. */
    private withinRate(sent: number[], max: number): boolean {
        const now = Date.now();
        while (sent.length && now - sent[0] > 60_000) sent.shift();
        if (sent.length >= max) return false;
        sent.push(now);

        return true;
    }

    /** Says why an event was not sent, when `debug` is on, and returns undefined for the caller to return. */
    private dropped(reason: string): undefined {
        this.log(`Event not sent: ${reason}.`);

        return undefined;
    }

    private log(message: string, error?: unknown): void {
        if (this.options.debug) console.warn(`[magpie] ${message}`, error ?? '');
    }
}
