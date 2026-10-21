import { captureException, type Client, type Integration, renameActiveTransaction, startNavigation } from '@greenhat-services/magpie-browser';

/** The parts of a Vue Router route this reads. Structural, so the SDK needs no import from `vue-router`. */
export interface RouteLike {
    path: string;
    name?: string | symbol | null;
    matched: Array<{ path: string }>;
}

export interface RouterLike {
    beforeEach(guard: (to: RouteLike, from: RouteLike) => unknown): () => void;
    afterEach(hook: (to: RouteLike, from: RouteLike, failure?: unknown) => unknown): () => void;
    onError(handler: (error: unknown) => unknown): () => void;
}

/**
 * The name a route is traced under: its pattern (`/users/:id`), so every user's page is one transaction rather
 * than one per id. Falls back to the route's name, then to its path.
 */
export function routeName(route: RouteLike): string {
    const pattern = route.matched[route.matched.length - 1]?.path;

    return pattern || (typeof route.name === 'string' ? route.name : '') || route.path;
}

/**
 * Names and times page loads and route changes with Vue Router. The first route gives the page load its pattern;
 * every later navigation is its own `navigation` transaction, which includes the requests it triggers. Errors the
 * router raises (a lazy route whose chunk failed to download) are reported as handled, since the app carries on.
 */
export function routerTracing(router: RouterLike): Integration {
    return {
        name: 'VueRouter',
        setup(client: Client) {
            let initial = true;

            const removeBefore = router.beforeEach((to) => {
                const name = routeName(to);

                if (initial) renameActiveTransaction(client, name);
                else startNavigation(client, name);
                client.scope.setTransactionName(name);

                return undefined;
            });

            // A cancelled or duplicated navigation is not a failure (Magpie counts any status but "ok" as one), so the
            // outcome is not recorded: this only notes that the first route has been seen.
            const removeAfter = router.afterEach(() => {
                initial = false;
            });

            const removeError = router.onError((error) => {
                captureException(error, { mechanism: { type: 'vue-router', handled: true } });
            });

            return () => {
                removeBefore();
                removeAfter();
                removeError();
            };
        },
    };
}
