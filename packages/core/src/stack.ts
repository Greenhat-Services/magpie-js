import type { Frame } from './types';

/**
 * Turns an Error's `stack` string into frames, innermost call first (the order browsers list them). The event builder
 * reverses them, because Magpie wants the oldest call first.
 *
 * Two formats cover every engine that matters:
 *   V8 (Chrome, Edge, Node, Deno, Bun):  at fn (https://host/a.js:10:20)  /  at https://host/a.js:10:20
 *   SpiderMonkey and JavaScriptCore (Firefox, Safari):  fn@https://host/a.js:10:20  /  @https://host/a.js:10:20
 */
export function parseStack(stack: string | undefined, inApp: (filename: string) => boolean = defaultInApp): Frame[] {
    if (!stack) return [];

    const frames: Frame[] = [];

    for (const line of stack.split('\n')) {
        const frame = parseV8Line(line) ?? parseGeckoLine(line);
        if (!frame) continue;
        if (frame.filename) frame.in_app = inApp(frame.filename);
        frames.push(frame);
    }

    return frames;
}

/** Not a dependency, not a browser extension, not native code. */
export function defaultInApp(filename: string): boolean {
    return !/node_modules|^(chrome|moz|safari|edge)-extension:|^native$|^<anonymous>$|^\[native code\]$/i.test(filename);
}

function parseV8Line(line: string): Frame | null {
    const m = /^\s*at (.+?)\s*$/.exec(line);
    if (!m) return null;

    let rest = m[1].replace(/^async /, '');
    let fn: string | undefined;
    let location = rest;

    // "fn (location)" : the location is the last parenthesised group, which may itself contain parentheses (eval).
    if (rest.endsWith(')')) {
        const open = matchingOpenParen(rest);
        if (open > 0) {
            fn = rest.slice(0, open).trim();
            location = rest.slice(open + 1, -1);
        }
    }

    rest = location;
    if (rest.startsWith('eval at ')) {
        // "eval at outer (file.js:1:1), <anonymous>:3:4": the code ran in an eval, so report where inside it.
        const tail = rest.slice(rest.lastIndexOf(', ') + 2);
        location = tail || '<anonymous>';
    }

    const parsed = parseLocation(location);
    if (!parsed) return null;

    return clean({ function: cleanFunction(fn), ...parsed });
}

function parseGeckoLine(line: string): Frame | null {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('@')) return null;

    // Function names never contain a slash; URLs often contain an "@" (a scoped package), so split on the first "@"
    // only when what comes before it could be a function name.
    const at = trimmed.indexOf('@');
    const before = trimmed.slice(0, at);
    if (before.includes('/') && !/\/<$|\/[^/]*<$/.test(before)) return null;

    const parsed = parseLocation(trimmed.slice(at + 1));
    if (!parsed || parsed.filename === '[native code]') return null;

    return clean({ function: cleanFunction(before), ...parsed });
}

function parseLocation(location: string): Pick<Frame, 'filename' | 'lineno' | 'colno'> | null {
    const loc = location.trim();
    if (!loc) return null;
    if (loc === 'native' || loc === '<anonymous>' || loc === '[native code]') return { filename: loc };

    const full = /^(.*):(\d+):(\d+)$/.exec(loc);
    if (full) return { filename: full[1], lineno: Number(full[2]), colno: Number(full[3]) };

    const lineOnly = /^(.*):(\d+)$/.exec(loc);
    if (lineOnly) return { filename: lineOnly[1], lineno: Number(lineOnly[2]) };

    // Something like "index 0" in "at async Promise.all (index 0)" is not a location.
    return /^(https?|file|webpack|vite|node|chrome-extension|moz-extension|safari-extension|blob|data):/i.test(loc) || loc.includes('/') || loc.includes('\\')
        ? { filename: loc }
        : null;
}

/** Index of the "(" that matches the final ")" of the string, or -1. */
function matchingOpenParen(s: string): number {
    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
        if (s[i] === ')') depth++;
        else if (s[i] === '(' && --depth === 0) return i;
    }

    return -1;
}

/** `Object.method [as alias]` becomes `Object.method`; a bare "<anonymous>" or "?" says nothing. */
function cleanFunction(fn: string | undefined): string | undefined {
    if (!fn) return undefined;
    const name = fn.replace(/\s+\[as [^\]]+\]$/, '').replace(/^new /, 'new ').trim();

    return name === '' || name === '<anonymous>' || name === '?' || name === 'anonymous' ? undefined : name;
}

function clean(frame: Frame): Frame {
    for (const key of Object.keys(frame) as (keyof Frame)[]) {
        if (frame[key] === undefined) delete frame[key];
    }

    return frame;
}
