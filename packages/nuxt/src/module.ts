import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { addImports, addPlugin, addServerPlugin, addVitePlugin, createResolver, defineNuxtModule, useLogger } from '@nuxt/kit';
import { type MapFile, magpie as magpieVitePlugin, parseDsn, resolveRelease, uploadSourceMaps } from '@greenhat-services/magpie-vite-plugin';

export interface ModuleOptions {
    /** `https://<key>@<host>/<project>`. Falls back to `MAGPIE_DSN`. Without one the module does nothing. */
    dsn?: string;
    /** Default: `MAGPIE_ENVIRONMENT`, then "development" under `nuxt dev` and "production" otherwise. */
    environment?: string;
    /** Default: the commit being built (see the Vite plugin). Must be the same for the page, the server and the source maps. */
    release?: string;
    /** Report errors while running `nuxt dev`. Off by default, so development noise stays out of Magpie. */
    dev?: boolean;
    /** Report errors from the browser. Default true. */
    client?: boolean;
    /** Report errors and requests from the Nitro server. Default true. */
    server?: boolean;
    /** Fraction of page loads, navigations and server requests traced, 0 to 1. Default 0 (tracing off). */
    tracesSampleRate?: number;
    /** Fraction of errors sent, 0 to 1. Default 1. */
    sampleRate?: number;
    sendDefaultPii?: boolean;
    debug?: boolean;
    /** Error messages that are never reported (substrings). */
    ignoreErrors?: string[];
    /** Hosts that get the `magpie-trace` header on outgoing requests. The server sends it to every host unless this is set. */
    tracePropagationTargets?: string[];
    sourcemaps?: {
        /** Upload source maps at build time. Default true. Needs an auth token, so it does nothing on a local build. */
        enabled?: boolean;
        /** Organisation token with the `project:releases` scope. Falls back to `MAGPIE_AUTH_TOKEN`. Read at build time only. */
        authToken?: string;
        /** Remove each map from the output once Magpie has it. Default true. */
        deleteAfterUpload?: boolean;
        /** Also upload the maps of the Nitro server build, so server stack traces show your source. Default true. */
        server?: boolean;
    };
    deploy?: {
        /** Record the release, environment and recent commits after the upload. Default true. */
        enabled?: boolean;
        deployedBy?: string;
        commits?: number;
    };
    /** Fail the build when an upload fails. Default false. */
    failOnError?: boolean;
}

export interface PublicConfig {
    /** Empty when none was known at build time; then NUXT_PUBLIC_MAGPIE_DSN supplies it at runtime. */
    dsn: string;
    environment: string;
    release?: string;
    tracesSampleRate?: number;
    sampleRate?: number;
    sendDefaultPii?: boolean;
    debug?: boolean;
    ignoreErrors?: string[];
    tracePropagationTargets?: string[];
    client: boolean;
    server: boolean;
}

export default defineNuxtModule<ModuleOptions>({
    meta: { name: '@greenhat-services/magpie-nuxt', configKey: 'magpie', compatibility: { nuxt: '>=3.14.0' } },
    defaults: { client: true, server: true, dev: false },

    setup(options, nuxt) {
        const logger = useLogger('magpie');
        // The DSN used at build time, for the source map upload. It does not have to exist: one build can be deployed to
        // several environments, each setting NUXT_PUBLIC_MAGPIE_DSN when it runs. Nuxt only lets an environment
        // variable override a key that was declared at build time, so the key is always declared, empty or not.
        const dsn = options.dsn ?? process.env.MAGPIE_DSN ?? '';

        if (!dsn) logger.info('No DSN at build time (the `magpie.dsn` option or MAGPIE_DSN). Set NUXT_PUBLIC_MAGPIE_DSN when the app runs. Source maps are not uploaded.');

        if (nuxt.options.dev && !options.dev) return;

        const resolver = createResolver(import.meta.url);
        const environment = options.environment ?? process.env.MAGPIE_ENVIRONMENT ?? (nuxt.options.dev ? 'development' : 'production');
        const release = options.release ?? resolveRelease();

        // The DSN is public by design (it ships in every bundle), so runtime config is the right place for it. The auth
        // token is not, and never goes here.
        // Every scalar has a value, so each can be overridden by a NUXT_PUBLIC_MAGPIE_* variable at runtime. The lists
        // stay out when unset: an undefined value can reach the browser as an empty string.
        const publicConfig: PublicConfig = {
            dsn,
            environment,
            release: release ?? '',
            tracesSampleRate: options.tracesSampleRate ?? 0,
            sampleRate: options.sampleRate ?? 1,
            sendDefaultPii: options.sendDefaultPii ?? false,
            debug: options.debug ?? false,
            ignoreErrors: options.ignoreErrors,
            tracePropagationTargets: options.tracePropagationTargets,
            client: options.client !== false,
            server: options.server !== false,
        };
        const defined = Object.fromEntries(Object.entries(publicConfig).filter(([, value]) => value !== undefined));
        (nuxt.options.runtimeConfig.public as Record<string, unknown>).magpie = { ...(nuxt.options.runtimeConfig.public.magpie as object | undefined), ...defined };

        if (publicConfig.client) addPlugin({ src: resolver.resolve('./runtime/plugin.client'), mode: 'client' });
        if (publicConfig.server) {
            addPlugin({ src: resolver.resolve('./runtime/plugin.server'), mode: 'server' });
            addServerPlugin(resolver.resolve('./runtime/server/plugin'));
        }

        // Available everywhere without an import, on the browser and the server alike.
        addImports(['captureException', 'captureMessage', 'addBreadcrumb', 'setUser', 'setTag', 'setTags', 'setExtra', 'setContext', 'startSpan', 'withScope'].map((name) => ({ name, from: '@greenhat-services/magpie-core' })));

        // Source maps: written but not referenced by the bundle (`hidden`), so they can be uploaded and then removed.
        // Uploading needs to know where, which is the DSN at build time.
        if (dsn && !nuxt.options.dev && options.sourcemaps?.enabled !== false) {
            const sourcemap = nuxt.options.sourcemap as { client?: boolean | 'hidden'; server?: boolean | 'hidden' };
            if (!sourcemap.client) sourcemap.client = 'hidden';

            addVitePlugin(
                () =>
                    magpieVitePlugin({
                        dsn,
                        authToken: options.sourcemaps?.authToken,
                        release,
                        environment,
                        sourcemaps: { deleteAfterUpload: options.sourcemaps?.deleteAfterUpload },
                        deploy: options.deploy,
                        failOnError: options.failOnError,
                    }),
                { dev: false, server: false },
            );

            // The server build's maps are not public (the server directory is never served), so they only need uploading.
            if (options.sourcemaps?.server !== false && publicConfig.server) {
                nuxt.hook('nitro:init', (nitro) => {
                    nitro.hooks.hook('compiled', async () => {
                        const token = options.sourcemaps?.authToken ?? process.env.MAGPIE_AUTH_TOKEN;
                        const target = parseDsn(dsn);
                        if (!token || !target || !release) return;

                        const files = await serverMaps(nitro.options.output.serverDir);
                        if (!files.length) return;

                        const result = await uploadSourceMaps({ origin: target.origin, project: target.project, token, version: release, files });
                        logger.info(`Uploaded ${result.uploaded.length} of ${files.length} server source maps for ${release}.`);
                        for (const { file, reason } of result.failed) {
                            if (options.failOnError) throw new Error(`${file.name} was not uploaded: ${reason}`);
                            logger.warn(`${file.name} was not uploaded: ${reason}`);
                        }
                    });
                });
            }
        }
    },
});

/**
 * The `.map` files under the server build. Magpie finds a map by the file's own name, so two files with the same name
 * (every `index.mjs`) cannot both be kept: the first wins, which is the entry point.
 */
async function serverMaps(dir: string): Promise<MapFile[]> {
    let names: string[];
    try {
        names = (await readdir(dir, { recursive: true })) as string[];
    } catch {
        return [];
    }

    const seen = new Set<string>();

    return names
        .filter((name) => name.endsWith('.map'))
        .sort()
        .flatMap((name) => {
            const file = basename(name);
            if (seen.has(file)) return [];
            seen.add(file);

            return [{ name: file, path: join(dir, name) }];
        });
}
