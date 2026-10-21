import { type Client, type Integration, type Level, normalize, scrubUrl, truncate } from '@greenhat-services/magpie-core';

const CONSOLE_LEVELS: Array<[keyof Console, Level]> = [
    ['debug', 'debug'],
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warning'],
    ['error', 'error'],
];

/** `console.*` calls, so the lines logged just before an error show on the issue. The original is always called. */
export function consoleBreadcrumbs(): Integration {
    return {
        name: 'ConsoleBreadcrumbs',
        setup(client: Client) {
            if (typeof console === 'undefined') return;

            const originals = new Map<keyof Console, unknown>();
            let inside = false;

            for (const [method, level] of CONSOLE_LEVELS) {
                const original = console[method] as (...args: unknown[]) => void;
                if (typeof original !== 'function') continue;
                originals.set(method, original);

                (console as unknown as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
                    if (!inside) {
                        // addBreadcrumb must never be able to call console again and loop.
                        inside = true;
                        try {
                            client.addBreadcrumb({ category: 'log', level, message: args.map(format).join(' ') });
                        } finally {
                            inside = false;
                        }
                    }

                    return original.apply(this, args);
                };
            }

            return () => {
                for (const [method, original] of originals) (console as unknown as Record<string, unknown>)[method] = original;
            };
        },
    };
}

function format(value: unknown): string {
    if (typeof value === 'string') return truncate(value, 300);
    if (value instanceof Error) return truncate(`${value.name}: ${value.message}`, 300);

    try {
        return truncate(JSON.stringify(normalize(value, 2, 100, 10)) ?? String(value), 300);
    } catch {
        return String(value);
    }
}

/**
 * Clicks, as the element that was clicked (`form#checkout > button.primary`). Never the text or value, which can be
 * personal; the selector alone says what the person did.
 */
export function clickBreadcrumbs(): Integration {
    return {
        name: 'ClickBreadcrumbs',
        setup(client: Client) {
            if (typeof document === 'undefined') return;

            const onClick = (event: Event) => {
                const el = event.target as Element | null;
                if (!el || !('tagName' in el)) return;

                client.addBreadcrumb({ category: 'ui.click', message: describeElement(el) });
            };

            document.addEventListener('click', onClick, { capture: true, passive: true });

            return () => document.removeEventListener('click', onClick, { capture: true });
        },
    };
}

/** `tag#id.class.class[data-testid]` for the element and up to two ancestors. */
export function describeElement(el: Element): string {
    const parts: string[] = [];

    for (let node: Element | null = el, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'html' || tag === 'body') break;

        let part = tag;
        if (node.id) part += `#${node.id}`;
        const classes = (typeof node.className === 'string' ? node.className : '').split(/\s+/).filter(Boolean).slice(0, 3);
        if (classes.length) part += `.${classes.join('.')}`;
        const testId = node.getAttribute('data-testid');
        if (testId) part += `[data-testid=${testId}]`;

        parts.unshift(part);
        if (node.id) break;
    }

    return truncate(parts.join(' > ') || el.tagName.toLowerCase(), 200);
}

/** `pushState`, `replaceState` and back/forward, as navigation breadcrumbs. Query strings are scrubbed. */
export function historyBreadcrumbs(onNavigate?: (to: string) => void): Integration {
    return {
        name: 'HistoryBreadcrumbs',
        setup(client: Client) {
            if (typeof window === 'undefined' || !window.history) return;

            let from = location.href;
            const record = () => {
                const to = location.href;
                if (to === from) return;
                client.addBreadcrumb({ category: 'navigation', data: { from: scrubUrl(from), to: scrubUrl(to) } });
                from = to;
                onNavigate?.(to);
            };

            const restore: Array<() => void> = [];
            for (const method of ['pushState', 'replaceState'] as const) {
                const original = history[method];
                history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
                    const result = original.apply(this, args);
                    record();

                    return result;
                };
                restore.push(() => {
                    history[method] = original;
                });
            }

            window.addEventListener('popstate', record);
            restore.push(() => window.removeEventListener('popstate', record));

            return () => restore.forEach((r) => r());
        },
    };
}
