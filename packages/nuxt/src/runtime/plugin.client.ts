import { captureException, captureVueError, init } from '@greenhat-services/magpie-vue';
import { defineNuxtPlugin, useRouter, useRuntimeConfig } from '#imports';

/**
 * Starts Magpie in the browser. Errors reach it through Nuxt's own hooks rather than by replacing Vue's error
 * handler, so Nuxt's error page and every other module keep working exactly as before.
 */
export default defineNuxtPlugin({
    name: 'magpie:client',
    setup(nuxtApp) {
        const config = useRuntimeConfig().public.magpie as import('./types').PublicConfig | undefined;
        if (!config?.dsn) return;

        init({
            dsn: config.dsn,
            environment: config.environment,
            release: config.release,
            tracesSampleRate: config.tracesSampleRate,
            sampleRate: config.sampleRate,
            sendDefaultPii: config.sendDefaultPii,
            debug: config.debug,
            ignoreErrors: config.ignoreErrors,
            tracePropagationTargets: config.tracePropagationTargets,
            sdkName: 'magpie.javascript.nuxt',
            router: useRouter() as never,
        });

        nuxtApp.hook('vue:error', (error, instance, info) => captureVueError(error, instance as never, info));
        nuxtApp.hook('app:error', (error) => {
            // A 404 or a validation failure someone threw on purpose is the app working, not a bug.
            const status = (error as { statusCode?: number }).statusCode;
            if (status && status < 500) return;

            captureException(error, { mechanism: { type: 'nuxt', handled: false } });
        });
    },
});
