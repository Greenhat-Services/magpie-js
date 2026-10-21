import { readFile, stat } from 'node:fs/promises';
import type { Commit } from './release';

/** Magpie accepts up to 50 maps per request, each up to 20 MB. */
const MAX_FILES = 50;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** PHP's default `post_max_size` is 8 MB, so a request is kept well under it. A map larger than this goes alone. */
const MAX_BATCH_BYTES = 6 * 1024 * 1024;

export interface MapFile {
    /** The name Magpie files it under: the map's own file name (`app-3f2a1.js.map`). */
    name: string;
    path: string;
}

export interface UploadOptions {
    /** `https://host`, no trailing slash. */
    origin: string;
    project: string;
    token: string;
    version: string;
    files: MapFile[];
    fetch?: typeof fetch;
    retries?: number;
    /** Wait between retries, doubled each time. Tests set it to 0. */
    retryDelayMs?: number;
}

export interface UploadResult {
    uploaded: MapFile[];
    failed: Array<{ file: MapFile; reason: string }>;
}

/**
 * Sends source maps to `POST /api/{project}/sourcemaps` in batches that fit Magpie's limits. A batch that fails does
 * not stop the others, and the result says exactly which files made it, so only those are deleted from the build.
 */
export async function uploadSourceMaps(options: UploadOptions): Promise<UploadResult> {
    const result: UploadResult = { uploaded: [], failed: [] };
    const sized: Array<MapFile & { bytes: number }> = [];

    for (const file of options.files) {
        const bytes = (await stat(file.path)).size;
        if (bytes > MAX_FILE_BYTES) result.failed.push({ file, reason: `larger than 20 MB (${(bytes / 1048576).toFixed(1)} MB), which Magpie refuses` });
        else sized.push({ ...file, bytes });
    }

    for (const batch of batches(sized)) {
        const error = await sendBatch(options, batch);
        if (error) for (const file of batch) result.failed.push({ file, reason: error });
        else result.uploaded.push(...batch);
    }

    return result;
}

function batches<T extends { bytes: number }>(files: T[]): T[][] {
    const out: T[][] = [];
    let current: T[] = [];
    let size = 0;

    for (const file of files) {
        if (current.length && (current.length >= MAX_FILES || size + file.bytes > MAX_BATCH_BYTES)) {
            out.push(current);
            current = [];
            size = 0;
        }
        current.push(file);
        size += file.bytes;
    }
    if (current.length) out.push(current);

    return out;
}

/** @returns undefined on success, or the reason it failed. */
async function sendBatch(options: UploadOptions, batch: MapFile[]): Promise<string | undefined> {
    const doFetch = options.fetch ?? fetch;
    const retries = options.retries ?? 2;
    let last = 'unknown error';

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep((options.retryDelayMs ?? 500) * 2 ** (attempt - 1));

        try {
            const form = new FormData();
            form.append('version', options.version);
            for (const file of batch) form.append('maps[]', new Blob([await readFile(file.path)], { type: 'application/json' }), file.name);

            const response = await doFetch(`${options.origin}/api/${options.project}/sourcemaps`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json' },
                body: form,
            });

            if (response.ok) return undefined;

            last = await describeFailure(response);
            // A wrong token, an unknown app or a bad map will not get better by asking again.
            if (response.status < 500) return last;
        } catch (error) {
            last = `could not reach Magpie (${(error as Error).message})`;
        }
    }

    return last;
}

export interface ReleaseRecord {
    origin: string;
    project: string;
    token: string;
    version: string;
    environment: string;
    deployedBy: string;
    commits: Commit[];
    fetch?: typeof fetch;
}

/** Tells Magpie a release was deployed to an environment, with its commits (newest first). @returns undefined on success. */
export async function recordRelease(record: ReleaseRecord): Promise<string | undefined> {
    try {
        const response = await (record.fetch ?? fetch)(`${record.origin}/api/${record.project}/releases`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                version: record.version,
                environment: record.environment,
                deployed_by: record.deployedBy,
                ...(record.commits.length ? { commits: record.commits } : {}),
            }),
        });

        return response.ok ? undefined : await describeFailure(response);
    } catch (error) {
        return `could not reach Magpie (${(error as Error).message})`;
    }
}

async function describeFailure(response: Response): Promise<string> {
    let detail = '';
    try {
        const body = (await response.json()) as { error?: string; message?: string };
        detail = body.error ?? body.message ?? '';
    } catch {
        // Not JSON: the status says enough.
    }

    return `HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
