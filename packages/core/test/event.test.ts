import { describe, expect, it } from 'vitest';
import { exceptionValues, FILTERED, normalize, parseDsn, parseTraceHeader, formatTraceHeader, scrubData, scrubQuery, scrubUrl } from '../src';

const mechanism = { type: 'generic', handled: true };

describe('exceptionValues', () => {
    it('lists frames oldest first, the order Magpie reads', () => {
        const error = new Error('boom');
        error.stack = `Error: boom
    at inner (https://app.example.com/a.js:10:1)
    at outer (https://app.example.com/a.js:20:1)`;

        const { values } = exceptionValues(error, { mechanism });

        expect(values[0].stacktrace?.frames.map((f) => f.function)).toEqual(['outer', 'inner']);
        expect(values[0]).toMatchObject({ type: 'Error', value: 'boom', mechanism });
    });

    it('puts the cause chain first, so the last value is what was thrown', () => {
        const root = new TypeError('socket closed');
        const wrapped = new Error('request failed', { cause: root });

        const { values } = exceptionValues(wrapped, { mechanism });

        expect(values.map((v) => v.type)).toEqual(['TypeError', 'Error']);
        expect(values[1].mechanism).toEqual(mechanism);
        expect(values[0].mechanism?.type).toBe('chained');
    });

    it('survives a cause that loops back on itself', () => {
        const a: Error & { cause?: unknown } = new Error('a');
        a.cause = a;

        expect(exceptionValues(a, { mechanism }).values).toHaveLength(1);
    });

    it('uses a subclass name rather than "Error"', () => {
        class PaymentError extends Error {}

        expect(exceptionValues(new PaymentError('declined'), { mechanism }).values[0].type).toBe('PaymentError');
    });

    it('still reports things that are not errors, and says what they were', () => {
        expect(exceptionValues('plain string', { mechanism }).values[0]).toMatchObject({ type: 'Error', value: 'plain string' });
        expect(exceptionValues({ code: 7, detail: 'x' }, { mechanism }).values[0].value).toBe('Non-Error exception captured with keys: code, detail');
        expect(exceptionValues({ message: 'from an object' }, { mechanism }).values[0].value).toBe('from an object');
        expect(exceptionValues(undefined, { mechanism }).values[0].type).toBe('NonErrorException');
    });

    it('keeps the innermost 100 frames when a stack is deeper than that', () => {
        const error = new Error('deep');
        error.stack = `Error: deep\n${Array.from({ length: 150 }, (_, i) => `    at f${i} (https://x.test/a.js:${i + 1}:1)`).join('\n')}`;

        const frames = exceptionValues(error, { mechanism }).values[0].stacktrace!.frames;

        expect(frames).toHaveLength(100);
        expect(frames[frames.length - 1].function).toBe('f0');
    });
});

describe('scrubbing', () => {
    it('filters credentials and sensitive query values in a URL', () => {
        expect(scrubUrl('https://user:pw@app.example.com/cb?page=2&token=abc&api_key=k#top')).toBe('https://app.example.com/cb?page=2&token=%5BFiltered%5D&api_key=%5BFiltered%5D#top');
    });

    it('filters a fragment that looks like OAuth parameters but keeps a plain one', () => {
        expect(scrubUrl('https://app.example.com/cb#access_token=secret&state=1')).toContain('access_token=%5BFiltered%5D');
        expect(scrubUrl('https://app.example.com/docs#install')).toBe('https://app.example.com/docs#install');
    });

    it('works on a path-only URL', () => {
        expect(scrubUrl('/login?password=hunter2&next=%2F')).toBe('/login?password=%5BFiltered%5D&next=%2F');
    });

    it('filters sensitive keys at any depth of a data object', () => {
        expect(scrubData({ ok: 1, nested: { Password: 'x', list: [{ csrf_token: 'y' }] } })).toEqual({ ok: 1, nested: { Password: FILTERED, list: [{ csrf_token: FILTERED }] } });
        expect(scrubQuery('a=1&secret=2')).toBe('a=1&secret=%5BFiltered%5D');
    });
});

describe('normalize', () => {
    it('survives circular references, huge values and things that are not JSON', () => {
        const loop: Record<string, unknown> = { name: 'x' };
        loop.self = loop;

        const out = normalize({ loop, big: 'a'.repeat(5000), fn() {}, n: NaN, d: new Date(0), err: new Error('e'), sym: Symbol('s') }) as Record<string, any>;

        expect(out.loop.self).toBe('[Circular]');
        expect(out.big).toHaveLength(1024);
        expect(out.fn).toBe('[Function fn]');
        expect(out.n).toBe('NaN');
        expect(out.d).toBe('1970-01-01T00:00:00.000Z');
        expect(out.err).toBe('Error: e');
        expect(() => JSON.stringify(out)).not.toThrow();
    });

    it('caps depth and breadth', () => {
        const out = normalize({ a: { b: { c: { d: { e: 1 } } } } }) as any;

        expect(out.a.b.c.d).toBe('[Object]');
        expect(Object.keys(normalize(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))) as object)).toHaveLength(40);
    });
});

describe('DSN and trace header', () => {
    it('parses a DSN and refuses anything else instead of throwing', () => {
        expect(parseDsn('https://abc123@ingest.magpie.example.com/7')).toEqual({ publicKey: 'abc123', host: 'ingest.magpie.example.com', project: '7', protocol: 'https', origin: 'https://ingest.magpie.example.com' });
        expect(parseDsn('http://k@magpie.test:8080/12')?.origin).toBe('http://magpie.test:8080');
        expect(parseDsn('not a dsn')).toBeNull();
        expect(parseDsn('https://host/7')).toBeNull();
        expect(parseDsn('https://k@host/notanumber')).toBeNull();
        expect(parseDsn(undefined)).toBeNull();
    });

    it('reads and writes the magpie-trace header the Laravel SDK uses', () => {
        const header = formatTraceHeader('a'.repeat(32), 'b'.repeat(16), true);

        expect(header).toBe(`${'a'.repeat(32)}-${'b'.repeat(16)}-1`);
        expect(parseTraceHeader(header)).toEqual({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sampled: true });
        expect(parseTraceHeader(`${'a'.repeat(32)}-${'b'.repeat(16)}-0`)?.sampled).toBe(false);
        expect(parseTraceHeader(`${'a'.repeat(32)}-${'b'.repeat(16)}`)?.sampled).toBeUndefined();
        expect(parseTraceHeader('garbage')).toBeNull();
        expect(parseTraceHeader(null)).toBeNull();
    });
});
