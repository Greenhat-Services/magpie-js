export interface Agent {
    browser: { name: string; version: string };
    os: { name: string; version?: string };
    device: 'mobile' | 'tablet' | 'desktop';
}

/**
 * The browser, OS and device class from a user-agent string. Versions are the major number: it reads cleanly
 * ("Chrome 155") and is what Magpie's legacy-browser filter compares. The order matters, because Edge, Opera and
 * Samsung Internet all say "Chrome" too, and Chrome says "Safari".
 */
export function parseUserAgent(ua: string): Agent {
    const first = (re: RegExp) => re.exec(ua)?.[1];
    const major = (v: string | undefined) => (v ? v.split('.')[0] : '');

    let browser: Agent['browser'] = { name: 'Unknown', version: '' };
    const rules: Array<[string, RegExp]> = [
        ['Edge', /\bEdgA?i?O?S?\/([\d.]+)/],
        ['Opera', /\bOPR\/([\d.]+)/],
        ['Samsung Internet', /\bSamsungBrowser\/([\d.]+)/],
        ['Firefox', /\b(?:Firefox|FxiOS)\/([\d.]+)/],
        ['Chrome', /\b(?:Headless)?(?:Chrome|Chromium|CriOS)\/([\d.]+)/],
        ['Safari', /\bVersion\/([\d.]+).*\bSafari\//],
    ];
    for (const [name, re] of rules) {
        const v = first(re);
        if (v) {
            browser = { name, version: major(v) };
            break;
        }
    }

    let os: Agent['os'] = { name: 'Unknown' };
    if (/\bWindows NT/.test(ua)) {
        const nt = first(/\bWindows NT ([\d.]+)/);
        os = { name: 'Windows', version: nt === '10.0' ? '10' : nt === '6.3' ? '8.1' : nt === '6.2' ? '8' : nt === '6.1' ? '7' : nt };
    } else if (/\b(iPhone|iPad|iPod)\b/.test(ua)) {
        os = { name: 'iOS', version: first(/\bOS ([\d_]+)/)?.replace(/_/g, '.') };
    } else if (/\bAndroid\b/.test(ua)) {
        os = { name: 'Android', version: first(/\bAndroid ([\d.]+)/) };
    } else if (/\bMac OS X\b/.test(ua)) {
        os = { name: 'macOS', version: first(/\bMac OS X ([\d_.]+)/)?.replace(/_/g, '.') };
    } else if (/\bCrOS\b/.test(ua)) {
        os = { name: 'Chrome OS' };
    } else if (/\bLinux\b/.test(ua)) {
        os = { name: 'Linux' };
    }

    const device: Agent['device'] = /\b(iPad|Tablet)\b/.test(ua) || (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua)) ? 'tablet' : /\b(iPhone|iPod|Mobile)\b/.test(ua) ? 'mobile' : 'desktop';

    return { browser, os, device };
}
