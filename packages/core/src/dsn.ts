export interface Dsn {
    publicKey: string;
    host: string;
    /** The app's ingest number, the last part of the DSN. */
    project: string;
    protocol: 'http' | 'https';
    /** `https://host` without a trailing slash, including a port when there is one. */
    origin: string;
}

/** `https://<key>@<host>/<project>`. Returns null for anything else, so a bad DSN disables the SDK instead of throwing. */
export function parseDsn(dsn: string | undefined): Dsn | null {
    if (!dsn) return null;

    const m = /^(https?):\/\/([^@/\s:]+)@([^/\s]+)\/(\d+)\/?$/i.exec(dsn.trim());
    if (!m) return null;

    const protocol = m[1].toLowerCase() as 'http' | 'https';

    return { publicKey: m[2], host: m[3], project: m[4], protocol, origin: `${protocol}://${m[3]}` };
}

/** Where a kind of payload goes: `events`, `transactions`, `replays`. */
export function endpoint(dsn: Dsn, path: 'events' | 'transactions' | 'sessions' | 'replays' | 'sourcemaps' | 'releases'): string {
    return `${dsn.origin}/api/${dsn.project}/${path}`;
}
