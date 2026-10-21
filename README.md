# Magpie for JavaScript

Error tracking and performance monitoring for [Magpie](https://github.com/Greenhat-Services/magpie), for Vue, Nuxt and plain browser and Node apps.

| Package | Use it for |
|---|---|
| `@greenhat-services/magpie-nuxt` | Nuxt 4 (tested): browser, Nitro server, source maps and releases, in one module. Written for Nuxt 3.14+ too, but not yet run on Nuxt 3 |
| `@greenhat-services/magpie-vue` | Vue 3 and Vue Router: component-aware errors and route-named page loads |
| `@greenhat-services/magpie-vite-plugin` | Readable stack traces: uploads source maps and records the release at build time |
| `@greenhat-services/magpie-browser` | Any browser app: errors, breadcrumbs, requests, page loads |
| `@greenhat-services/magpie-node` | Any Node server: errors, per-request context, request tracing |
| `@greenhat-services/magpie-core` | The shared client. You do not install this yourself |

The browser SDK is about 11 KB gzipped. There are no runtime dependencies beyond these packages.

## Nuxt

```sh
npm install @greenhat-services/magpie-nuxt
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    modules: ['@greenhat-services/magpie-nuxt'],
    magpie: {
        dsn: 'https://<key>@<host>/<project>', // or set MAGPIE_DSN, or NUXT_PUBLIC_MAGPIE_DSN when the app runs
        tracesSampleRate: 0.2,
    },
});
```

Take the DSN from **App settings > DSN keys** in Magpie. That is all the module needs to report errors from the browser and the server.

For readable stack traces, build with an organisation token (Organisation settings > API tokens, scope `project:releases`):

```sh
MAGPIE_AUTH_TOKEN=mgp_org_... npx nuxt build
```

The build uploads the source maps of the browser **and** the server under a release (the commit being built), removes the browser maps from the output so they are never served, and records the release and its recent commits, which is what gives each issue a suspect commit. The token is read at build time only and never reaches the bundle.

One build can be deployed to several environments. Leave the DSN out of the config and set `NUXT_PUBLIC_MAGPIE_DSN` (and `NUXT_PUBLIC_MAGPIE_ENVIRONMENT`) where the app runs.

By default the module is off under `nuxt dev`, so development noise stays out of Magpie. Set `magpie.dev: true` to report from development too.

**Everything the module does**

- Browser: uncaught errors, unhandled rejections, Vue and Nuxt errors (with the component), console, click, navigation and request breadcrumbs, page loads and route changes as transactions named by route pattern (`/users/:id`).
- Server: errors from Nitro routes and from rendering pages (with the request attached), every request as a transaction, and the server's own `fetch` calls as spans.
- One trace across browser, Nuxt server and API: the server hands its trace to the page, and requests carry a `magpie-trace` header that the Magpie Laravel SDK continues.
- `captureException`, `captureMessage`, `addBreadcrumb`, `setUser`, `setTag`, `startSpan` and `withScope` are auto-imported.

## Vue

```sh
npm install @greenhat-services/magpie-vue
npm install -D @greenhat-services/magpie-vite-plugin
```

```ts
// src/main.ts
import { createApp } from 'vue';
import * as Magpie from '@greenhat-services/magpie-vue';
import App from './App.vue';
import router from './router';

const app = createApp(App);

Magpie.init({
    app,
    router,
    dsn: import.meta.env.VITE_MAGPIE_DSN,
    release: import.meta.env.VITE_MAGPIE_RELEASE,
    tracesSampleRate: 0.2,
});

app.use(router).mount('#app');
```

```ts
// vite.config.ts
import { magpie } from '@greenhat-services/magpie-vite-plugin';

export default defineConfig({ plugins: [vue(), magpie()] });
```

Build with `MAGPIE_DSN` and `MAGPIE_AUTH_TOKEN` set (in CI). Without a token the plugin does nothing and your local builds are untouched.

`init` wraps `app.config.errorHandler` rather than replacing it, and still logs to the console, so nothing you already had stops working.

## Plain browser, Node

```ts
import * as Magpie from '@greenhat-services/magpie-browser';

Magpie.init({ dsn: '...', release: '...', tracesSampleRate: 0.2 });
Magpie.captureException(error);
```

```ts
import * as Magpie from '@greenhat-services/magpie-node';

const client = Magpie.init({ dsn: '...', tracesSampleRate: 0.2 });

// Wrap each request so overlapping requests never share tags or breadcrumbs.
await Magpie.trackRequest(client, { method: 'GET', url: '/orders/7', headers }, async ({ finish }) => {
    // ... handle the request; errors captured in here carry the request
    finish(200, '/orders/:id');
});
```

## Options

These work in `init` and, except where noted, in the Nuxt module's `magpie` key.

| Option | Default | |
|---|---|---|
| `dsn` | none | `https://<key>@<host>/<project>`. Without a valid one the SDK does nothing. |
| `environment` | none | Shown on every issue and used by the environment filter. |
| `release` | none | Must equal the release the build uploaded its source maps under. The Vite plugin and the Nuxt module set it for you. |
| `sampleRate` | `1` | Fraction of errors sent. |
| `tracesSampleRate` | `0` | Fraction of page loads, navigations and server requests traced. `0` turns tracing off. |
| `sendDefaultPii` | `false` | Adds the referrer. A user is only sent when you call `setUser`. |
| `ignoreErrors` | none | Messages (substring or RegExp) never reported. |
| `denyUrls`, `allowUrls` | none | Report errors only from (or never from) matching script URLs. Not available in the Nuxt module. |
| `tracePropagationTargets` | same-origin | Hosts that get the `magpie-trace` header. The server sends it to every host unless this is set. |
| `beforeSend`, `beforeBreadcrumb` | none | Return `null` to drop. Not available in the Nuxt module (they are functions). |
| `maxBreadcrumbs` | `100` | |
| `maxEventsPerMinute` | `30` | A render loop cannot flood Magpie. |
| `debug` | `false` | Logs why an event was not sent. Turn this on first when an error does not show up. |

## What is, and is not, sent

Nothing about a person is sent unless you call `setUser`. By default an event carries: the error and its stack, the page URL, the browser, OS and screen size, the release and environment, and breadcrumbs.

- Sensitive values (`token`, `password`, `secret`, `api_key`, `session` and the like) are filtered from URLs, breadcrumb data and `extra`, at any depth. A `#access_token=...` fragment is filtered too.
- Clicks are recorded as the element (`form#checkout > button.primary`), never its text or value.
- Vue component names are sent, never props or state.
- On the server, only a short allow-list of request headers is attached. Cookies and authorization headers are never sent.
- Cookies and bodies are never read.

## Things to know

- **Content Security Policy.** Allow the Magpie host in `connect-src`. The Vite plugin adds a small inline script (`window.__MAGPIE_RELEASE__=...`) to `index.html`; under a strict `script-src`, pass `release` to `init` instead and the plugin's script is harmless.
- **CORS and the trace header.** Putting `magpie-trace` on a request to another origin makes the browser ask that API's permission first. If its CORS policy does not allow the header, the request would fail. The SDK only sends it to hosts you list in `tracePropagationTargets`, and if a host refuses it once, stops sending it there and repeats a refused GET without it. Laravel's default CORS config allows it. The header is only added to requests made during a page load or a navigation, not to later ones.
- **Rate limits are shared.** A DSN key's per-minute limit counts every visitor's requests together. Sample (`sampleRate`, `tracesSampleRate`) on busy sites.
- **Source maps are matched by file name.** Server builds with several files of the same name (every `index.mjs`) keep only the first.

## Not yet

- Browser sessions, so crash-free sessions and release adoption stay empty for Vue and Nuxt apps.
- Session replays.
- Function names in stack traces stay minified (the file, line and source context are right). That is a limit of how Magpie reads source maps.
- React and Next.js.

## Develop

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
