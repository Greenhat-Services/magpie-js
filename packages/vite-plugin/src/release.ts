import { execFileSync } from 'node:child_process';

/** Runs a program with an argument list (no shell, so nothing is ever interpreted) and returns what it printed. */
export type Exec = (file: string, args: string[]) => string;

const defaultExec: Exec = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Environment variables that CI and hosts set to the commit being built, in the order they are tried. */
const COMMIT_ENV = [
    'MAGPIE_RELEASE',
    'GITHUB_SHA',
    'CI_COMMIT_SHA',
    'VERCEL_GIT_COMMIT_SHA',
    'CF_PAGES_COMMIT_SHA',
    'COMMIT_REF',
    'RENDER_GIT_COMMIT',
    'SOURCE_VERSION',
    'BITBUCKET_COMMIT',
    'CIRCLE_SHA1',
    'LARAVEL_CLOUD_COMMIT_HASH',
];

/**
 * The version this build is known as, in the order: what you passed, an environment variable a CI or host sets, then
 * the commit of the checkout. The same string must be used when the source maps are uploaded and when the page runs,
 * or Magpie cannot match a stack frame to its map.
 */
export function resolveRelease(explicit?: string, env: Record<string, string | undefined> = process.env, exec: Exec = defaultExec): string | undefined {
    if (explicit) return explicit;

    for (const name of COMMIT_ENV) {
        if (env[name]) return env[name];
    }

    try {
        return exec('git', ['rev-parse', 'HEAD']) || undefined;
    } catch {
        return undefined;
    }
}

export interface Commit {
    sha: string;
    message: string;
    author: string;
    timestamp: string;
}

/** The newest commits, newest first, as `git log` lists them. Empty when this is not a git checkout. */
export function recentCommits(limit = 50, exec: Exec = defaultExec): Commit[] {
    try {
        const out = exec('git', ['log', '-n', String(Math.max(1, Math.floor(limit))), '--pretty=format:%H%x1f%an%x1f%aI%x1f%s']);

        return out
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [sha, author, timestamp, ...message] = line.split('\u001f');

                return { sha, author, timestamp, message: message.join('\u001f') };
            });
    } catch {
        return [];
    }
}
