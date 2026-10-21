import { captureException, captureVueError } from '@greenhat-services/magpie-vue';
import { defineNuxtPlugin, useRequestEvent, useRouter } from '#imports';

/**
 * The server-side half that only the Vue app can do: it knows which route was rendered, so the request is named
 * `GET /users/:id` instead of one transaction per user, and it sees errors thrown while rendering components, which
 * Nuxt turns into an error page rather than throwing them to Nitro.
 */
export default defineNuxtPlugin({
    name: 'magpie:server',
    setup(nuxtApp) {
        nuxtApp.hook('vue:error', (error, instance, info) => captureVueError(error, instance as never, info));

        nuxtApp.hook('app:error', (error) => {
            // A 404 or a validation failure someone threw on purpose is the app working, not a bug.
            const status = (error as { statusCode?: number }).statusCode;
            if (status && status < 500) return;

            captureException(error, { mechanism: { type: 'nuxt', handled: false } });
        });

        nuxtApp.hook('app:rendered', () => {
            const event = useRequestEvent();
            const matched = useRouter().currentRoute.value.matched;
            const pattern = matched[matched.length - 1]?.path?.replace(/\(\)/g, '');

            if (event && pattern) (event.context as Record<string, unknown>).magpieRoute = pattern;
        });
    },
});
