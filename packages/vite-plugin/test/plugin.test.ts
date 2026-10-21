import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { magpie, recentCommits, resolveRelease, uploadSourceMaps } from '../src';

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'magpie-plugin-'));
    await mkdir(join(dir, 'assets'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

const writeMap = async (name: string, bytes = 100) => {
    const path = join(dir, 'assets', name);
    await writeFile(path, JSON.stringify({ version: 3, file: name.replace(/\.map$/, ''), sources: ['a.ts'], mappings: 'A'.repeat(bytes) }));

    return { name, path };
};

const ok = () => new Response('{}', { status: 200 });
type Call = [string, RequestInit & { body: FormData }];

describe('uploadSourceMaps', () => {
    it('posts the maps as multipart with the version and bearer token', async () => {
        const fetchMock = vi.fn(async () => ok());
        const files = [await writeMap('app-3f2a1.js.map'), await writeMap('vendor-9b8c7.js.map')];

        const result = await uploadSourceMaps({ origin: 'https://magpie.test', project: '12', token: 'mgp_org_secret', version: 'abc123', files, fetch: fetchMock as never });

        const [url, init] = fetchMock.mock.calls[0] as unknown as Call;
        expect(url).toBe('https://magpie.test/api/12/sourcemaps');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({ Authorization: 'Bearer mgp_org_secret' });
        expect(init.body.get('version')).toBe('abc123');
        expect(init.body.getAll('maps[]').map((f) => (f as File).name)).toEqual(['app-3f2a1.js.map', 'vendor-9b8c7.js.map']);
        expect(result.uploaded).toHaveLength(2);
        expect(result.failed).toEqual([]);
    });

    it('splits 120 maps into batches of at most 50 files', async () => {
        const fetchMock = vi.fn(async () => ok());
        const files = await Promise.all(Array.from({ length: 120 }, (_, i) => writeMap(`chunk-${i}.js.map`)));

        const result = await uploadSourceMaps({ origin: 'https://m.test', project: '1', token: 't', version: 'v', files, fetch: fetchMock as never });

        expect(fetchMock.mock.calls.map((c) => (c as unknown as Call)[1].body.getAll('maps[]').length)).toEqual([50, 50, 20]);
        expect(result.uploaded).toHaveLength(120);
    });

    it('keeps each request under the size PHP will accept, and sends an oversized map alone', async () => {
        const fetchMock = vi.fn(async () => ok());
        const files = [await writeMap('a.js.map', 4_000_000), await writeMap('b.js.map', 4_000_000), await writeMap('c.js.map', 7_000_000), await writeMap('d.js.map', 10)];

        await uploadSourceMaps({ origin: 'https://m.test', project: '1', token: 't', version: 'v', files, fetch: fetchMock as never });

        expect(fetchMock.mock.calls.map((c) => (c as unknown as Call)[1].body.getAll('maps[]').map((f) => (f as File).name))).toEqual([['a.js.map'], ['b.js.map'], ['c.js.map'], ['d.js.map']]);
    });

    it('refuses a map over 20 MB without sending it', async () => {
        const fetchMock = vi.fn(async () => ok());
        const big = await writeMap('huge.js.map', 21 * 1024 * 1024);

        const result = await uploadSourceMaps({ origin: 'https://m.test', project: '1', token: 't', version: 'v', files: [big], fetch: fetchMock as never });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.failed[0].reason).toContain('larger than 20 MB');
    });

    it('retries a server error and a dropped connection, but not a rejection', async () => {
        const files = [await writeMap('a.js.map')];

        const flaky = vi.fn().mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(ok());
        const recovered = await uploadSourceMaps({ origin: 'https://m.test', project: '1', token: 't', version: 'v', files, fetch: flaky as never, retryDelayMs: 0 });
        expect(flaky).toHaveBeenCalledTimes(3);
        expect(recovered.uploaded).toHaveLength(1);

        const denied = vi.fn(async () => new Response(JSON.stringify({ error: 'Recording a release needs an organisation token.' }), { status: 401 }));
        const failed = await uploadSourceMaps({ origin: 'https://m.test', project: '1', token: 'wrong', version: 'v', files, fetch: denied as never, retryDelayMs: 0 });
        expect(denied).toHaveBeenCalledTimes(1);
        expect(failed.failed[0].reason).toBe('HTTP 401: Recording a release needs an organisation token.');
    });
});

describe('release resolution', () => {
    it('prefers what you pass, then CI variables, then git', () => {
        const git = vi.fn(() => 'gitsha');

        expect(resolveRelease('explicit', { GITHUB_SHA: 'ci' }, git)).toBe('explicit');
        expect(resolveRelease(undefined, { MAGPIE_RELEASE: 'mine', GITHUB_SHA: 'ci' }, git)).toBe('mine');
        expect(resolveRelease(undefined, { GITHUB_SHA: 'ci' }, git)).toBe('ci');
        expect(resolveRelease(undefined, {}, git)).toBe('gitsha');
        expect(resolveRelease(undefined, {}, () => { throw new Error('not a repo'); })).toBeUndefined();
    });

    it('reads commits newest first and tolerates a message containing the separator', () => {
        const exec = vi.fn(() => ['aaa\u001fAda\u001f2026-10-20T01:02:03+10:00\u001fAdd booking', 'bbb\u001fBo\u001f2026-10-19T01:02:03+10:00\u001ffix: a\u001fb'].join('\n'));

        expect(recentCommits(2, exec)).toEqual([
            { sha: 'aaa', author: 'Ada', timestamp: '2026-10-20T01:02:03+10:00', message: 'Add booking' },
            { sha: 'bbb', author: 'Bo', timestamp: '2026-10-19T01:02:03+10:00', message: 'fix: a\u001fb' },
        ]);
        expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['log', '-n', '2']));
        expect(recentCommits(5, () => { throw new Error('no git'); })).toEqual([]);
    });
});

describe('the plugin', () => {
    const env = { MAGPIE_DSN: 'https://k@magpie.test/12', MAGPIE_AUTH_TOKEN: 'mgp_org_secret', MAGPIE_RELEASE: 'build-1' };
    const exec = () => ['c1\u001fAda\u001f2026-10-20T00:00:00Z\u001fAdd a thing'].join('\n');

    const run = async (options: Parameters<typeof magpie>[0], files: string[]) => {
        const plugin = magpie({ env, exec, ...options });
        const bundle = Object.fromEntries([...files, 'assets/app.js'].map((f) => [f, {}]));
        await (plugin.writeBundle as (this: unknown, o: { dir: string }, b: object) => Promise<void>).call({ environment: { name: 'client' } }, { dir }, bundle);

        return plugin;
    };

    it('builds hidden source maps and puts the release in the bundle and the page', () => {
        const plugin = magpie({ env, exec });
        const config = (plugin.config as (c: object) => { build?: { sourcemap: string }; define?: Record<string, string> })({});
        const tags = (plugin.transformIndexHtml as unknown as () => Array<{ children: string; injectTo: string }>)();

        expect(config.build?.sourcemap).toBe('hidden');
        expect(config.define).toEqual({ 'import.meta.env.VITE_MAGPIE_RELEASE': '"build-1"' });
        expect(tags[0]).toMatchObject({ injectTo: 'head-prepend', children: 'window.__MAGPIE_RELEASE__="build-1";' });
    });

    it('respects a sourcemap setting you chose', () => {
        const config = (magpie({ env, exec }).config as (c: object) => { build?: unknown })({ build: { sourcemap: true } });

        expect(config.build).toBeUndefined();
    });

    it('uploads the maps, records the release with its commits, and removes only what Magpie has', async () => {
        const a = await writeMap('app-1.js.map');
        const b = await writeMap('vendor-1.js.map');
        const fetchMock = vi.fn(async (url: string) => (String(url).endsWith('/sourcemaps') ? ok() : ok()));

        await run({ fetch: fetchMock as never }, ['assets/app-1.js.map', 'assets/vendor-1.js.map']);

        const [mapsCall, releaseCall] = fetchMock.mock.calls as unknown as Call[];
        expect(mapsCall[0]).toBe('https://magpie.test/api/12/sourcemaps');
        expect(releaseCall[0]).toBe('https://magpie.test/api/12/releases');
        expect(JSON.parse(releaseCall[1].body as unknown as string)).toMatchObject({ version: 'build-1', environment: 'production', commits: [{ sha: 'c1', author: 'Ada', message: 'Add a thing' }] });
        expect(existsSync(a.path)).toBe(false);
        expect(existsSync(b.path)).toBe(false);
    });

    it('keeps a map whose upload failed, and does not fail the build by default', async () => {
        const a = await writeMap('app-1.js.map');
        const fetchMock = vi.fn(async () => new Response('', { status: 401 }));

        await expect(run({ fetch: fetchMock as never }, ['assets/app-1.js.map'])).resolves.toBeDefined();

        expect(existsSync(a.path)).toBe(true);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('app-1.js.map was not uploaded: HTTP 401'));
    });

    it('fails the build when asked to', async () => {
        await writeMap('app-1.js.map');
        const fetchMock = vi.fn(async () => new Response('', { status: 401 }));

        await expect(run({ fetch: fetchMock as never, failOnError: true }, ['assets/app-1.js.map'])).rejects.toThrow('was not uploaded');
    });

    it('uploads nothing, and deletes nothing, without a token', async () => {
        const a = await writeMap('app-1.js.map');
        const fetchMock = vi.fn(async () => ok());

        await run({ fetch: fetchMock as never, env: { ...env, MAGPIE_AUTH_TOKEN: undefined } }, ['assets/app-1.js.map']);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(existsSync(a.path)).toBe(true);
    });

    it('leaves the server build alone unless asked', async () => {
        await writeMap('app-1.js.map');
        const fetchMock = vi.fn(async () => ok());
        const plugin = magpie({ env, exec, fetch: fetchMock as never });

        await (plugin.writeBundle as (this: unknown, o: { dir: string }, b: object) => Promise<void>).call({ environment: { name: 'ssr' } }, { dir }, { 'assets/app-1.js.map': {} });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('can skip the deploy record, and never puts the token anywhere but the request header', async () => {
        await writeMap('app-1.js.map');
        const fetchMock = vi.fn(async () => ok());

        await run({ fetch: fetchMock as never, deploy: { enabled: false } }, ['assets/app-1.js.map']);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as Call;
        expect(url).not.toContain('mgp_org_secret');
        expect(JSON.stringify([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '(file)']))).not.toContain('mgp_org_secret');
    });
});
