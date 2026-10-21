# @greenhat-services/magpie-nuxt

Magpie error tracking and performance monitoring for Nuxt: browser, Nitro server, source maps and releases.

```sh
npm install @greenhat-services/magpie-nuxt
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    modules: ['@greenhat-services/magpie-nuxt'],
    magpie: { dsn: 'https://<key>@<host>/<project>', tracesSampleRate: 0.2 },
});
```

Build with `MAGPIE_AUTH_TOKEN` set to upload the source maps of the browser and the server. The DSN can also be supplied when the app runs, with `NUXT_PUBLIC_MAGPIE_DSN`.

Tested with Nuxt 4.

Full documentation, options and what is (and is not) sent: https://github.com/Greenhat-Services/magpie-js#readme

MIT
