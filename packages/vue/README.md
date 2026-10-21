# @greenhat-services/magpie-vue

Magpie error tracking and performance monitoring for Vue 3 and Vue Router.

```sh
npm install @greenhat-services/magpie-vue
```

Reports Vue errors with the component they came from (never its props), and names page loads and navigations by route pattern.

```ts
Magpie.init({ app, router, dsn: import.meta.env.VITE_MAGPIE_DSN, release: import.meta.env.VITE_MAGPIE_RELEASE, tracesSampleRate: 0.2 });
```

Pair it with `@greenhat-services/magpie-vite-plugin` for readable stack traces.

Full documentation, options and what is (and is not) sent: https://github.com/Greenhat-Services/magpie-js#readme

MIT
