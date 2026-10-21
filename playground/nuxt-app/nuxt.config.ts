// MAGPIE_DSN, MAGPIE_AUTH_TOKEN and MAGPIE_RELEASE come from the environment, so no secret lives in this file.
export default defineNuxtConfig({
    compatibilityDate: '2025-07-15',
    devtools: { enabled: false },
    modules: ['@greenhat-services/magpie-nuxt'],
    magpie: {
        environment: 'playground',
        debug: true,
        tracesSampleRate: 1,
        tracePropagationTargets: ['magpie.test', '127.0.0.1'],
    },
});
