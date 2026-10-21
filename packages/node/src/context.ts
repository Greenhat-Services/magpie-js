import { AsyncLocalStorage } from 'node:async_hooks';
import type { Client, MagpieEvent, Scope, Transaction } from '@greenhat-services/magpie-core';

/**
 * What belongs to one request on a server that handles many at once: its own scope (tags, user, breadcrumbs), the
 * transaction being timed, and the request being served. Carried through every `await` by AsyncLocalStorage, so two
 * overlapping requests never see each other's data.
 */
export interface RequestStore {
    scope: Scope;
    transaction: Transaction | undefined;
    request: MagpieEvent['request'] | undefined;
}

export const storage = new AsyncLocalStorage<RequestStore>();

export const currentStore = (): RequestStore | undefined => storage.getStore();

/**
 * Makes `client.scope` and `client.activeTransaction` follow the request that is running, and fall back to the
 * process-wide ones outside any request. Applied to the instance, so core stays free of Node.
 */
export function isolatePerRequest(client: Client): void {
    let processScope = client.scope;
    let processTransaction = client.activeTransaction;

    Object.defineProperty(client, 'scope', {
        configurable: true,
        get: () => storage.getStore()?.scope ?? processScope,
        // withScope() swaps in a copy while its callback runs and puts the original back afterwards. Inside a request
        // that swap belongs to the request, so one request's temporary tags can never reach another.
        set: (scope: Scope) => {
            const store = storage.getStore();
            if (store) store.scope = scope;
            else processScope = scope;
        },
    });

    Object.defineProperty(client, 'activeTransaction', {
        configurable: true,
        get: () => {
            const store = storage.getStore();

            return store ? store.transaction : processTransaction;
        },
        set: (tx: Transaction | undefined) => {
            const store = storage.getStore();
            if (store) store.transaction = tx;
            else processTransaction = tx;
        },
    });
}

/** Runs `fn` as one request: a copy of the process scope, its own transaction slot, and the request being served. */
export function runWithRequest<T>(client: Client, request: MagpieEvent['request'] | undefined, fn: () => T): T {
    return storage.run({ scope: client.scope.clone(), transaction: undefined, request }, fn);
}
