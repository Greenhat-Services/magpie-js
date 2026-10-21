import { hostname, platform, release } from 'node:os';
import { type Runtime, SDK_VERSION } from '@greenhat-services/magpie-core';
import { currentStore } from './context';
import { nodeTransport } from './transport';

export const SDK_NAME = 'magpie.javascript.node';

const OS_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', freebsd: 'FreeBSD' };

export function nodeRuntime(options: { sdkName?: string; fetch?: typeof fetch } = {}): Runtime {
    return {
        sdk: { name: options.sdkName ?? SDK_NAME, version: SDK_VERSION },
        platform: 'node',
        createTransport: (dsn) => nodeTransport(dsn, options.fetch),
        contexts: () => ({
            runtime: { name: 'node', version: process.version.replace(/^v/, '') },
            os: { name: OS_NAMES[platform()] ?? platform(), version: release() },
        }),
        // The request being served, when there is one: set by `trackRequest`, read here for every event.
        request: () => currentStore()?.request,
    };
}

export const defaultServerName = (): string | undefined => {
    try {
        return hostname() || undefined;
    } catch {
        return undefined;
    }
};
