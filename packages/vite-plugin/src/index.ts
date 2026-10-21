import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Plugin } from 'vite';
import { type Exec, recentCommits, resolveRelease } from './release';
import { type MapFile, recordRelease, uploadSourceMaps } from './upload';

export { recentCommits, resolveRelease } from './release';
export { recordRelease, uploadSourceMaps, type MapFile } from './upload';

export interface MagpiePluginOptions {
    /** The app's DSN (`https://<key>@<host>/<project>`), used to find where to upload. Falls back to `MAGPIE_DSN`. */
    dsn?: string;
    /**
     * An organisation token with the `project:releases` scope (Organisation settings > API tokens). Falls back to
     * `MAGPIE_AUTH_TOKEN`. It is read at build time only and is never put in the bundle. Without one, nothing is uploaded.
     */
    authToken?: string;
    /** The version of this build. Defaults to the commit being built; see `resolveRelease`. */
    release?: string;
    /** Where this build is going, for the deploy record. Defaults to `MAGPIE_ENVIRONMENT`, then "production". */
    environment?: string;
    sourcemaps?: {
        /** Default true. */
        enabled?: boolean;
        /** Remove each map from the output once Magpie has it, so it is never served. Default true. */
        deleteAfterUpload?: boolean;
        /** Also upload the maps of the server build (Nuxt's `ssr` environment). Default false. */
        server?: boolean;
    };
    deploy?: {
        /** Record the release, its environment and its commits with Magpie after the upload. Default true. */
        enabled?: boolean;
        deployedBy?: string;
        /** How many recent commits to send. Default 50. */
        commits?: number;
    };
    /** Fail the build when an upload fails. Default false: a Magpie outage should not stop you deploying. */
    failOnError?: boolean;
    disable?: boolean;
    /** @internal Replaced in tests. */
    fetch?: typeof fetch;
    /** @internal Replaced in tests. */
    exec?: Exec;
    /** @internal Replaced in tests. */
    env?: Record<string, string | undefined>;
}

const PREFIX = '[magpie]';

/**
 * Makes production stack traces readable. During `vite build` it:
 *  - makes the build write source maps without referencing them (`sourcemap: 'hidden'`), unless you chose otherwise;
 *  - puts the release on the page, as `import.meta.env.VITE_MAGPIE_RELEASE` and `window.__MAGPIE_RELEASE__`;
 *  - uploads the maps to Magpie under that release, and deletes them from the output once Magpie has them;
 *  - records the release, the environment it went to and its recent commits.
 */
export function magpie(options: MagpiePluginOptions = {}): Plugin {
    const env = options.env ?? process.env;
    let release: string | undefined;
    let deployed = false;

    const log = (message: string) => console.log(`${PREFIX} ${message}`);
    const warn = (message: string) => console.warn(`${PREFIX} ${message}`);

    return {
        name: 'magpie',
        apply: 'build',

        config(config) {
            release = resolveRelease(options.release, env, options.exec);

            return {
                // Hidden: the map is written but the bundle does not point at it, so visitors cannot fetch your source.
                ...(config.build?.sourcemap === undefined && options.sourcemaps?.enabled !== false ? { build: { sourcemap: 'hidden' as const } } : {}),
                ...(release ? { define: { 'import.meta.env.VITE_MAGPIE_RELEASE': JSON.stringify(release) } } : {}),
            };
        },

        transformIndexHtml() {
            if (!release) return undefined;

            return [{ tag: 'script', children: `window.__MAGPIE_RELEASE__=${JSON.stringify(release)};`, injectTo: 'head-prepend' as const }];
        },

        async writeBundle(outputOptions, bundle) {
            if (options.disable) return;
            release ??= resolveRelease(options.release, env, options.exec);

            // Nuxt and other SSR setups build twice. The browser build is the one whose stack traces need maps.
            const environment = (this as { environment?: { name?: string } }).environment?.name ?? 'client';
            if (environment !== 'client' && !options.sourcemaps?.server) return;

            const token = options.authToken ?? env.MAGPIE_AUTH_TOKEN;
            const dsn = parseDsn(options.dsn ?? env.MAGPIE_DSN);
            const fail = (message: string) => {
                if (options.failOnError) throw new Error(`${PREFIX} ${message}`);
                warn(message);
            };

            if (!release) return warn('No release could be worked out (no MAGPIE_RELEASE, CI commit variable or git checkout), so source maps are not uploaded.');
            if (!dsn) return warn('No DSN (the dsn option or MAGPIE_DSN), so source maps are not uploaded.');
            if (!token) return log('No MAGPIE_AUTH_TOKEN, so source maps are not uploaded. This is expected for a local build.');

            const dir = outputOptions.dir ?? '.';
            const files: MapFile[] = Object.keys(bundle)
                .filter((name) => name.endsWith('.map'))
                .map((name) => ({ name: basename(name), path: join(dir, name) }));

            if (options.sourcemaps?.enabled !== false && files.length) {
                const result = await uploadSourceMaps({ origin: dsn.origin, project: dsn.project, token, version: release, files, fetch: options.fetch });

                log(`Uploaded ${result.uploaded.length} of ${files.length} source maps for ${release}.`);
                for (const { file, reason } of result.failed) fail(`${file.name} was not uploaded: ${reason}`);

                // Only what Magpie actually has is removed, so a failed upload never costs you the map.
                if (options.sourcemaps?.deleteAfterUpload !== false) await Promise.all(result.uploaded.map((f) => rm(f.path, { force: true })));
            } else if (options.sourcemaps?.enabled !== false) {
                warn('The build produced no source maps. Check that build.sourcemap is not false.');
            }

            if (options.deploy?.enabled !== false && !deployed) {
                deployed = true;
                const reason = await recordRelease({
                    origin: dsn.origin,
                    project: dsn.project,
                    token,
                    version: release,
                    environment: options.environment ?? env.MAGPIE_ENVIRONMENT ?? 'production',
                    deployedBy: options.deploy?.deployedBy ?? env.GITHUB_ACTOR ?? env.GITLAB_USER_LOGIN ?? 'build',
                    commits: recentCommits(options.deploy?.commits ?? 50, options.exec),
                    fetch: options.fetch,
                });

                if (reason) fail(`The release was not recorded: ${reason}`);
                else log(`Recorded release ${release} for ${options.environment ?? env.MAGPIE_ENVIRONMENT ?? 'production'}.`);
            }
        },
    };
}

export function parseDsn(dsn: string | undefined): { origin: string; project: string } | null {
    const m = /^(https?):\/\/[^@/\s:]+@([^/\s]+)\/(\d+)\/?$/i.exec((dsn ?? '').trim());

    return m ? { origin: `${m[1].toLowerCase()}://${m[2]}`, project: m[3] } : null;
}

export default magpie;
