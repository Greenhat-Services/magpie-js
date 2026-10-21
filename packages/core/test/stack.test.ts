import { describe, expect, it } from 'vitest';
import { defaultInApp, parseStack } from '../src';

const names = (stack: string) => parseStack(stack).map((f) => `${f.function ?? '?'} ${f.filename}:${f.lineno ?? ''}:${f.colno ?? ''}`);

describe('parseStack', () => {
    it('reads V8 (Chrome, Edge) frames, innermost first', () => {
        const stack = `TypeError: Cannot read properties of null (reading 'venue')
    at SlotPicker.load (https://app.example.com/assets/app-3f2a1.js:1:48213)
    at https://app.example.com/assets/app-3f2a1.js:1:51
    at async Promise.all (index 0)
    at new Foo (https://app.example.com/assets/app-3f2a1.js:2:7)
    at Object.method [as alias] (https://app.example.com/assets/vendor-9b8c7.js:10:20)`;

        expect(names(stack)).toEqual([
            'SlotPicker.load https://app.example.com/assets/app-3f2a1.js:1:48213',
            '? https://app.example.com/assets/app-3f2a1.js:1:51',
            'new Foo https://app.example.com/assets/app-3f2a1.js:2:7',
            'Object.method https://app.example.com/assets/vendor-9b8c7.js:10:20',
        ]);
    });

    it('reads Firefox frames, including the /< suffixes it adds to anonymous functions', () => {
        const stack = `load@https://app.example.com/assets/app-3f2a1.js:1:48213
setup/<@https://app.example.com/assets/app-3f2a1.js:3:9
@https://app.example.com/assets/app-3f2a1.js:5:1`;

        expect(names(stack)).toEqual([
            'load https://app.example.com/assets/app-3f2a1.js:1:48213',
            'setup/< https://app.example.com/assets/app-3f2a1.js:3:9',
            '? https://app.example.com/assets/app-3f2a1.js:5:1',
        ]);
    });

    it('reads Safari frames and skips [native code]', () => {
        const stack = `load@https://app.example.com/assets/app-3f2a1.js:1:48213
forEach@[native code]
global code@https://app.example.com/assets/app-3f2a1.js:9:3`;

        expect(names(stack)).toEqual([
            'load https://app.example.com/assets/app-3f2a1.js:1:48213',
            'global code https://app.example.com/assets/app-3f2a1.js:9:3',
        ]);
    });

    it('keeps a Windows path and a file URL whole, colons and all', () => {
        const stack = `Error: boom
    at run (C:\\Users\\Huy\\app\\server.js:12:5)
    at file:///C:/Users/Huy/app/index.mjs:3:1`;

        expect(names(stack)).toEqual(['run C:\\Users\\Huy\\app\\server.js:12:5', '? file:///C:/Users/Huy/app/index.mjs:3:1']);
    });

    it('keeps a URL with an "@" in it intact', () => {
        const [frame] = parseStack('@https://cdn.example.com/@scope/pkg/index.js:4:2');

        expect(frame.filename).toBe('https://cdn.example.com/@scope/pkg/index.js');
        expect(frame.lineno).toBe(4);
    });

    it('reports where inside an eval the code ran', () => {
        const [frame] = parseStack('    at eval (eval at run (https://x.test/a.js:1:1), <anonymous>:3:4)');

        expect(frame).toMatchObject({ function: 'eval', filename: '<anonymous>', lineno: 3, colno: 4 });
    });

    it('ignores the message line and anything it cannot read', () => {
        expect(parseStack('Error: boom\n    at <anonymous>\nnot a frame at all')).toEqual([{ filename: '<anonymous>', in_app: false }]);
        expect(parseStack(undefined)).toEqual([]);
        expect(parseStack('')).toEqual([]);
    });

    it('marks your own code in_app and dependencies, extensions and native code not', () => {
        expect(defaultInApp('https://app.example.com/assets/app.js')).toBe(true);
        expect(defaultInApp('https://app.example.com/node_modules/vue/dist/vue.js')).toBe(false);
        expect(defaultInApp('chrome-extension://abc/content.js')).toBe(false);
        expect(defaultInApp('native')).toBe(false);
    });

    it('lets the app decide what counts as its own code', () => {
        const frames = parseStack('    at a (https://cdn.example.com/vendor.js:1:1)\n    at b (https://app.example.com/app.js:1:1)', (f) => f.includes('app.example.com'));

        expect(frames.map((f) => f.in_app)).toEqual([false, true]);
    });
});
