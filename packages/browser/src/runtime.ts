import { type Runtime, SDK_VERSION } from '@greenhat-services/magpie-core';
import { fetchTransport } from './transport';
import { parseUserAgent } from './uaparse';

export const SDK_NAME = 'magpie.javascript.browser';

/**
 * What a browser tells Magpie about itself: the browser and OS contexts, and the page's URL with the user agent.
 * The referrer is only sent with `sendDefaultPii`, since where someone came from says something about them.
 */
export function browserRuntime(options: { sendDefaultPii?: boolean; sdkName?: string; fetch?: typeof fetch } = {}): Runtime {
    let agent: ReturnType<typeof parseUserAgent> | undefined;
    const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent);
    const parsed = () => (agent ??= parseUserAgent(ua()));

    return {
        sdk: { name: options.sdkName ?? SDK_NAME, version: SDK_VERSION },
        platform: 'javascript',
        // The caller passes the original fetch, taken before it is patched, so delivering an event is never itself traced.
        createTransport: (dsn) => fetchTransport(dsn, options.fetch),

        contexts() {
            const a = parsed();

            return {
                browser: { name: a.browser.name, version: a.browser.version },
                os: { name: a.os.name, ...(a.os.version ? { version: a.os.version } : {}) },
                device: {
                    type: a.device,
                    ...(typeof screen !== 'undefined' ? { screen_resolution: `${screen.width}x${screen.height}` } : {}),
                    ...(typeof navigator !== 'undefined' && navigator.language ? { language: navigator.language } : {}),
                },
            };
        },

        request() {
            if (typeof location === 'undefined') return undefined;

            return {
                url: location.href,
                headers: {
                    'User-Agent': ua(),
                    ...(options.sendDefaultPii && typeof document !== 'undefined' && document.referrer ? { Referer: document.referrer } : {}),
                },
            };
        },
    };
}
