/** The wire format Magpie ingests. Timestamps are Unix seconds (fractions allowed). */

export type Level = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export interface Frame {
    filename?: string;
    function?: string;
    /** 1-based, as browsers report them. */
    lineno?: number;
    colno?: number;
    in_app?: boolean;
}

export interface Mechanism {
    type: string;
    handled: boolean;
}

export interface ExceptionValue {
    type?: string;
    value?: string;
    mechanism?: Mechanism;
    /** Oldest call first, which is the opposite of what an Error's stack string lists. */
    stacktrace?: { frames: Frame[] };
}

export interface Breadcrumb {
    type?: string;
    /** Magpie groups these in the issue page: `http*`, `sql*`, `log`, anything else is "default". */
    category?: string;
    message?: string;
    level?: Level;
    data?: Record<string, unknown>;
    timestamp?: number;
}

export interface User {
    id?: string | number;
    email?: string;
    username?: string;
    ip_address?: string;
    [key: string]: unknown;
}

export interface SpanJSON {
    span_id: string;
    parent_span_id?: string;
    op?: string;
    description?: string;
    start_timestamp: number;
    timestamp: number;
    data?: Record<string, unknown>;
}

export interface MagpieEvent {
    event_id: string;
    timestamp: number;
    platform: string;
    level?: Level;
    environment?: string;
    release?: string;
    server_name?: string;
    sdk: { name: string; version: string };
    exception?: { values: ExceptionValue[] };
    message?: string;
    /** The route or job the event happened in. */
    transaction?: string;
    request?: { url?: string; method?: string; headers?: Record<string, string>; query_string?: string };
    user?: User;
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    contexts?: Record<string, Record<string, unknown>>;
    breadcrumbs?: Breadcrumb[];
    fingerprint?: string[];
}

export interface TransactionEvent extends Omit<MagpieEvent, 'exception' | 'message'> {
    type: 'transaction';
    transaction: string;
    start_timestamp: number;
    spans: SpanJSON[];
}

export type Payload = MagpieEvent | TransactionEvent;

export interface TransportResult {
    ok: boolean;
    status?: number;
    /** Seconds Magpie asked us to wait (a 429's Retry-After). */
    retryAfter?: number;
}

/** Delivers one payload. Must never throw: failure is a result. */
export interface Transport {
    send(payload: Payload): Promise<TransportResult>;
}

export interface EventHint {
    originalException?: unknown;
    mechanism?: Mechanism;
    [key: string]: unknown;
}

export interface Integration {
    name: string;
    /** Called once when the client is created. Return a function to undo whatever was patched. */
    setup(client: import('./client').Client): void | (() => void);
}

export interface Options {
    /** `https://<key>@<host>/<project>`. Without one the SDK does nothing. */
    dsn?: string;
    enabled?: boolean;
    debug?: boolean;
    environment?: string;
    /** Must equal the version the build uploaded its source maps under, or frames stay minified. */
    release?: string;
    serverName?: string;
    /** Fraction of errors sent, 0 to 1. */
    sampleRate?: number;
    /** Fraction of page loads, navigations and requests traced, 0 to 1. Zero turns tracing off. */
    tracesSampleRate?: number;
    /** Attach the user, IP and cookie-like data. Off by default: nothing about a person is sent unless you ask. */
    sendDefaultPii?: boolean;
    /** Error messages (substring or RegExp) that are never reported. */
    ignoreErrors?: Array<string | RegExp>;
    /** Script URLs whose errors are dropped, for example browser extensions. */
    denyUrls?: Array<string | RegExp>;
    /** When set, only errors from these script URLs are reported. */
    allowUrls?: Array<string | RegExp>;
    /** Decides what counts as your own code in a stack trace. */
    inApp?: (filename: string) => boolean;
    beforeSend?: (event: MagpieEvent, hint: EventHint) => MagpieEvent | null;
    beforeSendTransaction?: (event: TransactionEvent) => TransactionEvent | null;
    beforeBreadcrumb?: (breadcrumb: Breadcrumb) => Breadcrumb | null;
    maxBreadcrumbs?: number;
    /** Hosts (substring or RegExp) that get the `magpie-trace` header on outgoing requests. Same-origin always does. */
    tracePropagationTargets?: Array<string | RegExp>;
    /** Upper bound on events sent per minute, so a render loop cannot flood Magpie. */
    maxEventsPerMinute?: number;
    transport?: Transport;
    integrations?: Integration[];
}
