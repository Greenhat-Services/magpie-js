import { describe, expect, it } from 'vitest';
import { parseUserAgent } from '../src';

const agent = (ua: string) => {
    const a = parseUserAgent(ua);

    return `${a.browser.name} ${a.browser.version} / ${a.os.name}${a.os.version ? ` ${a.os.version}` : ''} / ${a.device}`;
};

describe('parseUserAgent', () => {
    it.each([
        ['Chrome on Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', 'Chrome 155 / Windows 10 / desktop'],
        ['Edge (which also says Chrome and Safari)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.2535.51', 'Edge 150 / Windows 10 / desktop'],
        ['Opera', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 OPR/120.0.0.0', 'Opera 120 / Windows 10 / desktop'],
        ['Firefox on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox 132 / macOS 10.15 / desktop'],
        ['Safari on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15', 'Safari 17 / macOS 10.15.7 / desktop'],
        ['Safari on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', 'Safari 17 / iOS 17.4 / mobile'],
        ['Chrome on iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1', 'Chrome 155 / iOS 17.4 / mobile'],
        ['Safari on iPad', 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', 'Safari 17 / iOS 17.4 / tablet'],
        ['Chrome on Android phone', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36', 'Chrome 155 / Android 14 / mobile'],
        ['Chrome on an Android tablet', 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36', 'Chrome 150 / Android 13 / tablet'],
        ['Samsung Internet', 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36', 'Samsung Internet 24 / Android 14 / mobile'],
        ['Headless Chrome (Playwright, Puppeteer)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.8078.4 Safari/537.36', 'Chrome 156 / Windows 10 / desktop'],
        ['Chromium on Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Ubuntu Chromium/130.0.0.0 Chrome/130.0.0.0 Safari/537.36', 'Chrome 130 / Linux / desktop'],
        ['Chrome on Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36', 'Chrome 155 / Linux / desktop'],
    ])('%s', (_name, ua, expected) => {
        expect(agent(ua)).toBe(expected);
    });

    it('does not throw on an empty or unknown user agent', () => {
        expect(agent('')).toBe('Unknown  / Unknown / desktop');
        expect(agent('curl/8.4.0')).toBe('Unknown  / Unknown / desktop');
    });
});
