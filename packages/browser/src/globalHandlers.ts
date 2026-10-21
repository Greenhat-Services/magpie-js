import type { Client, Integration } from '@greenhat-services/magpie-core';

/**
 * Reports what the page itself did not catch: `window.onerror` and unhandled promise rejections. Both are marked
 * `handled: false`, which is what puts the "Unhandled" label on the issue.
 */
export function globalHandlers(): Integration {
    return {
        name: 'GlobalHandlers',
        setup(client: Client) {
            if (typeof window === 'undefined') return;

            const onError = (event: ErrorEvent | Event) => {
                // A failed <img> or <script> load is an error event on the element, not on window. It says nothing
                // useful about the code, so it becomes a breadcrumb.
                const target = event.target as Element | null;
                if (target && target !== (window as unknown) && 'tagName' in target) {
                    const src = (target as HTMLImageElement).src || (target as HTMLLinkElement).href || '';
                    client.addBreadcrumb({ category: 'resource', level: 'warning', message: `Failed to load <${target.tagName.toLowerCase()}> ${src}`.trim() });

                    return;
                }

                const e = event as ErrorEvent;
                const mechanism = { type: 'onerror', handled: false };

                if (e.error !== undefined && e.error !== null) {
                    client.captureException(e.error, { mechanism });

                    return;
                }

                // A script from another origin without CORS headers reports only "Script error.": nothing to act on.
                if (!e.filename && /^Script error\.?$/i.test(e.message)) return;

                // No Error object (a syntax error, a very old browser): build one that points at the right place.
                const error = new Error(e.message);
                error.name = /^(\w+Error):/.exec(e.message)?.[1] ?? 'Error';
                error.stack = e.filename ? `${error.name}: ${e.message}\n    at ${e.filename}:${e.lineno || 0}:${e.colno || 0}` : undefined;
                client.captureException(error, { mechanism });
            };

            const onRejection = (event: PromiseRejectionEvent) => {
                client.captureException(event.reason, { mechanism: { type: 'onunhandledrejection', handled: false } });
            };

            window.addEventListener('error', onError, true);
            window.addEventListener('unhandledrejection', onRejection);

            return () => {
                window.removeEventListener('error', onError, true);
                window.removeEventListener('unhandledrejection', onRejection);
            };
        },
    };
}
