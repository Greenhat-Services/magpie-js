# @greenhat-services/magpie-vite-plugin

Uploads source maps to Magpie, records the release and its commits, and injects the release into your Vite build.

```sh
npm install -D @greenhat-services/magpie-vite-plugin
```

```ts
// vite.config.ts
import { magpie } from '@greenhat-services/magpie-vite-plugin';

export default defineConfig({ plugins: [vue(), magpie()] });
```

Build with `MAGPIE_DSN` and `MAGPIE_AUTH_TOKEN` (an organisation token with the `project:releases` scope) set. Without a token the plugin does nothing, so local builds are untouched.

Full documentation, options and what is (and is not) sent: https://github.com/Greenhat-Services/magpie-js#readme

MIT
