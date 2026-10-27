import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Packages whose installed version Magpie shows, in the order they are listed. Names and versions only. */
export const PLATFORM_PACKAGES = ['nuxt', 'vue', 'vue-router', 'pinia', 'react', 'next', 'svelte', '@sveltejs/kit', 'vite', 'tailwindcss', 'typescript'] as const;

/** `root` and every directory above it, nearest first: the places Node looks for `node_modules`. */
function searchPath(root: string): string[] {
    const dirs: string[] = [];

    for (let dir = resolve(root); ; dir = dirname(dir)) {
        dirs.push(dir);
        if (dirname(dir) === dir) return dirs;
    }
}

/**
 * The version of each known package installed at or above `root`, keyed by the name Magpie shows (`@sveltejs/kit` is
 * `sveltekit`).
 *
 * Looks upwards the way Node resolves a package, because Vite's root is not always the project folder: Nuxt builds from
 * its own folder inside `node_modules/.cache`, and a workspace installs its packages in a parent.
 */
export async function installedVersions(root: string, packages: readonly string[] = PLATFORM_PACKAGES): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    const dirs = searchPath(root);

    await Promise.all(
        packages.map(async (name) => {
            for (const dir of dirs) {
                try {
                    const { version } = JSON.parse(await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown };
                    if (typeof version === 'string' && version) found[name === '@sveltejs/kit' ? 'sveltekit' : name] = version;

                    return;
                } catch {
                    // Not installed here: try the folder above. Nowhere, and it is simply not part of this app.
                }
            }
        }),
    );

    return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

export interface PlatformReport {
    /** `https://host`, no trailing slash. */
    origin: string;
    project: string;
    token: string;
    environment: string;
    components: Record<string, string>;
    sdk?: { name: string; version?: string };
    fetch?: typeof fetch;
}

/**
 * Tells Magpie what the app is built with, to `POST /api/{project}/platform`. Returns why it failed, or undefined when
 * Magpie has it. Versions only: nothing from the app's configuration or environment is sent.
 */
export async function reportPlatform(report: PlatformReport): Promise<string | undefined> {
    try {
        const response = await (report.fetch ?? fetch)(`${report.origin}/api/${report.project}/platform`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${report.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ environment: report.environment, components: report.components, ...(report.sdk ? { sdk: report.sdk } : {}) }),
        });

        if (response.ok) return undefined;

        let detail = '';
        try {
            const body = (await response.json()) as { error?: string; message?: string };
            detail = body.error ?? body.message ?? '';
        } catch {
            // Not JSON: the status says enough.
        }

        return `HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
    } catch (error) {
        return `could not reach Magpie (${(error as Error).message})`;
    }
}
