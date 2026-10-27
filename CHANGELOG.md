# Changelog

## 0.1.1

- The build reports which versions of Vue, Nuxt, Vite and a few other well-known packages the app is built with. Versions only, and it can be turned off with `platform: { enabled: false }`.

## 0.1.0

First release.

### Browser and Vue

- Uncaught errors, unhandled promise rejections and Vue errors, with the component and where it sits in the tree, never its props.
- Breadcrumbs for console, clicks (as the element, not its text), navigation and `fetch`/XHR requests.
- Page loads and route changes as transactions named by route pattern, with browser timing, resource and paint spans.
- A trace that continues across the stack: requests carry `magpie-trace`, which the Magpie Laravel SDK continues.
- Delivery as a CORS simple request, so there is no preflight and an event is one round trip.
- Safe by default: nothing about a person is sent, sensitive values are filtered, an API that refuses the trace header does not break the app's own request.

### Node

- Errors, per-request context isolated with AsyncLocalStorage, request transactions that continue the caller's trace, and the server's own `fetch` calls as spans.

### Build

- `@greenhat-services/magpie-vite-plugin`: hidden source maps, release injection, source map upload in batches within Magpie's limits, and a deploy record with recent commits.

### Nuxt

- One module for browser, Nitro server, source maps of both builds and the release. The DSN can be supplied when the app runs.
