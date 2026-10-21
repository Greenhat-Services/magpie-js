import vue from '@vitejs/plugin-vue';
import { magpie } from '@greenhat-services/magpie-vite-plugin';
import { defineConfig } from 'vite';

// MAGPIE_DSN, MAGPIE_AUTH_TOKEN and MAGPIE_RELEASE come from the environment, so no secret lives in this file.
export default defineConfig({
    plugins: [vue(), magpie({ environment: 'playground' })],
    build: { minify: 'esbuild' },
});
