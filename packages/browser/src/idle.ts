import type { Transaction } from '@greenhat-services/magpie-core';

/**
 * A page load or a route change has no natural end. It is finished when the page has gone quiet: nothing has been
 * requested for `idleTimeout` ms (and, for a page load, the `load` event has fired), or `maxDuration` has passed, or the
 * person left the tab. The end is back-dated to the last activity, so the quiet wait is not counted as load time.
 */
export interface Idle {
    requestStarted(): void;
    requestFinished(): void;
    /** Ends the transaction now, whatever is still going on. */
    finish(): void;
}

const trackers = new WeakMap<Transaction, Idle>();

export function idleFor(tx: Transaction): Idle | undefined {
    return trackers.get(tx);
}

export interface IdleOptions {
    idleTimeout: number;
    maxDuration: number;
    /** Wait for `window.load` before counting the page as quiet. */
    waitForLoad?: boolean;
    /** Runs just before the transaction ends: the place to add spans that were measured rather than timed. */
    beforeEnd?: (tx: Transaction, endTimestamp: number) => void;
    onEnd?: (tx: Transaction) => void;
}

export function trackIdle(tx: Transaction, options: IdleOptions): Idle {
    let pending = 0;
    let loaded = !options.waitForLoad || (typeof document !== 'undefined' && document.readyState === 'complete');
    let lastActivity = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const cleanup: Array<() => void> = [];

    // Magpie counts any status other than `ok` as a failure, so leaving the tab or a slow page never sets one: the page
    // did not fail, it just stopped being measured.
    const end = (backdate: boolean) => {
        if (ended) return;
        ended = true;
        if (timer) clearTimeout(timer);
        cleanup.forEach((c) => c());

        // Back-dated to the last activity, but never before the transaction began.
        const endAt = Math.max(tx.startTimestamp, (backdate ? lastActivity : Date.now()) / 1000);
        options.beforeEnd?.(tx, endAt);
        tx.end(endAt);
        options.onEnd?.(tx);
    };

    const arm = () => {
        if (timer) clearTimeout(timer);
        if (ended || pending > 0 || !loaded) return;
        timer = setTimeout(() => end(true), options.idleTimeout);
    };

    const idle: Idle = {
        requestStarted() {
            pending++;
            lastActivity = Date.now();
            if (timer) clearTimeout(timer);
        },
        requestFinished() {
            pending = Math.max(0, pending - 1);
            lastActivity = Date.now();
            arm();
        },
        finish: () => end(false),
    };

    trackers.set(tx, idle);

    const max = setTimeout(() => end(false), options.maxDuration);
    cleanup.push(() => clearTimeout(max));

    if (typeof window !== 'undefined') {
        if (!loaded) {
            const onLoad = () => {
                loaded = true;
                lastActivity = Date.now();
                arm();
            };
            window.addEventListener('load', onLoad, { once: true });
            cleanup.push(() => window.removeEventListener('load', onLoad));
        }

        const onHide = () => {
            if (document.visibilityState === 'hidden') end(true);
        };
        document.addEventListener('visibilitychange', onHide);
        cleanup.push(() => document.removeEventListener('visibilitychange', onHide));
    }

    arm();

    return idle;
}
