# Contributing

## Setup

```sh
npm install
npm run build   # builds every package; the playgrounds use the built output
npm run check   # typecheck + the whole test suite
```

Tests run with Vitest. The browser tests run in jsdom; the Node tests run in Node.

## Rules the SDK must keep

- **Never break the host application.** Handlers, integrations, hooks and the transport catch everything and return a result instead of throwing. A user-supplied `beforeSend` that throws drops the event, nothing more. Anything that patches a global (`fetch`, `console`, `history`, `XMLHttpRequest`) calls the original and undoes the patch when the client is closed. If wrapping a call could make it fail, it must not.
- **Never send credentials or personal data.** Anything that carries request or page data goes through `scrubUrl`, `scrubQuery` or `scrubData`, and gets a test showing the sensitive value is absent from the payload. Breadcrumbs describe what happened, never what someone typed.
- **Bounded memory and payload size.** Collections are capped when they are added (breadcrumbs, spans, frames) and strings are truncated before they are kept.
- **Magpie counts any transaction status other than `ok` as a failure.** Only set one for a real server error. A cancelled navigation, a slow page or a tab that was closed is not a failure.
- **No runtime dependencies** beyond other packages in this repo.
- **Options can arrive as the wrong type** (framework config turns an unset number into `''`). Parse them, do not trust them.

## Packages

`core` has no browser or Node code and is shared by everything. `browser` and `node` add a runtime. `vue` builds on `browser`, `vite-plugin` is build-time only, and `nuxt` ties `vue`, `node` and `vite-plugin` together.

## Trying it against a real Magpie

The playgrounds are small apps that break in every way the SDK handles. Create an app in a local Magpie, then:

```sh
export MAGPIE_DSN='http://<key>@magpie.test/<ingest number>'
export MAGPIE_AUTH_TOKEN='mgp_org_...'       # an organisation token with the project:releases scope
export MAGPIE_RELEASE=local-1                  # use a new one each build

cd playground/vue-app && npx vite build && npx vite preview --port 4173
cd playground/nuxt-app && npx nuxt build && PORT=3000 node .output/server/index.mjs
```

Open the pages and press the buttons, then look at the issues in Magpie. Turn off the app's "localhost" inbound filter in Magpie, or serve the playground on another host name: events from `localhost` are dropped by default.

## Releasing

Not automated yet. Versions are bumped by hand in every `package.json`; write the change in `CHANGELOG.md`.
