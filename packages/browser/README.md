# @greenhat-services/magpie-browser

Magpie error tracking and performance monitoring for the browser.

```sh
npm install @greenhat-services/magpie-browser
```

Reports uncaught errors and unhandled rejections, records console, click, navigation and request breadcrumbs, and traces page loads. About 11 KB gzipped, no runtime dependencies.

```ts
import * as Magpie from '@greenhat-services/magpie-browser';

Magpie.init({ dsn: 'https://<key>@<host>/<project>', release: '...', tracesSampleRate: 0.2 });
Magpie.captureException(error);
```

Full documentation, options and what is (and is not) sent: https://github.com/Greenhat-Services/magpie-js#readme

MIT
