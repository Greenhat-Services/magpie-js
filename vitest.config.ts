import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            '@greenhat-services/magpie-core': src('core'),
            '@greenhat-services/magpie-browser': src('browser'),
            '@greenhat-services/magpie-node': src('node'),
            '@greenhat-services/magpie-vue': src('vue'),
            '@greenhat-services/magpie-vite-plugin': src('vite-plugin'),
        },
    },
    test: {
        include: ['packages/*/test/**/*.test.ts'],
        environment: 'node',
    },
});
