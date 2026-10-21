# @greenhat-services/magpie-node

Magpie error tracking and performance monitoring for Node.js servers, including Nuxt's Nitro.

```sh
npm install @greenhat-services/magpie-node
```

Per-request context isolated with AsyncLocalStorage, request tracing that continues the browser's trace, and the server's own `fetch` calls as spans.

```ts
import * as Magpie from '@greenhat-services/magpie-node';

const client = Magpie.init({ dsn: 'https://<key>@<host>/<project>', tracesSampleRate: 0.2 });
```

Using Nuxt? Install `@greenhat-services/magpie-nuxt` instead, which sets this up for you.

Full documentation, options and what is (and is not) sent: https://github.com/Greenhat-Services/magpie-js#readme

MIT
