import { type BrowserOptions, type Client, init as browserInit } from '@greenhat-services/magpie-browser';
import type { App } from 'vue';
import { attachErrorHandler } from './errorHandler';
import { type RouterLike, routerTracing } from './router';

export * from '@greenhat-services/magpie-browser';
export { attachErrorHandler, captureVueError, componentHierarchy, componentName } from './errorHandler';
export { routeName, routerTracing, type RouteLike, type RouterLike } from './router';

export const VUE_SDK_NAME = 'magpie.javascript.vue';

export interface VueOptions extends BrowserOptions {
    /** The app to report errors from. Its `errorHandler` is wrapped, not replaced. */
    app?: App;
    /** The router to name and time page loads and route changes with. */
    router?: RouterLike;
}

/**
 * Starts Magpie for a Vue 3 app: everything the browser SDK does, plus Vue's own errors (with the component they came
 * from) and, given a router, page loads and navigations named by route pattern.
 *
 * ```ts
 * const app = createApp(App);
 * Magpie.init({ app, router, dsn: import.meta.env.VITE_MAGPIE_DSN, release: import.meta.env.VITE_MAGPIE_RELEASE, tracesSampleRate: 0.2 });
 * app.use(router).mount('#app');
 * ```
 */
export function init(options: VueOptions = {}): Client | undefined {
    const { app, router, integrations = [], ...rest } = options;

    const client = browserInit({
        ...rest,
        sdkName: rest.sdkName ?? VUE_SDK_NAME,
        integrations: [...(router ? [routerTracing(router)] : []), ...integrations],
    });

    if (client && app) attachErrorHandler(app);

    return client;
}
